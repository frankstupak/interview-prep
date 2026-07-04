/**
 * Type definitions for concurrency and parallelism examples
 *
 * Key Concepts:
 * - Concurrency: Multiple tasks making progress, but not necessarily at the same time
 * - Parallelism: Multiple tasks executing simultaneously on different cores/threads
 * - In Node.js: Single-threaded event loop with async I/O (concurrency)
 * - True parallelism achieved through Worker Threads or external processes
 */

export interface Task {
  id: string;
  name: string;
  duration: number; // milliseconds
  priority?: number;
}

export interface TaskResult<T = unknown> {
  taskId: string;
  result: T;
  executionTime: number;
  startTime: number;
  endTime: number;
}

export interface ConcurrencyConfig {
  maxConcurrent: number;
  /** Per-attempt timeout in ms. Attempts exceeding it reject (and are retried if retries > 0). */
  timeout?: number;
  /** Number of extra attempts after a failure/timeout before the error propagates. */
  retries?: number;
  /** Cooperative cancellation: no new tasks start once the signal aborts. */
  signal?: AbortSignal;
  /** Cap on completed-task records kept for metrics (FIFO eviction). Default 1000. */
  maxCompletedTasks?: number;
}

export interface ParallelConfig {
  workerCount?: number;
  timeout?: number;
  chunkSize?: number;
  maxCompletedTasks?: number; // Maximum number of completed tasks to keep in memory
  /** Max tasks allowed to wait for a free worker; submissions beyond it reject (backpressure). Default: unbounded. */
  maxPendingTasks?: number;
  /** Max automatic worker respawns after crashes before giving up. Default 3. */
  maxWorkerRestarts?: number;
}

export interface PerformanceMetrics {
  totalTasks: number;
  totalExecutionTime: number;
  averageTaskTime: number;
  concurrencyLevel: number;
  throughput: number; // tasks per second
}

export type TaskProcessor<T, R> = (task: T) => Promise<R>;

/** Per-task outcome for executeAllSettled (mirrors Promise.allSettled). */
export type SettledTaskResult<R> =
  | { status: "fulfilled"; value: R; taskIndex: number }
  | { status: "rejected"; reason: unknown; taskIndex: number };
export type BatchProcessor<T, R> = (tasks: T[]) => Promise<R[]>;

export interface QueuedTask<T, R = unknown> {
  task: T;
  resolve: (value: R) => void;
  reject: (error: unknown) => void;
  priority: number;
  createdAt: number;
}
