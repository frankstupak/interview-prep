// Uplift regression tests — Lumen Industries
// Covers: heartbeat liveness (app-level PONG, protocol pong, activity refresh,
// dead-socket termination), rate limiting of built-in handlers, timing-safe
// auth, /api/history offset coercion, honest room-membership returns,
// single-serialization broadcasts, Socket.IO structured delivery, and
// messages-per-second accounting.

import { WebSocketManager } from "./websocket-manager";
import { AdvancedWebSocketServer } from "./advanced-websocket-server";
import { BasicWebSocketServer } from "./basic-websocket-server";
import type { WebSocketConfig, AnyMessage } from "./types";

class FakeRawSocket {
  public messages: string[] = [];
  public pings = 0;
  public terminated = false;
  public readyState = 1; // OPEN
  private listeners = new Map<string, Array<() => void>>();

  send(data: string): void {
    this.messages.push(data);
  }

  ping(): void {
    this.pings++;
  }

  terminate(): void {
    this.terminated = true;
  }

  on(event: string, listener: () => void): void {
    const list = this.listeners.get(event) || [];
    list.push(listener);
    this.listeners.set(event, list);
  }

  emitEvent(event: string): void {
    this.listeners.get(event)?.forEach((listener) => listener());
  }

  last(): AnyMessage | null {
    const raw = this.messages[this.messages.length - 1];
    return raw ? (JSON.parse(raw) as AnyMessage) : null;
  }
}

class FakeSocketIOSocket {
  public emitted: Array<{ event: string; data: unknown }> = [];
  public sent: string[] = [];
  public nsp = { name: "/" };

  emit(event: string, data: unknown): void {
    this.emitted.push({ event, data });
  }

  // Socket.IO sockets DO have a send() method — this is exactly why the old
  // `if (socket.send)` type check misrouted them down the raw-WebSocket path.
  send(data: string): void {
    this.sent.push(data);
  }
}

const baseConfig: WebSocketConfig = {
  port: 0,
  host: "127.0.0.1",
  pingInterval: 1000,
  pingTimeout: 2000,
  maxConnections: 100,
  enableCompression: false,
  enableCors: false,
};

const msg = (type: string, payload: AnyMessage["payload"] = {}): AnyMessage => ({
  id: `id-${Math.random()}`,
  type,
  payload,
  timestamp: Date.now(),
});

describe("Uplift: heartbeat liveness", () => {
  let manager: WebSocketManager;

  beforeEach(() => {
    manager = new WebSocketManager(baseConfig);
  });

  afterEach(() => {
    manager.destroy();
  });

  test("application-level pong refreshes lastPing", async () => {
    const socket = new FakeRawSocket();
    const client = await manager.addClient(socket as never, {});
    client.lastPing = Date.now() - 10_000;

    await manager.handleMessage(client.id, JSON.stringify(msg("pong", { timestamp: 1 })));

    expect(Date.now() - client.lastPing).toBeLessThan(1000);
  });

  test("protocol-level pong frame refreshes lastPing (browser auto-reply path)", async () => {
    const socket = new FakeRawSocket();
    const client = await manager.addClient(socket as never, {});
    client.lastPing = Date.now() - 10_000;

    socket.emitEvent("pong");

    expect(Date.now() - client.lastPing).toBeLessThan(1000);
  });

  test("any inbound message refreshes lastPing", async () => {
    const socket = new FakeRawSocket();
    const client = await manager.addClient(socket as never, {});
    client.lastPing = Date.now() - 10_000;

    await manager.handleMessage(client.id, JSON.stringify(msg("chat", { text: "hi" })));

    expect(Date.now() - client.lastPing).toBeLessThan(1000);
  });

  test("ping reply echoes the client's payload for RTT measurement", async () => {
    const socket = new FakeRawSocket();
    const client = await manager.addClient(socket as never, {});

    await manager.handleMessage(client.id, JSON.stringify(msg("ping", { timestamp: 12345 })));

    const reply = socket.last();
    expect(reply?.type).toBe("pong");
    expect((reply?.payload as { timestamp?: number }).timestamp).toBeDefined();
  });

  test("heartbeat sweep terminates dead sockets and keeps responsive ones", async () => {
    // The manager skips its interval under Jest; build one with the guard off.
    const savedWorkerId = process.env.JEST_WORKER_ID;
    const savedNodeEnv = process.env.NODE_ENV;
    delete process.env.JEST_WORKER_ID;
    process.env.NODE_ENV = "production";
    jest.useFakeTimers();

    const sweepManager = new WebSocketManager(baseConfig);
    process.env.JEST_WORKER_ID = savedWorkerId;
    process.env.NODE_ENV = savedNodeEnv;

    try {
      const deadSocket = new FakeRawSocket();
      const liveSocket = new FakeRawSocket();
      const dead = await sweepManager.addClient(deadSocket as never, {});
      const live = await sweepManager.addClient(liveSocket as never, {});

      dead.lastPing = Date.now() - 10_000; // way past pingTimeout=2000
      live.lastPing = Date.now();

      jest.advanceTimersByTime(1100); // one sweep

      expect(deadSocket.terminated).toBe(true);
      expect(sweepManager.hasClient(dead.id)).toBe(false);
      expect(liveSocket.terminated).toBe(false);
      expect(sweepManager.hasClient(live.id)).toBe(true);
      // Live client got both a protocol ping and an app-level ping.
      expect(liveSocket.pings).toBeGreaterThanOrEqual(1);
      expect(liveSocket.last()?.type).toBe("ping");
    } finally {
      sweepManager.destroy();
      jest.useRealTimers();
    }
  });
});

describe("Uplift: delivery correctness and performance", () => {
  let manager: WebSocketManager;

  beforeEach(() => {
    manager = new WebSocketManager(baseConfig);
  });

  afterEach(() => {
    manager.destroy();
  });

  test("broadcast serializes the message exactly once", async () => {
    const sockets = Array.from({ length: 25 }, () => new FakeRawSocket());
    for (const socket of sockets) {
      await manager.addClient(socket as never, {});
    }

    const stringifySpy = jest.spyOn(JSON, "stringify");
    stringifySpy.mockClear();

    manager.broadcast(msg("broadcast_message", { blob: "x".repeat(512) }));

    expect(stringifySpy).toHaveBeenCalledTimes(1);
    stringifySpy.mockRestore();

    for (const socket of sockets) {
      expect(socket.messages).toHaveLength(1);
    }
    // Every recipient received the identical serialized frame.
    expect(new Set(sockets.map((socket) => socket.messages[0])).size).toBe(1);
  });

  test("room broadcast serializes once and respects exclusion", async () => {
    const sockets = Array.from({ length: 5 }, () => new FakeRawSocket());
    const clients = [];
    for (const socket of sockets) {
      clients.push(await manager.addClient(socket as never, {}));
    }
    for (const client of clients) {
      await manager.addClientToRoom(client.id, "arena");
    }
    sockets.forEach((socket) => (socket.messages = []));

    const stringifySpy = jest.spyOn(JSON, "stringify");
    stringifySpy.mockClear();
    manager.broadcastToRoom("arena", msg("room_message", { room: "arena" }), clients[0].id);
    expect(stringifySpy).toHaveBeenCalledTimes(1);
    stringifySpy.mockRestore();

    expect(sockets[0].messages).toHaveLength(0);
    for (const socket of sockets.slice(1)) {
      expect(socket.messages).toHaveLength(1);
    }
  });

  test("Socket.IO clients receive structured emit, not a JSON string", async () => {
    const socket = new FakeSocketIOSocket();
    const client = await manager.addClient(socket as never, {});

    const message = msg("notification", { ok: true });
    const result = manager.sendToClient(client.id, message);

    expect(result).toBe(true);
    expect(socket.sent).toHaveLength(0); // raw path NOT used
    expect(socket.emitted).toHaveLength(1);
    expect(socket.emitted[0].event).toBe("message");
    expect(socket.emitted[0].data).toEqual(message);
  });

  test("sendToClient refuses non-OPEN raw sockets instead of throwing", async () => {
    const socket = new FakeRawSocket();
    socket.readyState = 2; // CLOSING
    const client = await manager.addClient(socket as never, {});

    expect(manager.sendToClient(client.id, msg("chat"))).toBe(false);
    expect(socket.messages).toHaveLength(0);
  });

  test("hasClient reports registration synchronously", async () => {
    const socket = new FakeRawSocket();
    const client = await manager.addClient(socket as never, {});
    expect(manager.hasClient(client.id)).toBe(true);
    expect(manager.hasClient("nope")).toBe(false);
  });

  test("messagesPerSecond reports completed windows and decays when idle", async () => {
    jest.useFakeTimers();
    try {
      const socket = new FakeRawSocket();
      const timedManager = new WebSocketManager(baseConfig);
      const client = await timedManager.addClient(socket as never, {});

      for (let i = 0; i < 5; i++) {
        await timedManager.handleMessage(client.id, JSON.stringify(msg("chat")));
      }
      jest.advanceTimersByTime(1001);
      await timedManager.handleMessage(client.id, JSON.stringify(msg("chat")));
      expect(timedManager.getStats().messagesPerSecond).toBe(5);

      jest.advanceTimersByTime(5000);
      expect(timedManager.getStats().messagesPerSecond).toBe(0);
      timedManager.destroy();
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("Uplift: onBeforeMessage gate", () => {
  test("vetoed messages skip built-in handlers and onMessage", async () => {
    const onMessage = jest.fn();
    const manager = new WebSocketManager(baseConfig, {
      onBeforeMessage: (): boolean => false,
      onMessage,
    });
    const senderSocket = new FakeRawSocket();
    const receiverSocket = new FakeRawSocket();
    const sender = await manager.addClient(senderSocket as never, {});
    const receiver = await manager.addClient(receiverSocket as never, {});

    // Pre-seed the room directly (addClientToRoom is not a message).
    await manager.addClientToRoom(sender.id, "arena");
    await manager.addClientToRoom(receiver.id, "arena");
    receiverSocket.messages = [];

    await manager.handleMessage(
      sender.id,
      JSON.stringify(msg("room_message", { room: "arena", data: "flood" }))
    );

    expect(receiverSocket.messages).toHaveLength(0); // built-in broadcast blocked
    expect(onMessage).not.toHaveBeenCalled();
    manager.destroy();
  });
});

describe("Uplift: AdvancedWebSocketServer", () => {
  test("rate limit gates built-in room broadcasts, not just onMessage", async () => {
    const server = new AdvancedWebSocketServer({
      enableRateLimit: true,
      rateLimitRequests: 1,
      rateLimitWindow: 60_000,
      enableMessageHistory: false,
      enablePresence: false,
      enableAuth: false,
    });
    const manager = (server as unknown as { manager: WebSocketManager }).manager;

    const senderSocket = new FakeRawSocket();
    const receiverSocket = new FakeRawSocket();
    const sender = await manager.addClient(senderSocket as never, {});
    const receiver = await manager.addClient(receiverSocket as never, {});
    await manager.addClientToRoom(sender.id, "arena");
    await manager.addClientToRoom(receiver.id, "arena");
    receiverSocket.messages = [];
    senderSocket.messages = [];

    // First room message: within limit, must reach the room.
    await manager.handleMessage(
      sender.id,
      JSON.stringify(msg("room_message", { room: "arena", data: "one" }))
    );
    expect(receiverSocket.messages).toHaveLength(1);

    // Second: over limit — previously built-ins ran BEFORE the rate-limit
    // hook, so this flood still reached every room member.
    await manager.handleMessage(
      sender.id,
      JSON.stringify(msg("room_message", { room: "arena", data: "two" }))
    );
    expect(receiverSocket.messages).toHaveLength(1);
    const lastToSender = senderSocket.last();
    expect(lastToSender?.type).toBe("error");
    expect((lastToSender?.payload as { code?: string }).code).toBe("RATE_LIMIT");

    await server.stop();
    manager.destroy();
  });

  test("auth rejects arbitrary Bearer tokens and accepts configured ones", () => {
    const server = new AdvancedWebSocketServer({
      enableAuth: true,
      authTokens: ["s3cret"],
      enableRateLimit: false,
      enableMessageHistory: false,
      enablePresence: false,
    });
    const validate = (
      server as unknown as { validateToken: (token: string) => boolean }
    ).validateToken.bind(server);

    expect(validate("Bearer anything-at-all")).toBe(false); // the old bypass
    expect(validate("Bearer s3cret")).toBe(true);
    expect(validate("s3cret")).toBe(true);
    expect(validate("wrong")).toBe(false);
    expect(validate("")).toBe(false);
    void server.stop();
  });

  test("GET /api/history?offset=0 returns messages (string query params)", async () => {
    const server = new AdvancedWebSocketServer({
      enableMessageHistory: true,
      maxHistorySize: 10,
      enableRateLimit: false,
      enablePresence: false,
    });
    const serverAny = server as unknown as {
      app: { inject: (options: object) => Promise<{ json: () => { messages: unknown[]; total: number } }> };
      addToHistory: (message: AnyMessage, room?: string) => void;
    };
    serverAny.addToHistory({ id: "1", type: "chat", payload: {}, timestamp: 1 }, "room-1");
    serverAny.addToHistory({ id: "2", type: "chat", payload: {}, timestamp: 2 }, "room-1");

    // Over real HTTP, query params are strings. offset="0" is truthy, and the
    // old slice produced (-limit, -0) === (-limit, 0) — always an empty page.
    const response = await serverAny.app.inject({
      method: "GET",
      url: "/api/history?room=room-1&limit=50&offset=0",
    });
    const body = response.json();
    expect(body.total).toBe(2);
    expect(body.messages).toHaveLength(2);

    await server.stop();
  });

  test("addClientToRoom returns false for unknown clients", () => {
    const server = new AdvancedWebSocketServer({
      enableRateLimit: false,
      enableMessageHistory: false,
      enablePresence: false,
    });
    expect(server.addClientToRoom("ghost", "arena")).toBe(false);
    expect(server.removeClientFromRoom("ghost", "arena")).toBe(false);
    void server.stop();
  });
});

describe("Uplift: BasicWebSocketServer", () => {
  test("room membership returns are honest", () => {
    const server = new BasicWebSocketServer(baseConfig);
    expect(server.addClientToRoom("ghost", "arena")).toBe(false);
    expect(server.removeClientFromRoom("ghost", "arena")).toBe(false);
  });
});
