/**
 * Parallel Manager - Demonstrates true parallelism using Worker Threads
 *
 * This class showcases:
 * 1. Worker thread management for CPU-intensive tasks
 * 2. Pull-based load balancing across workers (idle worker takes the next
 *    queued task) — the strategy used by production pools like Piscina.
 *    Eager round-robin assignment suffers head-of-line blocking: one slow
 *    task starves everything queued behind it on the same worker while
 *    other workers sit idle.
 * 3. Communication between main thread and workers
 * 4. Error handling in parallel environments, including worker crash
 *    recovery (auto-respawn) and per-task timeouts that free the pool
 * 5. Resource cleanup and lifecycle management
 *
 * Note: In Node.js, true parallelism requires Worker Threads for CPU-bound tasks
 * I/O operations are naturally concurrent through the event loop
 */

import { Worker } from "worker_threads";
import { cpus } from "os";
import { join, resolve } from "path";
import { existsSync } from "fs";
import { TaskResult, ParallelConfig, PerformanceMetrics } from "./concurrency-types.js";
import { ParallelDefaultConfig } from "./constants";

interface WorkerTask {
  id: string;
  data: unknown;
  type: string;
}

interface WorkerResult {
  taskId: string;
  result: unknown;
  error?: string;
  executionTime: number;
}

interface PendingTask {
  task: WorkerTask;
  settle: (message: WorkerResult) => void;
  fail: (error: Error) => void;
}

export class ParallelManager {
  private config: ParallelConfig;
  private workers: Worker[] = [];
  private idleWorkers: Worker[] = [];
  private taskQueue: PendingTask[] = [];
  private inFlight = new Map<Worker, PendingTask>();
  private activeTasksCount = 0;
  private completedTasks: TaskResult[] = [];
  private startTime: number = 0;
  private isShuttingDown = false;
  private workerRestarts = 0;
  private workerPath = "";
  private workerExecArgv: string[] = [];
  private nextWorkerId = 0;

  constructor(config: ParallelConfig) {
    this.config = {
      workerCount: config.workerCount || cpus().length,
      timeout: config.timeout ?? ParallelDefaultConfig.TIMEOUT_MS,
      chunkSize: config.chunkSize ?? ParallelDefaultConfig.CHUNK_SIZE,
      maxCompletedTasks: config.maxCompletedTasks ?? ParallelDefaultConfig.MAX_COMPLETED_TASKS,
      maxPendingTasks: config.maxPendingTasks,
      maxWorkerRestarts: config.maxWorkerRestarts ?? ParallelDefaultConfig.MAX_WORKER_RESTARTS,
    };
  }

  /**
   * Initialize worker pool
   * Why: Pre-creating workers avoids the overhead of spawning them for each task
   */
  async initializeWorkers(workerScript?: string): Promise<void> {
    console.warn(`🏭 Initializing ${this.config.workerCount} workers`);

    const { path: resolvedPath, execArgv } = this.resolveWorkerPath(workerScript);
    this.workerPath = resolvedPath;
    this.workerExecArgv = execArgv;

    const count = this.config.workerCount ?? 1;
    const workerPromises = Array.from({ length: count }, () =>
      this.createWorker(resolvedPath, execArgv, this.nextWorkerId++)
    );

    this.workers = (await Promise.all(workerPromises)) as Worker[];
    this.idleWorkers = [...this.workers];
    console.warn(`✅ Worker pool initialized with ${this.workers.length} workers`);
  }

  /**
   * Create a single worker with error handling.
   * After the worker reports ready, persistent error/exit listeners stay
   * attached: a crashed worker fails its in-flight task loudly, is removed
   * from the pool, and (up to maxWorkerRestarts) a replacement is spawned —
   * instead of the previous behavior where a post-init 'error' event had no
   * listener (crashing the whole process) and in-flight tasks hung forever.
   */
  private async createWorker(
    workerPath: string,
    execArgv: string[],
    workerId: number
  ): Promise<Worker> {
    return new Promise((resolvePromise, reject) => {
      // Create worker from file path (production approach)
      const worker = new Worker(workerPath, {
        workerData: { workerId },
        execArgv,
      });
      worker.unref();

      worker.on("message", (message: WorkerResult & { type?: string }) => {
        if (message && message.type === "ready") {
          // Initialization message handled by once('message') below
          return;
        }
        this.handleWorkerResult(worker, message, workerId);
      });

      const clearInitTimeout = (): void => {
        clearTimeout(initTimeout);
      };

      const removeInitListeners = (): void => {
        worker.off("error", onInitError);
        worker.off("exit", onInitExit);
      };

      const onInitError = (error: Error): void => {
        clearInitTimeout();
        removeInitListeners();
        console.error(`❌ Worker ${workerId} error:`, error);
        reject(error);
      };

      const onInitExit = (code: number | null): void => {
        clearInitTimeout();
        removeInitListeners();
        if (code !== 0) {
          console.error(`❌ Worker ${workerId} exited with code ${code}`);
        }
        reject(new Error(`Worker ${workerId} exited with code ${code ?? "unknown"} before ready`));
      };

      // Timeout for worker initialization (cleared on ready, error, or exit to avoid dangling timer)
      const initTimeout = setTimeout(() => {
        removeInitListeners();
        reject(new Error(`Worker ${workerId} initialization timeout`));
      }, ParallelDefaultConfig.WORKER_READY_TIMEOUT_MS);

      worker.on("error", onInitError);
      worker.on("exit", onInitExit);

      worker.once("message", (message: WorkerResult & { type?: string }) => {
        if (message && message.type === "ready") {
          if (this.isShuttingDown) return;
          clearInitTimeout();
          removeInitListeners();

          // Persistent post-ready failure handling
          worker.on("error", (error: Error) => this.handleWorkerFailure(worker, workerId, error));
          worker.on("exit", (code: number | null) => {
            if (!this.isShuttingDown && code !== 0) {
              this.handleWorkerFailure(
                worker,
                workerId,
                new Error(`Worker ${workerId} exited unexpectedly with code ${code ?? "unknown"}`)
              );
            }
          });

          console.warn(`👷 Worker ${workerId} ready`);
          resolvePromise(worker);
        }
      });
    });
  }

  private resolveWorkerPath(workerScript?: string): {
    path: string;
    execArgv: string[];
  } {
    // An explicitly provided script that exists on disk takes precedence.
    // (Previously the explicit argument was silently ignored whenever a
    // compiled dist/worker.js existed.) Non-existent explicit paths fall
    // through to auto-resolution for backward compatibility with callers
    // passing placeholder values.
    if (workerScript && existsSync(workerScript)) {
      const execArgv = workerScript.endsWith(".ts") ? ["-r", "ts-node/register"] : [];
      return { path: workerScript, execArgv };
    }

    // Prefer compiled worker.js (faster, no ts-node) - use cwd for CI (ts-jest can change __dirname)
    const distFromCwd = resolve(process.cwd(), "src/api/concurrency-parallel/dist/worker.js");
    if (existsSync(distFromCwd)) {
      return { path: distFromCwd, execArgv: [] };
    }
    const distFromDirname = join(__dirname, "../dist/worker.js");
    if (existsSync(distFromDirname)) {
      return { path: distFromDirname, execArgv: [] };
    }

    const localJsPath = join(__dirname, "worker.js");
    if (existsSync(localJsPath)) {
      return { path: localJsPath, execArgv: [] };
    }

    const tsPath = join(__dirname, "worker.ts");
    return { path: tsPath, execArgv: ["-r", "ts-node/register"] };
  }

  /**
   * Execute tasks in parallel across worker threads
   * Good for: CPU-intensive computations (math, image processing, data transformation)
   * Why: Utilizes multiple CPU cores for true parallel processing
   *
   * Dispatch is pull-based: tasks wait in a single shared FIFO queue and the
   * next idle worker takes the next task. No task is ever stuck behind a slow
   * task on a pre-assigned worker while another worker idles.
   */
  async executeParallel<T>(tasks: T[], taskType: string = "compute"): Promise<unknown[]> {
    if (this.workers.length === 0) {
      throw new Error("Workers not initialized. Call initializeWorkers() first.");
    }

    console.warn(
      `⚡ Starting parallel execution of ${tasks.length} tasks across ${this.workers.length} workers`
    );
    this.startTime = Date.now();

    const taskPromises = tasks.map((task, index) => {
      const workerTask: WorkerTask = {
        id: `parallel-task-${index}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        data: task,
        type: taskType,
      };
      return this.submitTask(workerTask);
    });

    const results = await Promise.all(taskPromises);
    console.warn(`🎉 All parallel tasks completed`);
    return results;
  }

  /**
   * Submit one task: dispatch to an idle worker immediately, or queue it
   * (subject to maxPendingTasks backpressure) until a worker frees up.
   */
  private submitTask(task: WorkerTask): Promise<unknown> {
    return new Promise((resolvePromise, reject) => {
      const startTime = Date.now();

      const timeoutMs = this.config.timeout ?? ParallelDefaultConfig.TIMEOUT_MS;
      let settled = false;

      const pending: PendingTask = {
        task,
        settle: (message: WorkerResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          this.activeTasksCount--;

          const endTime = Date.now();
          this.recordTask({
            taskId: task.id,
            result: message.result,
            executionTime: message.executionTime,
            startTime,
            endTime,
          });

          if (message.error) {
            reject(new Error(message.error));
          } else {
            resolvePromise(message.result);
          }
        },
        fail: (error: Error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          this.activeTasksCount--;
          reject(error);
        },
      };

      const timeout = setTimeout(() => {
        // Reject the caller. The worker (if any) is still busy computing;
        // it stays out of the idle set and rejoins when its late result
        // arrives (which is then discarded).
        const queuedIdx = this.taskQueue.indexOf(pending);
        if (queuedIdx !== -1) this.taskQueue.splice(queuedIdx, 1);
        pending.fail(new Error(`Task ${task.id} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.activeTasksCount++;

      const idleWorker = this.idleWorkers.shift();
      if (idleWorker) {
        this.dispatchToWorker(idleWorker, pending);
      } else {
        const maxPending = this.config.maxPendingTasks;
        if (maxPending !== undefined && this.taskQueue.length >= maxPending) {
          pending.fail(
            new Error(
              `Task queue full (${this.taskQueue.length}/${maxPending} pending); rejecting ${task.id}`
            )
          );
          return;
        }
        this.taskQueue.push(pending);
      }
    });
  }

  private dispatchToWorker(worker: Worker, pending: PendingTask): void {
    this.inFlight.set(worker, pending);
    worker.postMessage(pending.task);
  }

  /**
   * A worker sent back a task result: settle the matching in-flight task
   * (if it hasn't already timed out) and hand the worker its next task.
   */
  private handleWorkerResult(worker: Worker, message: WorkerResult, workerId: number): void {
    const pending = this.inFlight.get(worker);
    this.inFlight.delete(worker);

    if (pending && message.taskId === pending.task.id) {
      pending.settle(message);
    } else if (pending) {
      // Result for a task we no longer track — settle defensively by id match failure
      console.warn(
        `📥 Worker ${workerId} returned unexpected task ${message.taskId}; expected ${pending.task.id}`
      );
      pending.fail(new Error(`Worker returned mismatched task id ${message.taskId}`));
    } else {
      // Late result for a task that already timed out — discard it
      console.warn(`📥 Discarding late result from worker ${workerId} for task ${message.taskId}`);
    }

    this.assignNextOrIdle(worker);
  }

  private assignNextOrIdle(worker: Worker): void {
    if (this.isShuttingDown) return;
    const next = this.taskQueue.shift();
    if (next) {
      this.dispatchToWorker(worker, next);
    } else if (!this.idleWorkers.includes(worker)) {
      this.idleWorkers.push(worker);
    }
  }

  /**
   * A worker crashed post-init: fail its in-flight task, remove it from the
   * pool, and spawn a replacement (bounded by maxWorkerRestarts).
   */
  private handleWorkerFailure(worker: Worker, workerId: number, error: Error): void {
    console.error(`❌ Worker ${workerId} failed:`, error.message);

    const pending = this.inFlight.get(worker);
    this.inFlight.delete(worker);
    if (pending) {
      pending.fail(new Error(`Worker ${workerId} crashed while running ${pending.task.id}: ${error.message}`));
    }

    this.workers = this.workers.filter((w) => w !== worker);
    this.idleWorkers = this.idleWorkers.filter((w) => w !== worker);
    worker.terminate().catch(() => undefined);

    if (this.isShuttingDown) return;

    const maxRestarts = this.config.maxWorkerRestarts ?? ParallelDefaultConfig.MAX_WORKER_RESTARTS;
    if (this.workerRestarts >= maxRestarts) {
      console.error(`❌ Worker restart limit (${maxRestarts}) reached; pool degraded to ${this.workers.length} workers`);
      return;
    }
    this.workerRestarts++;

    this.createWorker(this.workerPath, this.workerExecArgv, this.nextWorkerId++)
      .then((replacement) => {
        if (this.isShuttingDown) {
          replacement.terminate().catch(() => undefined);
          return;
        }
        this.workers.push(replacement);
        console.warn(`🔁 Worker ${workerId} replaced (restart ${this.workerRestarts})`);
        this.assignNextOrIdle(replacement);
      })
      .catch((spawnError) => {
        console.error(`❌ Failed to respawn worker:`, spawnError);
      });
  }

  private recordTask(taskResult: TaskResult): void {
    const maxCompletedTasks =
      this.config.maxCompletedTasks ?? ParallelDefaultConfig.MAX_COMPLETED_TASKS;
    if (this.completedTasks.length >= maxCompletedTasks) {
      this.completedTasks.shift(); // Remove oldest task (FIFO)
    }
    this.completedTasks.push(taskResult);
  }

  /**
   * Process large datasets in parallel chunks
   * Good for: Big data processing, batch operations
   * Why: Combines parallel processing with memory management
   */
  async executeChunkedParallel<T>(
    data: T[],
    taskType: string = "batch-compute"
  ): Promise<unknown[]> {
    console.warn(
      `📊 Processing ${data.length} items in parallel chunks of ${this.config.chunkSize}`
    );

    const chunks: T[][] = [];

    // Split data into chunks
    for (let i = 0; i < data.length; i += this.config.chunkSize!) {
      chunks.push(data.slice(i, i + this.config.chunkSize!));
    }

    console.warn(`📦 Created ${chunks.length} chunks for parallel processing`);

    // Process chunks in parallel
    const chunkResults = await this.executeParallel(chunks, taskType);

    // Flatten results
    const flatResults = chunkResults.flat();
    console.warn(`🎯 Chunked parallel processing completed: ${flatResults.length} results`);

    return flatResults;
  }

  /**
   * Current number of in-flight or queued tasks (monitoring/backpressure).
   */
  getActiveTaskCount(): number {
    return this.activeTasksCount;
  }

  /** Number of tasks waiting for a free worker. */
  getQueuedTaskCount(): number {
    return this.taskQueue.length;
  }

  /** Number of live workers in the pool. */
  getWorkerCount(): number {
    return this.workers.length;
  }

  /** Number of workers currently idle and ready for a task. */
  getIdleWorkerCount(): number {
    return this.idleWorkers.length;
  }

  /**
   * Get performance metrics
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
      concurrencyLevel: this.config.workerCount ?? 0,
      throughput:
        completedTasksCount > 0 && totalExecutionTime > 0
          ? (completedTasksCount / totalExecutionTime) * ParallelDefaultConfig.MS_PER_SECOND
          : 0,
    };
  }

  /**
   * Cleanup workers and resources
   * Important: Always call this when done to prevent memory leaks
   */
  async cleanup(): Promise<void> {
    this.isShuttingDown = true;
    console.warn(`🧹 Cleaning up ${this.workers.length} workers`);

    // Reject anything still waiting for a worker
    const queued = this.taskQueue.splice(0, this.taskQueue.length);
    for (const pending of queued) {
      pending.fail(new Error(`Pool shutting down; task ${pending.task.id} was not executed`));
    }

    const terminationPromises = this.workers.map((worker, index) => {
      return new Promise<void>((resolvePromise) => {
        const shutdownTimeout = setTimeout(async () => {
          try {
            await worker.terminate();
            console.warn(`✅ Worker ${index} terminated`);
          } catch (error) {
            console.error(`❌ Error terminating worker ${index}:`, error);
          } finally {
            resolvePromise();
          }
        }, ParallelDefaultConfig.SHUTDOWN_WAIT_MS);

        worker.once("exit", () => {
          clearTimeout(shutdownTimeout);
          console.warn(`✅ Worker ${index} exited`);
          resolvePromise();
        });

        worker.postMessage({ type: "shutdown" });
      });
    });

    await Promise.all(terminationPromises);
    this.workers = [];
    this.idleWorkers = [];
    this.inFlight.clear();
    this.isShuttingDown = false;
    this.workerRestarts = 0;
    console.warn(`🎉 All workers cleaned up`);
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
