// rateLimited-implemented.ts
// In-memory rate limiter implementations without Redis dependency

import { LimitOpts, LimitResult, RateLimitType } from "./rateLimited-redis";

// In-memory storage for rate limiting data

// Sliding-window log with an advancing head index. Timestamps append at the
// tail; expired entries are logically removed by advancing `head` (amortized
// O(1) per hit at steady state) instead of re-allocating the array with
// `filter` on every request. The buffer is compacted once the dead prefix
// outgrows the live tail. `sorted` tracks whether appends have stayed
// monotonic; if a caller ever passes a decreasing nowMs we fall back to a full
// filter on prune (the old behavior) so correctness never depends on the clock.
interface SlidingWindowLog {
  buf: number[];
  head: number;
  sorted: boolean;
}

class RateLimiterStorage {
  // Sliding window: Map<key, SlidingWindowLog>
  private slidingWindowData = new Map<string, SlidingWindowLog>();

  // Fixed window: Map<key, {count: number, windowStart: number}>
  private fixedWindowData = new Map<string, { count: number; windowStart: number }>();

  // Token bucket: Map<key, {tokens: number, lastRefill: number}>
  private tokenBucketData = new Map<string, { tokens: number; lastRefill: number }>();

  // Sliding Window Implementation
  //
  // Mirrors the Redis Lua script exactly (comparison tests assert equivalence):
  // - Reject-before-add: denied hits are not recorded, which bounds the per-key
  //   array at `limit` entries under flood and means a client that backs off
  //   recovers as soon as its allowed hits age out (no self-lockout).
  // - Lazy prune: the old code ran `filter` + reallocated the array on EVERY
  //   request (O(n) alloc+copy per hit, with n unbounded under flood). We now
  //   prune only when the oldest entry has actually expired.
  checkSlidingWindow(key: string, limit: number, windowMs: number, now: number): LimitResult {
    const start = now - windowMs;

    let log = this.slidingWindowData.get(key);
    if (!log) {
      log = { buf: [], head: 0, sorted: true };
      this.slidingWindowData.set(key, log);
    }

    // Prune expired entries.
    if (log.sorted) {
      // Monotonic appends: expired entries form a prefix — advance head, O(1)
      // amortized. Compact once the dead prefix dominates the buffer.
      while (log.head < log.buf.length && log.buf[log.head] <= start) {
        log.head++;
      }
      if (log.head > 1024 && log.head * 2 > log.buf.length) {
        log.buf = log.buf.slice(log.head);
        log.head = 0;
      }
    } else if (log.buf.length > log.head && log.buf[log.head] <= start) {
      // Non-monotonic history: fall back to a full filter (old behavior).
      log.buf = log.buf.filter((timestamp) => timestamp > start);
      log.head = 0;
    }

    const count = log.buf.length - log.head;

    if (count >= limit) {
      // Denied: do NOT record the hit (bounded memory, no self-lockout).
      const oldest = count > 0 ? log.buf[log.head] : now;
      return { allowed: false, remaining: 0, resetMs: Math.max(0, oldest + windowMs - now) };
    }

    // Allowed: record the hit.
    if (log.buf.length > log.head && now < log.buf[log.buf.length - 1]) {
      log.sorted = false;
    }
    log.buf.push(now);

    const oldest = log.buf[log.head];
    return {
      allowed: true,
      remaining: limit - (count + 1),
      resetMs: Math.max(0, oldest + windowMs - now),
    };
  }

  // Fixed Window Implementation
  checkFixedWindow(key: string, limit: number, windowMs: number, now: number): LimitResult {
    // Calculate current window boundaries
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const windowEnd = windowStart + windowMs;

    // Get or create counter for this window
    let counter = this.fixedWindowData.get(key);

    // Reset counter if we're in a new window
    if (!counter || counter.windowStart !== windowStart) {
      counter = { count: 0, windowStart };
    }

    // Increment counter for this request
    counter.count++;

    // Update storage
    this.fixedWindowData.set(key, counter);

    const allowed = counter.count <= limit;
    const remaining = Math.max(0, limit - counter.count);
    const resetMs = windowEnd - now;

    return { allowed, remaining, resetMs };
  }

  // Token Bucket Implementation
  checkTokenBucket(key: string, capacity: number, refillMs: number, now: number): LimitResult {
    // Get or create bucket
    let bucket = this.tokenBucketData.get(key);

    if (!bucket) {
      // New bucket starts full
      bucket = { tokens: capacity, lastRefill: now };
    }

    // Calculate tokens to add based on elapsed time
    // (mirrors the Redis Lua script exactly — comparison tests assert equivalence)
    const timePassed = now - bucket.lastRefill;
    if (timePassed > 0) {
      const tokensToAdd = Math.floor(timePassed / refillMs);
      if (tokensToAdd > 0) {
        bucket.tokens += tokensToAdd;
        if (bucket.tokens >= capacity) {
          // Bucket is full: restart the refill clock at now so a later request
          // doesn't inherit a stale lastRefill.
          bucket.tokens = capacity;
          bucket.lastRefill = now;
        } else {
          // Preserve the fractional-token remainder by advancing lastRefill in
          // whole-token steps only.
          bucket.lastRefill = bucket.lastRefill + tokensToAdd * refillMs;
        }
      }
    }

    // Try to consume one token
    let allowed = false;
    let remaining = bucket.tokens;

    if (bucket.tokens > 0) {
      allowed = true;
      bucket.tokens--;
      remaining = bucket.tokens;
    }

    // Update storage
    this.tokenBucketData.set(key, bucket);

    // Time until the NEXT token lands, credited for time already elapsed since
    // lastRefill. (Returning the full refillMs overstated Retry-After by up to
    // one whole refill period.)
    const resetMs = bucket.tokens === 0 ? Math.max(0, refillMs - (now - bucket.lastRefill)) : 0;

    return { allowed, remaining, resetMs };
  }

  // Cleanup method to remove old data (optional, for memory management)
  cleanup(maxAge: number = 3600000): void {
    // Default 1 hour
    const now = Date.now();
    const cutoff = now - maxAge;

    // Clean sliding window data
    for (const [key, log] of this.slidingWindowData.entries()) {
      const live = log.buf.slice(log.head).filter((timestamp) => timestamp > cutoff);
      if (live.length === 0) {
        this.slidingWindowData.delete(key);
      } else {
        this.slidingWindowData.set(key, { buf: live, head: 0, sorted: log.sorted });
      }
    }

    // Clean fixed window data (remove old windows)
    for (const [key, counter] of this.fixedWindowData.entries()) {
      if (counter.windowStart < cutoff) {
        this.fixedWindowData.delete(key);
      }
    }

    // Clean token bucket data (remove inactive buckets)
    for (const [key, bucket] of this.tokenBucketData.entries()) {
      if (bucket.lastRefill < cutoff) {
        this.tokenBucketData.delete(key);
      }
    }
  }

  // Clear all data (useful for testing)
  clear(): void {
    this.slidingWindowData.clear();
    this.fixedWindowData.clear();
    this.tokenBucketData.clear();
  }
}

// Global storage instance (in production, you might want dependency injection)
const storage = new RateLimiterStorage();

// Export function to clear storage (useful for testing)
export function clearMemoryStorage(): void {
  storage.clear();
}

// Sliding Window Memory Implementation
export async function checkRateLimitWithSlidingWindowMemory({
  key,
  limit,
  windowMs,
  nowMs,
  type,
}: LimitOpts & { type: RateLimitType.SLIDING_WINDOW_MEMORY }): Promise<LimitResult> {
  if (type !== RateLimitType.SLIDING_WINDOW_MEMORY) {
    throw new Error("Invalid type");
  }

  const now = nowMs ?? Date.now();
  return storage.checkSlidingWindow(key, limit, windowMs, now);
}

// Fixed Window Memory Implementation
export async function checkRateLimitWithFixedWindowMemory({
  key,
  limit,
  windowMs,
  nowMs,
  type,
}: LimitOpts & { type: RateLimitType.FIXED_WINDOW_MEMORY }): Promise<LimitResult> {
  if (type !== RateLimitType.FIXED_WINDOW_MEMORY) {
    throw new Error("Invalid type");
  }

  const now = nowMs ?? Date.now();
  return storage.checkFixedWindow(key, limit, windowMs, now);
}

// Token Bucket Memory Implementation
export async function checkRateLimitWithTokenBucketMemory({
  key,
  limit,
  windowMs,
  nowMs,
  type,
}: LimitOpts & { type: RateLimitType.TOKEN_BUCKET_MEMORY }): Promise<LimitResult> {
  if (type !== RateLimitType.TOKEN_BUCKET_MEMORY) {
    throw new Error("Invalid type");
  }

  const now = nowMs ?? Date.now();

  // For token bucket: limit = capacity, windowMs = total refill time
  const capacity = limit;
  const refillMs = Math.max(1, Math.floor(windowMs / limit)); // Time per token

  return storage.checkTokenBucket(key, capacity, refillMs, now);
}

// Unified function for memory-based rate limiting
export async function checkRateLimitByTypeMemory({
  key,
  limit,
  windowMs,
  nowMs,
  type,
}: LimitOpts): Promise<LimitResult> {
  switch (type) {
    case RateLimitType.SLIDING_WINDOW_MEMORY:
      return checkRateLimitWithSlidingWindowMemory({ key, limit, windowMs, nowMs, type });
    case RateLimitType.FIXED_WINDOW_MEMORY:
      return checkRateLimitWithFixedWindowMemory({ key, limit, windowMs, nowMs, type });
    case RateLimitType.TOKEN_BUCKET_MEMORY:
      return checkRateLimitWithTokenBucketMemory({ key, limit, windowMs, nowMs, type });
  }
  throw new Error("Invalid memory rate limit type");
}

// Export storage for testing or advanced usage
export { storage as rateLimiterStorage };
