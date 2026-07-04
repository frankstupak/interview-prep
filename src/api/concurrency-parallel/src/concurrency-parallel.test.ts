/**
 * Comprehensive Tests for Concurrency vs Parallelism Examples
 *
 * These tests validate the behavior and performance characteristics
 * of different concurrency and parallelism approaches.
 */

import { ConcurrencyManager } from "./concurrency-manager";
import { ParallelManager } from "./parallel-manager";
import { ConcurrencyExamples, PerformanceComparison } from "./examples";

describe("ConcurrencyManager", () => {
  let manager: ConcurrencyManager;

  beforeEach(() => {
    manager = new ConcurrencyManager({ maxConcurrent: 3, timeout: 5000 });
  });

  afterEach(() => {
    manager.reset();
  });

  describe("executeAllConcurrent", () => {
    it("should execute all tasks concurrently", async () => {
      const tasks = [
        { id: 1, delay: 100 },
        { id: 2, delay: 200 },
        { id: 3, delay: 150 },
      ];

      const processor = async (task: {
        id: number;
        delay: number;
      }): Promise<{ taskId: number; processed: boolean }> => {
        await new Promise((resolve) => setTimeout(resolve, task.delay));
        return { taskId: task.id, processed: true };
      };

      const startTime = Date.now();
      const results = await manager.executeAllConcurrent(tasks, processor);
      const executionTime = Date.now() - startTime;

      // All tasks should complete
      expect(results).toHaveLength(3);
      expect(results.every((r) => r.processed)).toBe(true);

      // Should be faster than sequential execution
      // Max delay is 200ms, so concurrent should be ~200ms, not 450ms (sum).
      // Use 350ms to allow scheduler/event-loop variance in CI and busy machines.
      expect(executionTime).toBeLessThan(350);
    });

    it("should handle task failures gracefully", async () => {
      const tasks = [
        { id: 1, shouldFail: false },
        { id: 2, shouldFail: true },
        { id: 3, shouldFail: false },
      ];

      const processor = async (task: {
        id: number;
        shouldFail?: boolean;
      }): Promise<{ taskId: number; processed: boolean }> => {
        if (task.shouldFail) {
          throw new Error(`Task ${task.id} failed`);
        }
        return { taskId: task.id, processed: true };
      };

      await expect(manager.executeAllConcurrent(tasks, processor)).rejects.toThrow("Task 2 failed");
    });
  });

  describe("executeLimitedConcurrent", () => {
    it("should respect concurrency limits", async () => {
      const tasks = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, delay: 100 }));
      let activeCount = 0;
      let maxActiveCount = 0;

      const processor = async (task: {
        id: number;
        delay: number;
      }): Promise<{ taskId: number; processed: boolean }> => {
        activeCount++;
        maxActiveCount = Math.max(maxActiveCount, activeCount);

        await new Promise((resolve) => setTimeout(resolve, task.delay));

        activeCount--;
        return { taskId: task.id, processed: true };
      };

      const results = await manager.executeLimitedConcurrent(tasks, processor);

      expect(results).toHaveLength(6);
      expect(maxActiveCount).toBeLessThanOrEqual(3); // Should respect maxConcurrent: 3
    });
  });

  describe("executePriorityQueue", () => {
    it("should process higher priority tasks first", async () => {
      const tasks = [
        { id: 1, priority: 1, delay: 50 },
        { id: 2, priority: 10, delay: 50 },
        { id: 3, priority: 5, delay: 50 },
        { id: 4, priority: 20, delay: 50 },
      ];

      const processingOrder: number[] = [];

      const processor = async (task: {
        id: number;
        priority?: number;
        delay: number;
      }): Promise<{ taskId: number; processed: boolean; priority?: number }> => {
        processingOrder.push(task.id);
        await new Promise((resolve) => setTimeout(resolve, task.delay));
        return { taskId: task.id, processed: true, priority: task.priority };
      };

      // Use maxConcurrent: 1 to ensure sequential processing for priority testing
      const priorityManager = new ConcurrencyManager({ maxConcurrent: 1 });
      const results = await priorityManager.executePriorityQueue(tasks, processor);

      expect(results).toHaveLength(4);

      // Higher priority tasks should be processed first
      // Priority order should be: 4 (20), 2 (10), 3 (5), 1 (1)
      expect(processingOrder[0]).toBe(4); // Highest priority first
      expect(processingOrder[1]).toBe(2); // Second highest
    });
  });

  describe("executeSequential", () => {
    it("should execute tasks one after another", async () => {
      const tasks = [
        { id: 1, delay: 100 },
        { id: 2, delay: 100 },
        { id: 3, delay: 100 },
      ];

      const processingOrder: number[] = [];

      const processor = async (task: {
        id: number;
        delay: number;
      }): Promise<{ taskId: number; processed: boolean }> => {
        processingOrder.push(task.id);
        await new Promise((resolve) => setTimeout(resolve, task.delay));
        return { taskId: task.id, processed: true };
      };

      const startTime = Date.now();
      const results = await manager.executeSequential(tasks, processor);
      const executionTime = Date.now() - startTime;

      expect(results).toHaveLength(3);
      expect(processingOrder).toEqual([1, 2, 3]); // Should maintain order
      expect(executionTime).toBeGreaterThan(290); // Should be ~300ms (3 * 100ms)
    });
  });

  describe("executeBatched", () => {
    it("should process tasks in batches", async () => {
      const tasks = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, delay: 50 }));

      const processor = async (task: {
        id: number;
        delay: number;
      }): Promise<{ taskId: number; processed: boolean }> => {
        await new Promise((resolve) => setTimeout(resolve, task.delay));
        return { taskId: task.id, processed: true };
      };

      const results = await manager.executeBatched(tasks, processor, 3);

      expect(results).toHaveLength(7);
      expect(results.every((r) => r.processed)).toBe(true);
    });
  });

  describe("getPerformanceMetrics", () => {
    it("should provide accurate performance metrics", async () => {
      const tasks = [
        { id: 1, delay: 100 },
        { id: 2, delay: 200 },
      ];

      const processor = async (task: {
        id: number;
        delay: number;
      }): Promise<{ taskId: number; processed: boolean }> => {
        await new Promise((resolve) => setTimeout(resolve, task.delay));
        return { taskId: task.id, processed: true };
      };

      await manager.executeAllConcurrent(tasks, processor);
      const metrics = manager.getPerformanceMetrics();

      expect(metrics.totalTasks).toBe(2);
      expect(metrics.concurrencyLevel).toBe(3);
      expect(metrics.averageTaskTime).toBeGreaterThan(0);
      expect(metrics.throughput).toBeGreaterThan(0);
    });
  });
});

describe("ParallelManager", () => {
  let manager: ParallelManager;
  // Let resolveWorkerPath auto-select compiled worker.js (faster) or worker.ts fallback

  beforeEach(() => {
    manager = new ParallelManager({ workerCount: 2, timeout: 10000 });
  });

  afterEach(async () => {
    await manager.cleanup();
    manager.reset();
  });

  describe("initializeWorkers", () => {
    it("should initialize worker pool", async () => {
      await manager.initializeWorkers();

      // Workers should be ready (tested implicitly by successful initialization)
      expect(true).toBe(true);
    }, 20000);
  });

  describe("executeParallel", () => {
    it("should execute CPU-intensive tasks in parallel", async () => {
      await manager.initializeWorkers();

      const tasks = [
        { type: "compute", data: { iterations: 20000 } },
        { type: "compute", data: { iterations: 20000 } },
      ];

      const startTime = Date.now();
      const results = await manager.executeParallel(tasks, "compute");
      const executionTime = Date.now() - startTime;

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.computed !== undefined)).toBe(true);

      // Parallel execution should be faster than sequential
      // (though this depends on the actual CPU cores available)
      expect(executionTime).toBeLessThan(5000);
    }, 20000);

    it("should handle fibonacci calculations", async () => {
      await manager.initializeWorkers();

      const tasks = [{ n: 10 }];
      const results = await manager.executeParallel(tasks as { n: number }[], "fibonacci");

      expect(results).toHaveLength(1);
      expect(results[0].result).toBe(55); // 10th Fibonacci number
      expect(results[0].n).toBe(10);
    }, 20000);

    it("should handle prime number checking", async () => {
      await manager.initializeWorkers();

      const tasks = [
        { number: 17 }, // Prime
        { number: 18 }, // Not prime
      ];

      const results = await manager.executeParallel(tasks as { number: number }[], "prime-check");

      expect(results).toHaveLength(2);
      expect(results[0].isPrime).toBe(true); // 17 is prime
      expect(results[1].isPrime).toBe(false); // 18 is not prime
    }, 20000);
  });

  describe("executeChunkedParallel", () => {
    it("should process large datasets in chunks", async () => {
      await manager.initializeWorkers();

      const data = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, value: i * 2 }));

      const results = await manager.executeChunkedParallel(data, "batch-compute");

      expect(results).toHaveLength(50);
      expect(results.every((r) => r.processed)).toBe(true);
      expect(results.every((r) => r.processedBy !== undefined)).toBe(true);
    }, 20000);
  });

  describe("getPerformanceMetrics", () => {
    it("should provide performance metrics for parallel execution", async () => {
      await manager.initializeWorkers();

      const tasks = [{ type: "compute", data: { iterations: 20000 } }];
      await manager.executeParallel(tasks, "compute");

      const metrics = manager.getPerformanceMetrics();

      expect(metrics.totalTasks).toBe(1);
      expect(metrics.concurrencyLevel).toBe(2); // workerCount
      expect(metrics.averageTaskTime).toBeGreaterThan(0);
      expect(metrics.throughput).toBeGreaterThan(0);
    }, 30000);
  });
});

describe("ConcurrencyExamples", () => {
  let examples: ConcurrencyExamples;

  beforeEach(() => {
    examples = new ConcurrencyExamples();
  });

  describe("demonstrateApiCalls", () => {
    it("should complete API calls demonstration", async () => {
      // This test mainly ensures the example runs without errors
      await examples.demonstrateApiCalls();
    });
  });

  describe("demonstrateDatabaseOperations", () => {
    it("should complete database operations demonstration", async () => {
      await examples.demonstrateDatabaseOperations();
    }, 30000);
  });

  describe("demonstratePriorityQueue", () => {
    it("should complete priority queue demonstration", async () => {
      await examples.demonstratePriorityQueue();
    });
  });
});

describe("PerformanceComparison", () => {
  describe("compareApproaches", () => {
    it("should complete performance comparison", async () => {
      await PerformanceComparison.compareApproaches();
    }, 30000);
  });
});

describe("Integration Tests", () => {
  describe("Concurrency vs Parallelism Decision Making", () => {
    it("should demonstrate when to use concurrency vs parallelism", async () => {
      // I/O-bound tasks (should use concurrency)
      const ioBoundTasks = Array.from({ length: 5 }, (_, i) => ({
        id: i + 1,
        delay: 200 + Math.random() * 100,
      }));

      const ioProcessor = async (task: {
        id: number;
        delay: number;
      }): Promise<{ taskId: number; type: string }> => {
        await new Promise((resolve) => setTimeout(resolve, task.delay));
        return { taskId: task.id, type: "io-bound" };
      };

      const concurrencyManager = new ConcurrencyManager({ maxConcurrent: 5 });

      const concurrentStart = Date.now();
      const concurrentResults = await concurrencyManager.executeAllConcurrent(
        ioBoundTasks,
        ioProcessor
      );
      const concurrentTime = Date.now() - concurrentStart;

      const sequentialStart = Date.now();
      const sequentialResults = await concurrencyManager.executeSequential(
        ioBoundTasks,
        ioProcessor
      );
      const sequentialTime = Date.now() - sequentialStart;

      // Concurrent should be significantly faster for I/O-bound tasks
      expect(concurrentResults).toHaveLength(5);
      expect(sequentialResults).toHaveLength(5);
      expect(concurrentTime).toBeLessThan(sequentialTime * 0.8);

      console.warn(
        `I/O-bound tasks: Concurrent ${concurrentTime}ms vs Sequential ${sequentialTime}ms`
      );
    });

    it("should handle mixed workloads appropriately", async () => {
      // Mixed workload: some I/O, some CPU
      const mixedTasks = [
        { type: "io", delay: 200 },
        { type: "cpu", iterations: 100000 },
        { type: "io", delay: 150 },
        { type: "cpu", iterations: 150000 },
      ];

      const mixedProcessor = async (task: {
        type: string;
        delay?: number;
        iterations?: number;
      }): Promise<{ taskId: string; type: string; result?: number }> => {
        if (task.type === "io") {
          await new Promise((resolve) => setTimeout(resolve, task.delay));
          return { taskId: `io-${task.delay}`, type: "io-bound" };
        } else {
          // Simulate CPU work
          let result = 0;
          for (let i = 0; i < task.iterations; i++) {
            result += Math.sqrt(i);
          }
          return { taskId: `cpu-${task.iterations}`, type: "cpu-bound", result };
        }
      };

      const manager = new ConcurrencyManager({ maxConcurrent: 4 });
      const results = await manager.executeAllConcurrent(mixedTasks, mixedProcessor);

      expect(results).toHaveLength(4);
      expect(results.some((r) => r.type === "io-bound")).toBe(true);
      expect(results.some((r) => r.type === "cpu-bound")).toBe(true);
    });
  });

  describe("Error Handling and Recovery", () => {
    it("should handle worker failures gracefully", async () => {
      const manager = new ParallelManager({ workerCount: 2, timeout: 1000 });

      try {
        await manager.initializeWorkers();

        // Test with a task that might cause issues
        const problematicTasks = [
          { type: "fibonacci", data: { n: -1 } }, // Invalid input
        ];

        await expect(manager.executeParallel(problematicTasks, "fibonacci")).rejects.toThrow();
      } finally {
        await manager.cleanup();
      }
    }, 20000);

    it("should handle timeout scenarios", async () => {
      const manager = new ConcurrencyManager({ maxConcurrent: 2, timeout: 500 });

      const slowTasks = [
        { id: 1, delay: 1000 }, // Longer than timeout
      ];

      const slowProcessor = async (task: {
        id: number;
        delay: number;
      }): Promise<{ taskId: number }> => {
        await new Promise((resolve) => setTimeout(resolve, task.delay));
        return { taskId: task.id };
      };

      // ConcurrencyConfig.timeout is now enforced: a task exceeding it rejects
      // instead of hanging the batch (this test previously documented the gap).
      await expect(manager.executeAllConcurrent(slowTasks, slowProcessor)).rejects.toThrow(
        /timed out after 500ms/
      );
    });
  });
});

describe("Real-world Scenarios", () => {
  it("should handle API rate limiting scenario", async () => {
    // Simulate API with rate limiting (max 2 concurrent requests)
    let activeRequests = 0;
    const maxConcurrentRequests = 2;

    const rateLimitedApiCall = async (request: {
      id: number;
    }): Promise<{ requestId: number; status: string }> => {
      if (activeRequests >= maxConcurrentRequests) {
        throw new Error("Rate limit exceeded");
      }

      activeRequests++;

      try {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { requestId: request.id, status: "success" };
      } finally {
        activeRequests--;
      }
    };

    const requests = Array.from({ length: 10 }, (_, i) => ({ id: i + 1 }));
    const manager = new ConcurrencyManager({ maxConcurrent: 2 });

    const results = await manager.executeLimitedConcurrent(requests, rateLimitedApiCall);

    expect(results).toHaveLength(10);
    expect(results.every((r) => r.status === "success")).toBe(true);
  });

  it("should handle batch processing scenario", async () => {
    // Large dataset that needs to be processed in manageable chunks
    const largeDataset = Array.from({ length: 1000 }, (_, i) => ({
      id: i + 1,
      data: `record-${i + 1}`,
      value: Math.random() * 100,
    }));

    const batchProcessor = async (record: {
      id: number;
      data: string;
      value: number;
    }): Promise<{
      id: number;
      data: string;
      value: number;
      processed: boolean;
      processedAt: number;
    }> => {
      // Simulate processing time
      await new Promise((resolve) => setTimeout(resolve, 1));

      return {
        ...record,
        processed: true,
        processedAt: Date.now(),
      };
    };

    const manager = new ConcurrencyManager({ maxConcurrent: 10 });
    const results = await manager.executeBatched(largeDataset, batchProcessor, 50);

    expect(results).toHaveLength(1000);
    expect(results.every((r) => r.processed)).toBe(true);
  });
});
