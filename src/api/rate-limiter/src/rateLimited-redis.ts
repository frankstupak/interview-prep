// rateLimiter-redis.ts

// Redis client interface for rate limiting operations
export interface RateLimitRedisClient {
  eval(script: string, numkeys: number, ...args: string[]): Promise<[number, number, number]>;
}

export interface LimitOpts {
  key: string; // per-client key (e.g., API key or IP)
  limit: number; // e.g., 100
  windowMs: number; // e.g., 60_000
  nowMs?: number; // for tests
  type: RateLimitType; // sliding window or fixed window
}

export interface LimitResult {
  allowed: boolean;
  remaining: number; // how many left in window
  resetMs: number; // ms until window fully clears
}
export enum RateLimitType {
  // Redis-based implementations using Lua scripts (limit=10, windowMs=1000 => 10 req/1000ms)
  SLIDING_WINDOW_REDIS = "sliding-window-redis",
  FIXED_WINDOW_REDIS = "fixed-window-redis",
  TOKEN_BUCKET_REDIS = "token-bucket-redis",

  // In-memory implementations (no Redis required)
  SLIDING_WINDOW_MEMORY = "sliding-window-memory",
  FIXED_WINDOW_MEMORY = "fixed-window-memory",
  TOKEN_BUCKET_MEMORY = "token-bucket-memory",
}

// Sliding window: sorted set for rolling window. Accurate; more work per request than fixed window.
//
// Two hardening fixes vs the naive version:
// 1. Reject-before-add: denied hits are NOT written to the set. This bounds the
//    set at `limit` members per key (flood-proof memory) and means a client that
//    backs off recovers as soon as its *allowed* hits age out, instead of being
//    locked out by its own rejected traffic.
// 2. Unique member (ARGV[4]): ZADD with member = tostring(now) silently dedupes
//    two hits in the same millisecond (sorted-set members are unique), which
//    undercounts and over-admits under burst. The caller supplies a per-request
//    unique member instead.
const SLIDING_WINDOW_LUA = `
-- KEYS[1] = key      ARGV[1]=now  ARGV[2]=winMs  ARGV[3]=limit  ARGV[4]=unique member
local k      = KEYS[1]
local now    = tonumber(ARGV[1])
local win    = tonumber(ARGV[2])
local lim    = tonumber(ARGV[3])
local member = ARGV[4]
local start  = now - win

redis.call('ZREMRANGEBYSCORE', k, 0, start)            -- prune old hits
local count = tonumber(redis.call('ZCARD', k))         -- hits currently in window

if count >= lim then
  -- Denied: do NOT record the hit (bounded memory, no self-lockout).
  local oldestPair = redis.call('ZRANGE', k, 0, 0, 'WITHSCORES')
  local oldest = (oldestPair and #oldestPair >= 2) and tonumber(oldestPair[2]) or now
  return { 0, 0, math.max(0, oldest + win - now) }
end

redis.call('ZADD', k, now, member)                     -- record allowed hit
redis.call('PEXPIRE', k, win)                          -- housekeeping TTL

local oldestPair = redis.call('ZRANGE', k, 0, 0, 'WITHSCORES')
local oldest = (oldestPair and #oldestPair >= 2) and tonumber(oldestPair[2]) or now
local resetMs = math.max(0, oldest + win - now)

return { 1, lim - (count + 1), resetMs }
`;

// Fixed window: counter per calendar window. Simple and fast; allows 2× burst at window boundaries.
const FIXED_WINDOW_LUA = `
-- KEYS[1] = key      ARGV[1]=now  ARGV[2]=winMs  ARGV[3]=limit
local k   = KEYS[1]
local now = tonumber(ARGV[1])
local win = tonumber(ARGV[2])
local lim = tonumber(ARGV[3])

-- Calculate current window start time.
-- Written as float modulo (not math.floor(now/win)*win): math.floor coerces to
-- Lua integers, which overflow on millisecond epochs under 32-bit Lua builds
-- (e.g. fengari, used by ioredis-mock in tests). Real Redis Lua 5.1 doubles
-- are fine either way; this form is correct on both.
local windowStart = now - (now % win)
local windowEnd = windowStart + win
-- %.0f pins the key suffix to a plain integer string on every Lua build
-- (5.1 doubles, 5.3 floats, fengari) — bare concatenation of a float is
-- formatted differently across versions.
local windowKey = k .. ':' .. string.format('%.0f', windowStart)

-- Atomic increment (single command instead of GET+SET round trip)
local count = tonumber(redis.call('INCR', windowKey))

-- Set the TTL once, on window creation, expiring AT the window end.
-- (Re-arming PEXPIRE(win) on every hit kept dead window keys alive for up to
-- a full extra window after their last hit.)
if count == 1 then
  redis.call('PEXPIRE', windowKey, string.format('%.0f', math.max(1, windowEnd - now)))
end

-- Calculate reset time (time until current window ends)
local resetMs = windowEnd - now

local allowed = (count <= lim) and 1 or 0
local remaining = math.max(0, lim - count)
return { allowed, remaining, resetMs }
`;

// Token bucket: tokens refill over time. Smooth bursts, tunable; slightly more state than window counters.
const TOKEN_BUCKET_LUA = `
-- KEYS[1] = key      ARGV[1]=now  ARGV[2]=refillMs  ARGV[3]=capacity
local k   = KEYS[1]
local now = tonumber(ARGV[1])
local refillMs = tonumber(ARGV[2])  -- time to refill one token
local capacity = tonumber(ARGV[3])  -- max tokens (burst capacity)

-- Get current bucket state
local bucketData = redis.call('HMGET', k, 'tokens', 'lastRefill')
local tokens = tonumber(bucketData[1]) or capacity
local lastRefill = tonumber(bucketData[2]) or now

-- Calculate tokens to add based on time elapsed
local timePassed = now - lastRefill
if timePassed > 0 then
  local tokensToAdd = math.floor(timePassed / refillMs)
  if tokensToAdd > 0 then
    tokens = tokens + tokensToAdd
    if tokens >= capacity then
      -- Bucket is full: restart the refill clock at now so a later request
      -- doesn't inherit a stale lastRefill.
      tokens = capacity
      lastRefill = now
    else
      -- Preserve the fractional-token remainder by advancing lastRefill in
      -- whole-token steps only.
      lastRefill = lastRefill + (tokensToAdd * refillMs)
    end
  end
end

-- Try to consume one token
local allowed = 0
local remaining = tokens
if tokens > 0 then
  allowed = 1
  tokens = tokens - 1
  remaining = tokens
end

-- Update bucket state
-- %.0f keeps the stored numbers as plain integer strings on every Lua build
redis.call('HMSET', k, 'tokens', string.format('%.0f', tokens), 'lastRefill', string.format('%.0f', lastRefill))
redis.call('PEXPIRE', k, refillMs * capacity * 2) -- TTL for cleanup

-- Time until the NEXT token lands, credited for time already elapsed since
-- lastRefill. (Returning the full refillMs overstated Retry-After by up to
-- one whole refill period.)
local resetMs = 0
if tokens == 0 then
  resetMs = math.max(0, refillMs - (now - lastRefill))
end

return { allowed, remaining, resetMs }
`;

// Monotonic per-process sequence for sliding-window member uniqueness. Combined
// with a random suffix so members are unique across processes sharing one Redis.
let slidingWindowSeq = 0;

/** Unique sorted-set member for one hit: `<now>-<seq>-<rand>`. */
function uniqueSlidingWindowMember(now: number): string {
  slidingWindowSeq = (slidingWindowSeq + 1) % Number.MAX_SAFE_INTEGER;
  return `${now}-${slidingWindowSeq}-${Math.random().toString(36).slice(2, 10)}`;
}

export async function checkRateLimitWithSlidingWindow(
  redis: RateLimitRedisClient,
  { key, limit, windowMs, nowMs, type }: LimitOpts & { type: RateLimitType.SLIDING_WINDOW_REDIS }
): Promise<LimitResult> {
  if (type !== RateLimitType.SLIDING_WINDOW_REDIS) {
    throw new Error("Invalid type");
  }

  const now = nowMs ?? Date.now();
  const redisKey = `rl:${key}:sliding`;

  const [allowed, remaining, resetMs] = (await redis.eval(
    SLIDING_WINDOW_LUA,
    1,
    redisKey,
    String(now),
    String(windowMs),
    String(limit),
    uniqueSlidingWindowMember(now)
  )) as [number, number, number];

  return { allowed: !!allowed, remaining, resetMs };
}

export async function checkRateLimitWithFixedWindow(
  redis: RateLimitRedisClient,
  { key, limit, windowMs, nowMs, type }: LimitOpts & { type: RateLimitType.FIXED_WINDOW_REDIS }
): Promise<LimitResult> {
  if (type !== RateLimitType.FIXED_WINDOW_REDIS) {
    throw new Error("Invalid type");
  }

  const now = nowMs ?? Date.now();
  const redisKey = `rl:${key}:fixed`;

  const [allowed, remaining, resetMs] = (await redis.eval(
    FIXED_WINDOW_LUA,
    1,
    redisKey,
    String(now),
    String(windowMs),
    String(limit)
  )) as [number, number, number];

  return { allowed: !!allowed, remaining, resetMs };
}

export async function checkRateLimitWithTokenBucket(
  redis: RateLimitRedisClient,
  { key, limit, windowMs, nowMs, type }: LimitOpts & { type: RateLimitType.TOKEN_BUCKET_REDIS }
): Promise<LimitResult> {
  if (type !== RateLimitType.TOKEN_BUCKET_REDIS) {
    throw new Error("Invalid type");
  }

  const now = nowMs ?? Date.now();
  const redisKey = `rl:${key}:token-bucket`;

  // For token bucket: limit = capacity, windowMs = refill time per token
  // Example: limit=10, windowMs=1000 means 10 tokens max, 1 token per second
  const capacity = limit;
  const refillMs = Math.max(1, Math.floor(windowMs / limit)); // Time to refill one token

  const [allowed, remaining, resetMs] = (await redis.eval(
    TOKEN_BUCKET_LUA,
    1,
    redisKey,
    String(now),
    String(refillMs),
    String(capacity)
  )) as [number, number, number];

  return { allowed: !!allowed, remaining, resetMs };
}

export async function checkRateLimitByType(
  redis: RateLimitRedisClient,
  { key, limit, windowMs, nowMs, type }: LimitOpts
): Promise<LimitResult> {
  switch (type) {
    case RateLimitType.SLIDING_WINDOW_REDIS:
      return checkRateLimitWithSlidingWindow(redis, { key, limit, windowMs, nowMs, type });
    case RateLimitType.FIXED_WINDOW_REDIS:
      return checkRateLimitWithFixedWindow(redis, { key, limit, windowMs, nowMs, type });
    case RateLimitType.TOKEN_BUCKET_REDIS:
      return checkRateLimitWithTokenBucket(redis, { key, limit, windowMs, nowMs, type });
  }
  throw new Error("Invalid Redis rate limit type");
}
