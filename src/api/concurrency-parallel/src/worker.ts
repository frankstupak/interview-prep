/**
 * Worker Thread Script for Parallel Processing
 *
 * This worker handles CPU-intensive tasks in a separate thread,
 * enabling true parallelism for computational work.
 *
 * Key concepts:
 * - Worker threads have their own V8 context and memory space
 * - Communication happens via message passing (postMessage/on('message'))
 * - Workers are ideal for CPU-bound tasks, not I/O-bound tasks
 * - Each worker runs independently and can utilize a separate CPU core
 */

import { parentPort, workerData } from "worker_threads";

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

// Ensure we're running in a worker thread
if (!parentPort) {
  throw new Error("This script must be run as a worker thread");
}

const workerId = workerData?.workerId || "unknown";

console.warn(`👷 Worker ${workerId} starting up`);

// Signal that worker is ready to receive tasks
parentPort.postMessage({ type: "ready", workerId });

// Listen for tasks from the main thread
type WorkerMessage = WorkerTask | { type: "shutdown" };

const isWorkerTask = (task: WorkerMessage): task is WorkerTask => {
  return (task as WorkerTask).id !== undefined;
};

parentPort.on("message", async (task: WorkerMessage) => {
  if (task.type === "shutdown") {
    parentPort?.close();
    process.exit(0);
    return;
  }

  if (!isWorkerTask(task)) {
    return;
  }

  const startTime = Date.now();

  console.warn(`🔧 Worker ${workerId} processing task ${task.id} of type ${task.type}`);

  try {
    let result: unknown;

    // Handle different task types
    const data = task.data as Record<string, unknown>;
    switch (task.type) {
      case "compute":
        result = await computeIntensive(task.data as Record<string, unknown>);
        break;
      case "batch-compute":
        result = await processBatch(Array.isArray(task.data) ? task.data : []);
        break;
      case "fibonacci":
        result = await calculateFibonacci(data.n as number);
        break;
      case "prime-check":
        result = await isPrime((data as { number: number }).number);
        break;
      case "matrix-multiply":
        result = await multiplyMatrices(
          (data as { matrixA: number[][] }).matrixA,
          (data as { matrixB: number[][] }).matrixB
        );
        break;
      case "sort-large-array":
        result = await sortLargeArray((data as { array: number[] }).array);
        break;
      default:
        throw new Error(`Unknown task type: ${task.type}`);
    }

    const endTime = Date.now();
    const executionTime = endTime - startTime;

    console.warn(`✅ Worker ${workerId} completed task ${task.id} in ${executionTime}ms`);

    const response: WorkerResult = {
      taskId: task.id,
      result,
      executionTime,
    };

    parentPort!.postMessage(response);
  } catch (error) {
    const endTime = Date.now();
    const executionTime = endTime - startTime;

    console.error(`❌ Worker ${workerId} failed task ${task.id}:`, error);

    const response: WorkerResult = {
      taskId: task.id,
      result: null,
      error: error instanceof Error ? error.message : String(error),
      executionTime,
    };

    parentPort!.postMessage(response);
  }
});

/**
 * CPU-intensive computation example
 * Simulates heavy mathematical operations
 */
async function computeIntensive(data: Record<string, unknown>): Promise<{
  computed: number;
  iterations: number;
  input: Record<string, unknown>;
  workerId: string | number;
}> {
  const iterations = (data.iterations as number) || 1000000;
  let result = 0;

  // Simulate complex mathematical computation
  for (let i = 0; i < iterations; i++) {
    result += Math.sqrt(i) * Math.sin(i) * Math.cos(i);

    // Yield control occasionally to prevent blocking
    if (i % 100000 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  return {
    computed: result,
    iterations,
    input: data,
    workerId: workerId as string | number,
  };
}

/**
 * Batch processing example
 * Processes arrays of data with transformations
 */
async function processBatch(dataArray: unknown[]): Promise<unknown[]> {
  console.warn(`📊 Processing batch of ${dataArray.length} items`);

  return dataArray.map((item, index) => {
    // Simulate some processing on each item
    const base = typeof item === "object" && item !== null ? (item as Record<string, unknown>) : {};
    const processed = {
      ...base,
      processed: true,
      processedAt: Date.now(),
      processedBy: workerId,
      index,
      // Add some computed properties
      hash: simpleHash(JSON.stringify(item)),
      size: JSON.stringify(item).length,
    };

    return processed;
  });
}

/**
 * Fibonacci calculation via fast doubling — O(log n) instead of the naive
 * O(2^n) recursion. fib(45) alone took multi-second CPU time recursively;
 * fast doubling answers any n <= 50 in microseconds and is exact well past
 * the cap (every fib(n) for n <= 78 fits in a double-precision integer).
 * Identities: fib(2k) = fib(k) * (2*fib(k+1) - fib(k));
 *             fib(2k+1) = fib(k)^2 + fib(k+1)^2.
 */
async function calculateFibonacci(n: number): Promise<{ result: number; n: number }> {
  if (n < 0) throw new Error("Fibonacci not defined for negative numbers");
  if (n > 50) throw new Error("Fibonacci calculation too large (max 50)");

  function fibPair(k: number): [number, number] {
    // Returns [fib(k), fib(k+1)]
    if (k === 0) return [0, 1];
    const [a, b] = fibPair(Math.floor(k / 2));
    const c = a * (2 * b - a);
    const d = a * a + b * b;
    return k % 2 === 0 ? [c, d] : [d, c + d];
  }

  const [result] = fibPair(n);

  return { result, n };
}

/**
 * Prime number checking
 * CPU-intensive for large numbers
 */
async function isPrime(
  number: number
): Promise<{ isPrime: boolean; number: number; factors?: number[] }> {
  if (number < 2) return { isPrime: false, number };
  if (number === 2) return { isPrime: true, number };
  if (number % 2 === 0) return { isPrime: false, number, factors: [2, number / 2] };

  const factors: number[] = [];
  const sqrt = Math.sqrt(number);

  for (let i = 3; i <= sqrt; i += 2) {
    if (number % i === 0) {
      factors.push(i, number / i);
      return { isPrime: false, number, factors };
    }

    // Yield control for very large numbers
    if (i % 10000 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  return { isPrime: true, number };
}

/**
 * Matrix multiplication
 * CPU-intensive for large matrices
 */
async function multiplyMatrices(matrixA: number[][], matrixB: number[][]): Promise<number[][]> {
  const rowsA = matrixA.length;
  const colsA = matrixA[0].length;
  const rowsB = matrixB.length;
  const colsB = matrixB[0].length;

  if (colsA !== rowsB) {
    throw new Error("Matrix dimensions incompatible for multiplication");
  }

  const result: number[][] = Array(rowsA)
    .fill(null)
    .map(() => Array(colsB).fill(0));

  for (let i = 0; i < rowsA; i++) {
    for (let j = 0; j < colsB; j++) {
      for (let k = 0; k < colsA; k++) {
        result[i][j] += matrixA[i][k] * matrixB[k][j];
      }
    }

    // Yield control for large matrices
    if (i % 100 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  return result;
}

/**
 * Sort large array using merge sort
 * CPU-intensive for very large arrays
 */
async function sortLargeArray(
  array: number[]
): Promise<{ sorted: number[]; originalLength: number }> {
  console.warn(`🔢 Sorting array of ${array.length} elements`);

  function mergeSort(arr: number[]): number[] {
    if (arr.length <= 1) return arr;

    const mid = Math.floor(arr.length / 2);
    const left = mergeSort(arr.slice(0, mid));
    const right = mergeSort(arr.slice(mid));

    return merge(left, right);
  }

  function merge(left: number[], right: number[]): number[] {
    const result: number[] = [];
    let leftIndex = 0;
    let rightIndex = 0;

    while (leftIndex < left.length && rightIndex < right.length) {
      if (left[leftIndex] <= right[rightIndex]) {
        result.push(left[leftIndex]);
        leftIndex++;
      } else {
        result.push(right[rightIndex]);
        rightIndex++;
      }
    }

    return result.concat(left.slice(leftIndex)).concat(right.slice(rightIndex));
  }

  const sorted = mergeSort([...array]); // Create copy to avoid mutating original

  return {
    sorted,
    originalLength: array.length,
  };
}

/**
 * Simple hash function for demonstration
 */
function simpleHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash;
}

// Handle worker termination gracefully
process.on("SIGTERM", () => {
  console.warn(`👋 Worker ${workerId} shutting down gracefully`);
  process.exit(0);
});

process.on("SIGINT", () => {
  console.warn(`👋 Worker ${workerId} interrupted, shutting down`);
  process.exit(0);
});

console.warn(`✅ Worker ${workerId} ready and listening for tasks`);
