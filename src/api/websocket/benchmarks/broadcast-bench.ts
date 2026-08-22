// Broadcast fan-out benchmark — Lumen Industries uplift PR evidence.
/* eslint-disable no-console -- benchmark output is the deliverable */
// Compares the shipped per-recipient JSON.stringify broadcast loop against the
// uplifted single-serialization broadcast, on identical no-op sockets.
// Run: npx tsx benchmarks/broadcast-bench.ts

import { WebSocketManager } from "../src/backend/websocket-manager";
import type { WebSocketConfig, AnyMessage } from "../src/backend/types";

const CLIENTS = Number(process.env.BENCH_CLIENTS ?? 5000);
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 200);

const config: WebSocketConfig = {
  port: 0,
  host: "127.0.0.1",
  pingInterval: 60_000,
  pingTimeout: 120_000,
  maxConnections: CLIENTS + 10,
  enableCompression: false,
  enableCors: false,
};

class NoopSocket {
  send(_data: string): void {
    // no-op: isolates serialization + dispatch cost from network I/O
  }
}

// Representative chat-style payload, ~1 KB serialized.
const payload = {
  username: "bench-user",
  message: "m".repeat(768),
  room: "arena",
  meta: { seq: 0, tags: ["a", "b", "c"], nested: { depth: { level: 3 } } },
};

const makeMessage = (seq: number): AnyMessage => ({
  id: `bench-${seq}`,
  type: "broadcast_message",
  payload: { ...payload, meta: { ...payload.meta, seq } },
  timestamp: Date.now(),
});

async function main(): Promise<void> {
  process.env.NODE_ENV = "test"; // suppress ping interval

  const manager = new WebSocketManager(config);
  const managerAny = manager as unknown as {
    clients: Map<string, { id: string; socket: NoopSocket; connected: boolean }>;
  };
  for (let i = 0; i < CLIENTS; i++) {
    await manager.addClient(new NoopSocket() as never, {});
  }

  const sampleSerialized = JSON.stringify(makeMessage(0));
  console.log(
    `clients=${CLIENTS} rounds=${ROUNDS} payload=${sampleSerialized.length} bytes serialized`
  );

  // --- Legacy path: stringify once PER RECIPIENT (what 44447fe shipped) ---
  {
    // warmup
    for (let r = 0; r < 10; r++) {
      const message = makeMessage(r);
      for (const client of managerAny.clients.values()) {
        client.socket.send(JSON.stringify(message));
      }
    }
    const start = process.hrtime.bigint();
    for (let r = 0; r < ROUNDS; r++) {
      const message = makeMessage(r);
      for (const client of managerAny.clients.values()) {
        client.socket.send(JSON.stringify(message));
      }
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    const perBroadcastMs = elapsedMs / ROUNDS;
    console.log(
      `legacy per-recipient stringify : ${elapsedMs.toFixed(1)} ms total, ` +
        `${perBroadcastMs.toFixed(3)} ms/broadcast, ` +
        `${((ROUNDS * CLIENTS) / (elapsedMs / 1000)).toFixed(0)} deliveries/s`
    );
  }

  // --- Uplifted path: manager.broadcast (single stringify) ---
  {
    for (let r = 0; r < 10; r++) manager.broadcast(makeMessage(r)); // warmup
    const start = process.hrtime.bigint();
    for (let r = 0; r < ROUNDS; r++) {
      manager.broadcast(makeMessage(r));
    }
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    const perBroadcastMs = elapsedMs / ROUNDS;
    console.log(
      `uplifted single stringify      : ${elapsedMs.toFixed(1)} ms total, ` +
        `${perBroadcastMs.toFixed(3)} ms/broadcast, ` +
        `${((ROUNDS * CLIENTS) / (elapsedMs / 1000)).toFixed(0)} deliveries/s`
    );
  }

  manager.destroy();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
