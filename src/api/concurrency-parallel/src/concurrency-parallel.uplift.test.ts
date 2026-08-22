/**
 * Uplift tests — timeout/retry/abort policy, fail-fast semantics, settled
 * execution, pull-based worker dispatch, crash recovery, backpressure, and
 * the fast-doubling fibonacci.
 */

import { ConcurrencyManager } from "./concurrency-manager";
import { ParallelManager } from "./parallel-manager";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("ConcurrencyManager policy (timeout / retries / abort)", () => {
  it("enforces the configured per-task timeout", async () => {
    const manager = new ConcurrencyManager({ maxConcurrent: 2, timeout: 100 });
    const tasks = [{ id: 1, delay: 500 }];
    const processor = async (t: { id: number; delay: number }): Promise<number> => {
      await sleep(t.delay);
      return t.id;
    };
    await expect(manager.executeAllConcurrent(tasks, processor)).rejects.toThrow(
      /timed out after 100ms/
    );
  });

  it("does not time out tasks that finish within the limit", async () => {
    const manager = new ConcurrencyManager({ maxConcurrent: 2, timeout: 500 });
    const results = await manager.executeAllConcurrent([{ id: 1, delay: 50 }], async (t) => {
      await sleep(t.delay);
      return t.id;
    });
    expect(results).toEqual([1]);
  });

  it("retries failed tasks up to the configured count", async () => {
    const manager = new ConcurrencyManager({ maxConcurrent: 1, retries: 2 });
    let attempts = 0;
    const results = await manager.executeLimitedConcurrent([{ id: 1 }], async () => {
      attempts++;
      if (attempts < 3) throw new Error("flaky");
      return "ok";
    });
    expect(results).toEqual(["ok"]);
    expect(attempts).toBe(3);
  });

  it("propagates the error once retries are exhausted", async () => {
    const manager = new ConcurrencyManager({ maxConcurrent: 1, retries: 1 });
    let attempts = 0;
    await expect(
      manager.executeLimitedConcurrent([{ id: 1 }], async () => {
        attempts++;
        throw new Error("always fails");
      })
    ).rejects.toThrow("always fails");
    expect(attempts).toBe(2); // initial attempt + 1 retry
  });

  it("retries timeouts too", async () => {
    const manager = new ConcurrencyManager({ maxConcurrent: 1, timeout: 80, retries: 1 });
    let attempts = 0;
    const results = await manager.executeSequential([{ id: 1 }], async () => {
      attempts++;
      if (attempts === 1) await sleep(300); // first attempt times out
      return "recovered";
    });
    expect(results).toEqual(["recovered"]);
    expect(attempts).toBe(2);
  });

  it("stops starting new tasks after an AbortSignal fires", async () => {
    const controller = new AbortController();
    const manager = new ConcurrencyManager({ maxConcurrent: 1, signal: controller.signal });
    let processed = 0;
    const tasks = Array.from({ length: 10 }, (_, i) => ({ id: i }));

    const run = manager.executeLimitedConcurrent(tasks, async () => {
      processed++;
      if (processed === 2) controller.abort();
      await sleep(20);
      return processed;
    });

    await expect(run).rejects.toThrow();
    expect(processed).toBeLessThan(10);
  });
});

describe("ConcurrencyManager fail-fast semantics", () => {
  it("stops other lanes from pulling new tasks after a failure", async () => {
    const manager = new ConcurrencyManager({ maxConcurrent: 2 });
    const started: number[] = [];
    const tasks = Array.from({ length: 20 }, (_, i) => ({ id: i }));

    const run = manager.executeLimitedConcurrent(tasks, async (t) => {
      started.push(t.id);
      await sleep(10);
      if (t.id === 1) throw new Error("boom");
      return t.id;
    });

    await expect(run).rejects.toThrow("boom");
    // Give any stray lanes time to (incorrectly) continue
    await sleep(150);
    // Previously all 20 tasks would run despite the rejection; now the other
    // lane stops after the in-flight task it already started.
    expect(started.length).toBeLessThanOrEqual(4);
  });
});

describe("ConcurrencyManager.executeAllSettled", () => {
  it("returns per-task outcomes without failing fast", async () => {
    const manager = new ConcurrencyManager({ maxConcurrent: 3 });
    const tasks = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const outcomes = await manager.executeAllSettled(tasks, async (t) => {
      if (t.id === 2) throw new Error("task 2 failed");
      return t.id * 10;
    });

    expect(outcomes).toHaveLength(3);
    expect(outcomes[0]).toMatchObject({ status: "fulfilled", value: 10, taskIndex: 0 });
    expect(outcomes[1].status).toBe("rejected");
    expect(outcomes[2]).toMatchObject({ status: "fulfilled", value: 30, taskIndex: 2 });
  });
});

describe("ConcurrencyManager bounded metrics memory", () => {
  it("caps completedTasks at maxCompletedTasks", async () => {
    const manager = new ConcurrencyManager({ maxConcurrent: 5, maxCompletedTasks: 10 });
    const tasks = Array.from({ length: 50 }, (_, i) => ({ id: i }));
    await manager.executeAllConcurrent(tasks, async (t) => t.id);
    expect(manager.getPerformanceMetrics().totalTasks).toBe(10);
  });

  it("reports zero active tasks after completion", async () => {
    const manager = new ConcurrencyManager({ maxConcurrent: 3 });
    await manager.executeAllConcurrent([{ id: 1 }, { id: 2 }], async (t) => t.id);
    expect(manager.getActiveTaskCount()).toBe(0);
  });
});

describe("ParallelManager pull-based dispatch", () => {
  let manager: ParallelManager;

  afterEach(async () => {
    await manager.cleanup();
  });

  it("routes queued short tasks to whichever worker is free (no head-of-line blocking)", async () => {
    manager = new ParallelManager({ workerCount: 2, timeout: 60000 });
    await manager.initializeWorkers();

    // One long task and three short ones. Eager round-robin pinned tasks
    // 0/2 to worker A and 1/3 to worker B, so a short task queued behind the
    // long one waited for it even while the other worker idled. Pull-based
    // dispatch sends every short task to the free worker.
    const tasks = [
      { iterations: 30_000_000 }, // long
      { iterations: 10_000 }, // short
      { iterations: 10_000 }, // short
      { iterations: 10_000 }, // short
    ];

    const results = (await manager.executeParallel(tasks, "compute")) as {
      workerId: number;
      input: { iterations: number };
    }[];

    expect(results).toHaveLength(4);
    const longWorker = results[0].workerId;
    const shortWorkers = results.slice(1).map((r) => r.workerId);
    // All three shorts completed on the worker NOT running the long task.
    expect(shortWorkers.every((w) => w !== longWorker)).toBe(true);
  }, 60000);

  it("keeps task accounting balanced (active count returns to zero)", async () => {
    manager = new ParallelManager({ workerCount: 2, timeout: 30000 });
    await manager.initializeWorkers();
    await manager.executeParallel([{ n: 10 }, { n: 12 }, { n: 15 }], "fibonacci");
    expect(manager.getActiveTaskCount()).toBe(0);
    expect(manager.getQueuedTaskCount()).toBe(0);
  }, 30000);

  it("recovers after a task timeout: late result is discarded and the worker rejoins", async () => {
    manager = new ParallelManager({ workerCount: 1, timeout: 300 });
    await manager.initializeWorkers();

    await expect(
      manager.executeParallel([{ iterations: 20_000_000 }], "compute")
    ).rejects.toThrow(/timed out/);

    // The single worker is still crunching the timed-out task. Wait for its
    // late result to arrive and be discarded, returning the worker to idle.
    const deadline = Date.now() + 30000;
    while (manager.getIdleWorkerCount() < 1 && Date.now() < deadline) {
      await sleep(100);
    }
    expect(manager.getIdleWorkerCount()).toBe(1);
    expect(manager.getQueuedTaskCount()).toBe(0);

    const results = (await manager.executeParallel([{ n: 10 }], "fibonacci")) as {
      result: number;
    }[];
    expect(results[0].result).toBe(55);
  }, 60000);

  it("applies backpressure when maxPendingTasks is exceeded", async () => {
    manager = new ParallelManager({ workerCount: 1, timeout: 60000, maxPendingTasks: 1 });
    await manager.initializeWorkers();

    const long = { iterations: 30_000_000 };
    const settled = await Promise.allSettled([
      manager.executeParallel([long], "compute"), // occupies the worker
      manager.executeParallel([long], "compute"), // queued (1/1)
      manager.executeParallel([long], "compute"), // rejected: queue full
    ]);

    const rejected = settled.filter((s) => s.status === "rejected");
    expect(rejected.length).toBe(1);
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/queue full/i);
  }, 120000);
});

describe("ParallelManager worker crash recovery", () => {
  it("fails the in-flight task loudly and respawns a replacement worker", async () => {
    const { writeFileSync, mkdtempSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");

    // Minimal crash-capable worker: 'crash' exits non-zero mid-task,
    // anything else echoes back.
    const dir = mkdtempSync(join(tmpdir(), "crash-worker-"));
    const crashWorkerPath = join(dir, "crash-worker.js");
    writeFileSync(
      crashWorkerPath,
      `
      const { parentPort, workerData } = require("worker_threads");
      parentPort.postMessage({ type: "ready", workerId: workerData?.workerId });
      parentPort.on("message", (task) => {
        if (task.type === "shutdown") process.exit(0);
        if (task.type === "crash") process.exit(1);
        parentPort.postMessage({ taskId: task.id, result: { echoed: task.data }, executionTime: 1 });
      });
      `
    );

    const manager = new ParallelManager({ workerCount: 1, timeout: 10000 });
    await manager.initializeWorkers(crashWorkerPath);

    await expect(manager.executeParallel([{ boom: true }], "crash")).rejects.toThrow(/crashed/);

    // Respawned replacement should serve subsequent tasks.
    const deadline = Date.now() + 10000;
    while (manager.getWorkerCount() < 1 && Date.now() < deadline) {
      await sleep(100);
    }
    expect(manager.getWorkerCount()).toBe(1);
    const results = (await manager.executeParallel([{ hello: "world" }], "echo")) as {
      echoed: { hello: string };
    }[];
    expect(results[0].echoed.hello).toBe("world");

    await manager.cleanup();
  }, 30000);

  it("uses an explicitly provided worker script when it exists", async () => {
    const { writeFileSync, mkdtempSync } = await import("fs");
    const { tmpdir } = await import("os");
    const { join } = await import("path");

    const dir = mkdtempSync(join(tmpdir(), "custom-worker-"));
    const customPath = join(dir, "custom-worker.js");
    writeFileSync(
      customPath,
      `
      const { parentPort, workerData } = require("worker_threads");
      parentPort.postMessage({ type: "ready", workerId: workerData?.workerId });
      parentPort.on("message", (task) => {
        if (task.type === "shutdown") process.exit(0);
        parentPort.postMessage({ taskId: task.id, result: "custom-worker-response", executionTime: 1 });
      });
      `
    );

    const manager = new ParallelManager({ workerCount: 1, timeout: 10000 });
    // Previously this argument was silently ignored whenever dist/worker.js existed.
    await manager.initializeWorkers(customPath);
    const results = await manager.executeParallel([{}], "anything");
    expect(results[0]).toBe("custom-worker-response");
    await manager.cleanup();
  }, 30000);
});

describe("Worker fibonacci (fast doubling)", () => {
  let manager: ParallelManager;

  beforeAll(async () => {
    manager = new ParallelManager({ workerCount: 1, timeout: 15000 });
    await manager.initializeWorkers();
  }, 30000);

  afterAll(async () => {
    await manager.cleanup();
  });

  it("returns exact values across the supported range", async () => {
    const cases: Array<[number, number]> = [
      [0, 0],
      [1, 1],
      [2, 1],
      [10, 55],
      [30, 832040],
      [45, 1134903170],
      [50, 12586269025],
    ];
    const results = (await manager.executeParallel(
      cases.map(([n]) => ({ n })),
      "fibonacci"
    )) as { result: number; n: number }[];

    for (let i = 0; i < cases.length; i++) {
      expect(results[i].result).toBe(cases[i][1]);
    }
  }, 30000);

  it("computes fib(50) fast (previously minutes of O(2^n) recursion)", async () => {
    const start = Date.now();
    await manager.executeParallel([{ n: 50 }], "fibonacci");
    // Generous bound: includes worker round-trip. Naive recursion took minutes.
    expect(Date.now() - start).toBeLessThan(1000);
  }, 15000);

  it("still rejects invalid inputs", async () => {
    await expect(manager.executeParallel([{ n: -5 }], "fibonacci")).rejects.toThrow(
      /not defined for negative/
    );
    await expect(manager.executeParallel([{ n: 51 }], "fibonacci")).rejects.toThrow(/max 50/);
  }, 15000);
});
