/**
 * Concurrency Manager - Demonstrates different approaches to managing concurrent operations
 *
 * This class showcases:
 * 1. Promise-based concurrency control
 * 2. Queue management with priority
 * 3. Rate limiting and throttling
 * 4. Error handling, retries, and per-task timeouts
 * 5. Cooperative cancellation (AbortSignal) and fail-fast semantics
 * 6. Performance monitoring
 */

import {
  TaskResult,
  ConcurrencyConfig,
  PerformanceMetrics,
  TaskProcessor,
  SettledTaskResult,
} from "./concurrency-types.js";
import { ConcurrencyDefaultConfig } from "./constants";

export class ConcurrencyManager {
  private config: ConcurrencyConfig;
  private activeTasksCount = 0;
  private completedTasks: TaskResult[] = [];
  private startTime: number = 0;

  constructor(config: ConcurrencyConfig) {
    this.config = config;
  }

  /**
   * Run a processor for one task with the configured timeout + retries applied.
   * - `timeout` (ms): each attempt races a timer; a late attempt rejects with a
   *   descriptive error instead of hanging the whole batch.
   * - `retries`: failed attempts (including timeouts) are retried up to N extra
   *   times before the error propagates.
   * Both settings were always declared on ConcurrencyConfig but previously ignored.
   */
  private async runWithPolicy<T, R>(task: T, processor: TaskProcessor<T, R>): Promise<R> {
    const { timeout, retries = 0 } = this.config;
    const attempts = Math.max(0, retries) + 1;
    let lastError: unknown;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        if (timeout === undefined || timeout <= 0) {
          return await processor(task);
        }
        return await this.withTimeout(processor(task), timeout, attempt);
      } catch (error) {
        lastError = error;
        if (attempt === attempts) break;
      }
    }
    throw lastError;
  }

  private withTimeout<R>(promise: Promise<R>, timeoutMs: number, attempt: number): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Task timed out after ${timeoutMs}ms (attempt ${attempt})`));
      }, timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  /** Throw an AbortError-shaped error if the configured signal has fired. */
  private throwIfAborted(): void {
    if (this.config.signal?.aborted) {
      const reason = this.config.signal.reason;
      throw reason instanceof Error ? reason : new Error("Execution aborted");
    }
  }

  /** Record a completed task, keeping memory bounded (FIFO eviction). */
  private recordTask(taskResult: TaskResult): void {
    const cap = this.config.maxCompletedTasks ?? ConcurrencyDefaultConfig.MAX_COMPLETED_TASKS;
    if (this.completedTasks.length >= cap) {
      this.completedTasks.shift();
    }
    this.completedTasks.push(taskResult);
  }

  /**
   * Basic Promise.all approach - All tasks start simultaneously
   * Good for: Independent tasks that can all run at once
   * Bad for: Resource-intensive tasks that might overwhelm the system
   */
  async executeAllConcurrent<T, R>(tasks: T[], processor: TaskProcessor<T, R>): Promise<R[]> {
    if (typeof process.env.CI === "undefined") {
      console.warn(`🚀 Starting ${tasks.length} tasks concurrently (Promise.all)`);
    }
    this.startTime = Date.now();
    this.throwIfAborted();

    try {
      // All promises start immediately - true concurrency
      const promises = tasks.map(async (task, index) => {
        const startTime = Date.now();
        this.activeTasksCount++;

        try {
          const result = await this.runWithPolicy(task, processor);
          const endTime = Date.now();

          this.recordTask({
            taskId: `task-${index}`,
            result,
            executionTime: endTime - startTime,
            startTime,
            endTime,
          });

          return result;
        } finally {
          this.activeTasksCount--;
        }
      });

      const results = await Promise.all(promises);
      if (typeof process.env.CI === "undefined") {
        console.warn(`✅ All ${tasks.length} tasks completed concurrently`);
      }
      return results;
    } catch (error) {
      console.error("❌ Concurrent execution failed:", error);
      throw error;
    }
  }

  /**
   * Like executeAllConcurrent, but never fail-fast: every task runs to
   * completion and the caller gets a per-task settled outcome. Mirrors
   * Promise.allSettled semantics with the manager's timeout/retry policy.
   */
  async executeAllSettled<T, R>(
    tasks: T[],
    processor: TaskProcessor<T, R>
  ): Promise<SettledTaskResult<R>[]> {
    this.startTime = Date.now();
    this.throwIfAborted();

    return Promise.all(
      tasks.map(async (task, index): Promise<SettledTaskResult<R>> => {
        const startTime = Date.now();
        this.activeTasksCount++;
        try {
          const result = await this.runWithPolicy(task, processor);
          const endTime = Date.now();
          this.recordTask({
            taskId: `settled-task-${index}`,
            result,
            executionTime: endTime - startTime,
            startTime,
            endTime,
          });
          return { status: "fulfilled", value: result, taskIndex: index };
        } catch (error) {
          return { status: "rejected", reason: error, taskIndex: index };
        } finally {
          this.activeTasksCount--;
        }
      })
    );
  }

  /**
   * Limited concurrency with a lightweight inline limiter.
   * Fail-fast is now genuine: when one task rejects (after retries), the other
   * worker lanes stop pulling new tasks instead of silently continuing to run
   * side effects behind an already-rejected promise.
   */
  async executeLimitedConcurrent<T, R>(tasks: T[], processor: TaskProcessor<T, R>): Promise<R[]> {
    if (typeof process.env.CI === "undefined") {
      console.warn(
        `🎯 Starting ${tasks.length} tasks with concurrency limit of ${this.config.maxConcurrent}`
      );
    }
    this.startTime = Date.now();
    this.throwIfAborted();

    const concurrency = Math.max(1, this.config.maxConcurrent);
    const results: R[] = new Array(tasks.length);
    let nextIndex = 0;
    let failed = false;

    const runWorker = async (): Promise<void> => {
      for (;;) {
        if (failed) break;
        if (this.config.signal?.aborted) this.throwIfAborted();
        const current = nextIndex++;
        if (current >= tasks.length) break;

        const startTime = Date.now();
        this.activeTasksCount++;
        try {
          const result = await this.runWithPolicy(tasks[current], processor);
          results[current] = result as R;
          const endTime = Date.now();
          this.recordTask({
            taskId: `limited-task-${current}`,
            result,
            executionTime: endTime - startTime,
            startTime,
            endTime,
          });
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          this.activeTasksCount--;
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, tasks.length) }, () => runWorker())
    );
    if (typeof process.env.CI === "undefined") {
      console.warn("🎉 All limited concurrent tasks completed");
    }
    return results;
  }

  /**
   * Priority queue without external deps.
   * Same fail-fast + abort semantics as executeLimitedConcurrent.
   */
  async executePriorityQueue<T, R>(
    tasks: (T & { priority?: number })[],
    processor: TaskProcessor<T, R>
  ): Promise<R[]> {
    if (typeof process.env.CI === "undefined") {
      console.warn(`🏆 Starting priority queue with ${tasks.length} tasks`);
    }
    this.throwIfAborted();

    // Sort by priority descending; process with limited concurrency
    const sorted = [...tasks].sort((a, b) => (b.priority || 0) - (a.priority || 0));
    const results: R[] = new Array(sorted.length);
    let nextIndex = 0;
    let failed = false;
    const concurrency = Math.max(1, this.config.maxConcurrent);

    const runWorker = async (): Promise<void> => {
      for (;;) {
        if (failed) break;
        if (this.config.signal?.aborted) this.throwIfAborted();
        const idx = nextIndex++;
        if (idx >= sorted.length) break;
        const task = sorted[idx];
        const startTime = Date.now();
        this.activeTasksCount++;
        try {
          const result = await this.runWithPolicy(task, processor);
          results[idx] = result as R;
          const endTime = Date.now();
          this.recordTask({
            taskId: `priority-task-${idx}`,
            result,
            executionTime: endTime - startTime,
            startTime,
            endTime,
          });
        } catch (error) {
          failed = true;
          throw error;
        } finally {
          this.activeTasksCount--;
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(concurrency, sorted.length) }, () => runWorker())
    );
    if (typeof process.env.CI === "undefined") {
      console.warn("🎊 Priority queue processing completed");
    }
    return results;
  }

  /**
   * Sequential processing with controlled timing
   */
  async executeSequential<T, R>(
    tasks: T[],
    processor: TaskProcessor<T, R>,
    delayMs: number = 0
  ): Promise<R[]> {
    if (typeof process.env.CI === "undefined") {
      console.warn(`⏭️ Starting sequential processing of ${tasks.length} tasks`);
    }
    this.startTime = Date.now();
    const results: R[] = [];

    for (let i = 0; i < tasks.length; i++) {
      this.throwIfAborted();
      const task = tasks[i];
      const startTime = Date.now();

      if (typeof process.env.CI === "undefined") {
        console.warn(`📝 Processing task ${i + 1}/${tasks.length} sequentially`);
      }

      try {
        const result = await this.runWithPolicy(task, processor);
        const endTime = Date.now();

        this.recordTask({
          taskId: `sequential-task-${i}`,
          result,
          executionTime: endTime - startTime,
          startTime,
          endTime,
        });

        results.push(result);

        // Optional delay between tasks
        if (delayMs > 0 && i < tasks.length - 1) {
          if (typeof process.env.CI === "undefined") {
            console.warn(`⏱️ Waiting ${delayMs}ms before next task`);
          }
          await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
      } catch (error) {
        console.error(`❌ Sequential task ${i + 1} failed:`, error);
        throw error;
      }
    }

    if (typeof process.env.CI === "undefined") {
      console.warn("✅ Sequential processing completed");
    }
    return results;
  }

  /**
   * Batch processing - Process tasks in chunks
   */
  async executeBatched<T, R>(
    tasks: T[],
    processor: TaskProcessor<T, R>,
    batchSize: number = 10
  ): Promise<R[]> {
    if (typeof process.env.CI === "undefined") {
      console.warn(
        `📦 Starting batched processing: ${tasks.length} tasks in batches of ${batchSize}`
      );
    }
    this.startTime = Date.now();
    const results: R[] = [];

    // Split tasks into batches
    for (let i = 0; i < tasks.length; i += batchSize) {
      this.throwIfAborted();
      const batch = tasks.slice(i, i + batchSize);
      const batchNumber = Math.floor(i / batchSize) + 1;
      const totalBatches = Math.ceil(tasks.length / batchSize);

      if (typeof process.env.CI === "undefined") {
        console.warn(`📋 Processing batch ${batchNumber}/${totalBatches} (${batch.length} tasks)`);
      }

      // Process batch concurrently with the limiter
      const batchResults = await this.executeLimitedConcurrent(batch, processor);
      results.push(...batchResults);

      if (typeof process.env.CI === "undefined") {
        console.warn(`✅ Batch ${batchNumber} completed`);
      }
    }

    if (typeof process.env.CI === "undefined") {
      console.warn("🎉 All batches completed");
    }
    return results;
  }

  /**
   * Current number of in-flight tasks (useful for monitoring/backpressure).
   */
  getActiveTaskCount(): number {
    return this.activeTasksCount;
  }

  /**
   * Get performance metrics for analysis
   */
  getPerformanceMetrics(): PerformanceMetrics {
    const totalExecutionTime = this.startTime > 0 ? Date.now() - this.startTime : 0;
    const completedTasksCount = this.completedTasks.length;

    return {
      totalTasks: completedTasksCount,
      totalExecutionTime,
      averageTaskTime:
        completedTasksCount > 0
          ? this.completedTasks.reduce((sum, task) => sum + task.executionTime, 0) /
            completedTasksCount
          : 0,
      concurrencyLevel: this.config.maxConcurrent,
      throughput:
        completedTasksCount > 0 && totalExecutionTime > 0
          ? (completedTasksCount / totalExecutionTime) * 1000
          : 0,
    };
  }

  /**
   * Reset metrics for new test runs
   */
  reset(): void {
    this.completedTasks = [];
    this.activeTasksCount = 0;
    this.startTime = 0;
  }
}
