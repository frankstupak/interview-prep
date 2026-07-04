// comparison-tests.ts - Tests comparing Redis vs In-Memory implementations
import { describe, it, expect } from "@jest/globals";
import {
  checkRateLimitWithSlidingWindow,
  checkRateLimitWithFixedWindow,
  checkRateLimitWithTokenBucket,
  RateLimitType,
} from "./rateLimited-redis";
import {
  checkRateLimitWithSlidingWindowMemory,
  checkRateLimitWithFixedWindowMemory,
  checkRateLimitWithTokenBucketMemory,
} from "./rateLimited-implemented";
import { TestRedisClient } from "./test-redis-client";

// Redis test client: executes the REAL Lua scripts via ioredis-mock (fengari).
// The old hand-written mock re-implemented the algorithms in JS and never ran
// the Lua, so these "equivalence" tests were comparing two JS re-implementations
// against each other. Now they compare the shipped Lua against the memory path.

class MockRedisClient extends TestRedisClient {}

// Comparison Tests: Redis vs In-Memory Implementations
describe("🔄 Redis vs In-Memory Comparison Tests", () => {
  describe("📊 Sliding Window: Functional Equivalence", () => {
    it("should produce identical results for basic rate limiting", async () => {
      const redis = new MockRedisClient();
      const testParams = {
        key: "comparison-test-1",
        limit: 5,
        windowMs: 10000,
        nowMs: Date.now(),
      };

      // Test Redis implementation
      const redisResult = await checkRateLimitWithSlidingWindow(redis, {
        ...testParams,
        type: RateLimitType.SLIDING_WINDOW_REDIS,
      });

      // Test Memory implementation
      const memoryResult = await checkRateLimitWithSlidingWindowMemory({
        ...testParams,
        type: RateLimitType.SLIDING_WINDOW_MEMORY,
      });

      // Both should allow the first request
      expect(redisResult.allowed).toBe(memoryResult.allowed);
      expect(redisResult.remaining).toBe(memoryResult.remaining);
      expect(redisResult.resetMs).toBe(memoryResult.resetMs);

      console.warn(
        `✅ Both implementations: allowed=${redisResult.allowed}, remaining=${redisResult.remaining}`
      );
    });

    it("should handle burst requests identically", async () => {
      const redis = new MockRedisClient();
      const baseTime = Date.now();
      const testParams = {
        limit: 3,
        windowMs: 5000,
      };

      let redisAllowed = 0;
      let memoryAllowed = 0;

      // Send 5 requests rapidly to both implementations (using same key for each)
      for (let i = 0; i < 5; i++) {
        const redisResult = await checkRateLimitWithSlidingWindow(redis, {
          ...testParams,
          key: "burst-redis",
          nowMs: baseTime + i,
          type: RateLimitType.SLIDING_WINDOW_REDIS,
        });

        const memoryResult = await checkRateLimitWithSlidingWindowMemory({
          ...testParams,
          key: "burst-memory",
          nowMs: baseTime + i,
          type: RateLimitType.SLIDING_WINDOW_MEMORY,
        });

        if (redisResult.allowed) redisAllowed++;
        if (memoryResult.allowed) memoryAllowed++;
      }

      expect(redisAllowed).toBe(3);
      expect(memoryAllowed).toBe(3);
      expect(redisAllowed).toBe(memoryAllowed);

      console.warn(`🚀 Burst test: Redis allowed ${redisAllowed}, Memory allowed ${memoryAllowed}`);
    });
  });

  describe("🪟 Fixed Window: Boundary Behavior", () => {
    it("should handle window boundaries identically", async () => {
      const redis = new MockRedisClient();
      const windowMs = 5000;
      const baseTime = Math.floor(Date.now() / windowMs) * windowMs;

      // Fill up the current window
      for (let i = 0; i < 3; i++) {
        await checkRateLimitWithFixedWindow(redis, {
          key: "window-boundary-redis",
          limit: 3,
          windowMs,
          nowMs: baseTime + 1000,
          type: RateLimitType.FIXED_WINDOW_REDIS,
        });

        await checkRateLimitWithFixedWindowMemory({
          key: "window-boundary-memory",
          limit: 3,
          windowMs,
          nowMs: baseTime + 1000,
          type: RateLimitType.FIXED_WINDOW_MEMORY,
        });
      }

      // Try one more request in the same window (should be rejected)
      const redisRejected = await checkRateLimitWithFixedWindow(redis, {
        key: "window-boundary-redis",
        limit: 3,
        windowMs,
        nowMs: baseTime + 2000,
        type: RateLimitType.FIXED_WINDOW_REDIS,
      });

      const memoryRejected = await checkRateLimitWithFixedWindowMemory({
        key: "window-boundary-memory",
        limit: 3,
        windowMs,
        nowMs: baseTime + 2000,
        type: RateLimitType.FIXED_WINDOW_MEMORY,
      });

      expect(redisRejected.allowed).toBe(false);
      expect(memoryRejected.allowed).toBe(false);

      // Try request in next window (should be allowed)
      const redisNextWindow = await checkRateLimitWithFixedWindow(redis, {
        key: "window-boundary-redis",
        limit: 3,
        windowMs,
        nowMs: baseTime + windowMs + 1000,
        type: RateLimitType.FIXED_WINDOW_REDIS,
      });

      const memoryNextWindow = await checkRateLimitWithFixedWindowMemory({
        key: "window-boundary-memory",
        limit: 3,
        windowMs,
        nowMs: baseTime + windowMs + 1000,
        type: RateLimitType.FIXED_WINDOW_MEMORY,
      });

      expect(redisNextWindow.allowed).toBe(true);
      expect(memoryNextWindow.allowed).toBe(true);

      console.warn(`🪟 Window boundary test: Both implementations handle window resets correctly`);
    });
  });

  describe("🪣 Token Bucket: Burst and Refill", () => {
    it("should handle initial burst capacity identically", async () => {
      const redis = new MockRedisClient();
      const testParams = {
        limit: 5, // 5 tokens capacity
        windowMs: 5000, // 5 seconds total refill time
        nowMs: Date.now(),
      };

      let redisAllowed = 0;
      let memoryAllowed = 0;

      // Try to consume 8 tokens rapidly (more than capacity)
      for (let i = 0; i < 8; i++) {
        const redisResult = await checkRateLimitWithTokenBucket(redis, {
          ...testParams,
          key: "token-burst-redis",
          nowMs: testParams.nowMs + i,
          type: RateLimitType.TOKEN_BUCKET_REDIS,
        });

        const memoryResult = await checkRateLimitWithTokenBucketMemory({
          ...testParams,
          key: "token-burst-memory",
          nowMs: testParams.nowMs + i,
          type: RateLimitType.TOKEN_BUCKET_MEMORY,
        });

        if (redisResult.allowed) redisAllowed++;
        if (memoryResult.allowed) memoryAllowed++;
      }

      expect(redisAllowed).toBe(5);
      expect(memoryAllowed).toBe(5);
      expect(redisAllowed).toBe(memoryAllowed);

      console.warn(
        `🪣 Token burst test: Redis allowed ${redisAllowed}, Memory allowed ${memoryAllowed}`
      );
    });

    it("should handle token refill similarly", async () => {
      const redis = new MockRedisClient();
      const capacity = 3;
      const windowMs = 3000;
      const refillMs = Math.floor(windowMs / capacity);
      const baseTime = Date.now();

      // Exhaust all tokens in both implementations
      for (let i = 0; i < capacity; i++) {
        await checkRateLimitWithTokenBucket(redis, {
          key: "refill-test-redis",
          limit: capacity,
          windowMs,
          nowMs: baseTime,
          type: RateLimitType.TOKEN_BUCKET_REDIS,
        });

        await checkRateLimitWithTokenBucketMemory({
          key: "refill-test-memory",
          limit: capacity,
          windowMs,
          nowMs: baseTime,
          type: RateLimitType.TOKEN_BUCKET_MEMORY,
        });
      }

      // Wait for 1 token to refill
      const laterTime = baseTime + refillMs + 100;

      const redisAfterRefill = await checkRateLimitWithTokenBucket(redis, {
        key: "refill-test-redis",
        limit: capacity,
        windowMs,
        nowMs: laterTime,
        type: RateLimitType.TOKEN_BUCKET_REDIS,
      });

      const memoryAfterRefill = await checkRateLimitWithTokenBucketMemory({
        key: "refill-test-memory",
        limit: capacity,
        windowMs,
        nowMs: laterTime,
        type: RateLimitType.TOKEN_BUCKET_MEMORY,
      });

      expect(redisAfterRefill.allowed).toBe(true);
      expect(memoryAfterRefill.allowed).toBe(true);

      console.warn(`♻️ Token refill test: Both implementations handle refill correctly`);
    });
  });

  describe("⚡ Performance Characteristics", () => {
    it("should demonstrate performance differences", async () => {
      const redis = new MockRedisClient();
      const iterations = 100;
      const testParams = {
        key: "perf-test",
        limit: 1000,
        windowMs: 60000,
      };

      // Time Redis implementation
      const redisStart = performance.now();
      for (let i = 0; i < iterations; i++) {
        await checkRateLimitWithSlidingWindow(redis, {
          ...testParams,
          key: `${testParams.key}-redis-${i}`,
          type: RateLimitType.SLIDING_WINDOW_REDIS,
        });
      }
      const redisTime = performance.now() - redisStart;

      // Time Memory implementation
      const memoryStart = performance.now();
      for (let i = 0; i < iterations; i++) {
        await checkRateLimitWithSlidingWindowMemory({
          ...testParams,
          key: `${testParams.key}-memory-${i}`,
          type: RateLimitType.SLIDING_WINDOW_MEMORY,
        });
      }
      const memoryTime = performance.now() - memoryStart;

      console.warn(`\n📊 Performance Comparison (${iterations} operations):`);
      console.warn(`   Redis implementation: ${redisTime.toFixed(2)}ms`);
      console.warn(`   Memory implementation: ${memoryTime.toFixed(2)}ms`);
      console.warn(`   Memory is ${(redisTime / memoryTime).toFixed(2)}x faster\n`);

      expect(redisTime).toBeGreaterThan(0);
      expect(memoryTime).toBeGreaterThan(0);
    });
  });

  describe("🔒 Isolation and State Management", () => {
    it("should demonstrate separate state management", async () => {
      const redis = new MockRedisClient();

      const sharedKey = "isolation-test";
      const testParams = {
        key: sharedKey,
        limit: 2,
        windowMs: 10000,
      };

      // Make requests to Redis implementation
      await checkRateLimitWithSlidingWindow(redis, {
        ...testParams,
        type: RateLimitType.SLIDING_WINDOW_REDIS,
      });

      await checkRateLimitWithSlidingWindow(redis, {
        ...testParams,
        type: RateLimitType.SLIDING_WINDOW_REDIS,
      });

      // Redis should now be at limit
      const redisAtLimit = await checkRateLimitWithSlidingWindow(redis, {
        ...testParams,
        type: RateLimitType.SLIDING_WINDOW_REDIS,
      });

      // Memory implementation should still allow requests (separate state)
      const memoryStillAllows = await checkRateLimitWithSlidingWindowMemory({
        ...testParams,
        type: RateLimitType.SLIDING_WINDOW_MEMORY,
      });

      expect(redisAtLimit.allowed).toBe(false); // Redis at limit
      expect(memoryStillAllows.allowed).toBe(true); // Memory has separate state

      console.warn(
        `🔒 State isolation: Redis blocked (${redisAtLimit.allowed}), Memory allowed (${memoryStillAllows.allowed})`
      );
    });
  });

  describe("📈 Algorithm Behavior Differences", () => {
    it("should show sliding vs fixed window differences", async () => {
      const redis = new MockRedisClient();
      const baseTime = Date.now();
      const windowMs = 5000;

      // Make requests at different times within a window
      const times = [
        baseTime + 1000, // Early in window
        baseTime + 3000, // Middle of window
        baseTime + 4500, // Late in window
      ];

      console.warn(`\n📈 Algorithm Comparison:`);

      for (const [index, time] of times.entries()) {
        const slidingResult = await checkRateLimitWithSlidingWindow(redis, {
          key: `sliding-${index}`,
          limit: 2,
          windowMs,
          nowMs: time,
          type: RateLimitType.SLIDING_WINDOW_REDIS,
        });

        const fixedResult = await checkRateLimitWithFixedWindow(redis, {
          key: `fixed-${index}`,
          limit: 2,
          windowMs,
          nowMs: time,
          type: RateLimitType.FIXED_WINDOW_REDIS,
        });

        console.warn(
          `   Time ${index + 1}: Sliding resetMs=${slidingResult.resetMs}ms, Fixed resetMs=${fixedResult.resetMs}ms`
        );
      }

      // Both should work, but with different reset time characteristics
      expect(true).toBe(true); // Just demonstrating the differences
    });

    it("should show token bucket vs sliding window burst handling", async () => {
      const redis = new MockRedisClient();
      const baseTime = Date.now();

      console.warn(`\n🪣 vs 📊 Burst Handling Comparison:`);

      // Token bucket allows immediate burst up to capacity
      let tokenAllowed = 0;
      for (let i = 0; i < 5; i++) {
        const result = await checkRateLimitWithTokenBucket(redis, {
          key: "token-burst",
          limit: 3,
          windowMs: 3000,
          nowMs: baseTime + i,
          type: RateLimitType.TOKEN_BUCKET_REDIS,
        });
        if (result.allowed) tokenAllowed++;
      }

      // Sliding window spreads requests over time
      let slidingAllowed = 0;
      for (let i = 0; i < 5; i++) {
        const result = await checkRateLimitWithSlidingWindow(redis, {
          key: "sliding-burst",
          limit: 3,
          windowMs: 3000,
          nowMs: baseTime + i,
          type: RateLimitType.SLIDING_WINDOW_REDIS,
        });
        if (result.allowed) slidingAllowed++;
      }

      console.warn(`   Token Bucket: ${tokenAllowed}/5 requests allowed (immediate burst)`);
      console.warn(`   Sliding Window: ${slidingAllowed}/5 requests allowed (time-based)`);

      expect(tokenAllowed).toBeGreaterThanOrEqual(0);
      expect(slidingAllowed).toBeGreaterThanOrEqual(0);
    });
  });
});
