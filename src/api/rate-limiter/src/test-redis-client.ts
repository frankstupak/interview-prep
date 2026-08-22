// test-redis-client.ts
// Test double that EXECUTES the real Lua scripts via ioredis-mock (fengari).
//
// The previous MockRedisClient re-implemented all three algorithms in JS and
// never ran the Lua at all — so the scripts that ship to production were
// untested, and the mock silently diverged from real Redis semantics (e.g. it
// pushed duplicate sorted-set members where real ZADD dedupes them, hiding the
// same-millisecond undercount bug). Routing eval through ioredis-mock means
// every Redis-path test in this suite now exercises the actual scripts.
import RedisMock from "ioredis-mock";
import { RateLimitRedisClient } from "./rateLimited-redis";

interface EvalCapableRedis {
  eval(script: string, numkeys: number, ...args: string[]): Promise<unknown>;
  zcard(key: string): Promise<number>;
  pttl(key: string): Promise<number>;
}

// ioredis-mock shares its backing store between instances with identical
// connection options (mimicking two clients on one server). Each test client
// gets a unique fake port so every `new TestRedisClient()` is a fresh, isolated
// "server" — matching the old per-test mock isolation the suite relies on.
let nextIsolationPort = 20000;

export class TestRedisClient implements RateLimitRedisClient {
  private redis = new RedisMock({
    port: ++nextIsolationPort,
    lazyConnect: false,
  }) as unknown as EvalCapableRedis;

  async eval(
    script: string,
    numkeys: number,
    ...args: string[]
  ): Promise<[number, number, number]> {
    return (await this.redis.eval(script, numkeys, ...args)) as [number, number, number];
  }

  /** Sorted-set cardinality — lets tests assert memory bounds under flood. */
  async zcard(key: string): Promise<number> {
    return this.redis.zcard(key);
  }

  /** Key TTL in ms — lets tests assert expiry housekeeping. */
  async pttl(key: string): Promise<number> {
    return this.redis.pttl(key);
  }
}
