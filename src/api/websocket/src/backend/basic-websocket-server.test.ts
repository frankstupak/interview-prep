// Basic WebSocket Server Tests

import { BasicWebSocketServer } from "./basic-websocket-server";
import WebSocket from "ws";
import type { WebSocketConfig, AnyMessage } from "./types";

describe("BasicWebSocketServer", () => {
  let server: BasicWebSocketServer;
  let config: Partial<WebSocketConfig>;

  beforeEach(() => {
    config = {
      port: 0, // Let OS assign a port to avoid EADDRINUSE when tests run in sequence
      host: "127.0.0.1",
      pingInterval: 5000,
      pingTimeout: 10000,
    };
  });

  const baseUrl = (s: BasicWebSocketServer): string => `http://${config.host}:${s.getPort()}`;
  const wsUrl = (s: BasicWebSocketServer): string => `ws://${config.host}:${s.getPort()}/ws`;

  afterEach(async () => {
    if (server) {
      await server.stop();
    }

    // Clear any timers that might be running
    jest.clearAllTimers();

    // Clear all mocks
    jest.clearAllMocks();
  });

  describe("Server Lifecycle", () => {
    test("should start and stop server successfully", async () => {
      server = new BasicWebSocketServer(config);

      await server.start();
      expect(server["isRunning"]).toBe(true);

      await server.stop();
      expect(server["isRunning"]).toBe(false);
    });

    test("should throw error when starting already running server", async () => {
      server = new BasicWebSocketServer(config);
      await server.start();

      await expect(server.start()).rejects.toThrow("Server is already running");
    });

    test("should not throw when stopping non-running server", async () => {
      server = new BasicWebSocketServer(config);
      await expect(server.stop()).resolves.not.toThrow();
    });
  });

  describe("HTTP Endpoints", () => {
    beforeEach(async () => {
      server = new BasicWebSocketServer(config);
      await server.start();
    });

    test("should respond to health check", async () => {
      const response = await fetch(`${baseUrl(server)}/health`);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe("healthy");
      expect(data.stats).toBeDefined();
      expect(data.timestamp).toBeDefined();
    });

    test("should return stats", async () => {
      const response = await fetch(`${baseUrl(server)}/api/stats`);
      const stats = await response.json();

      expect(response.status).toBe(200);
      expect(stats.totalConnections).toBeDefined();
      expect(stats.activeConnections).toBeDefined();
      expect(stats.totalMessages).toBeDefined();
      expect(stats.uptime).toBeDefined();
    });

    test("should return clients list", async () => {
      const response = await fetch(`${baseUrl(server)}/api/clients`);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
    });

    test("should return rooms list", async () => {
      const response = await fetch(`${baseUrl(server)}/api/rooms`);
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(Array.isArray(data)).toBe(true);
    });

    test("should handle broadcast endpoint", async () => {
      const message: AnyMessage = {
        id: "test-id",
        type: "test",
        payload: { data: "broadcast test" },
        timestamp: Date.now(),
      };

      const response = await fetch(`${baseUrl(server)}/api/broadcast`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });

      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.broadcast).toBe("all");
    });

    test("should validate broadcast message format", async () => {
      const response = await fetch(`${baseUrl(server)}/api/broadcast`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: { payload: "invalid" } }),
      });

      expect(response.status).toBe(400);
      const data = await response.json();
      expect(data.error).toBe("Invalid message format");
    });
  });

  describe("WebSocket Connection", () => {
    let ws: WebSocket;

    beforeEach(async () => {
      server = new BasicWebSocketServer(config);
      await server.start();
    });

    afterEach(async () => {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
        // Wait for the connection to close
        await new Promise((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) {
            resolve(void 0);
          } else {
            ws.on("close", resolve);
          }
        });
      }
    });

    test("should accept WebSocket connections", (done) => {
      ws = new WebSocket(wsUrl(server));

      ws.on("open", () => {
        expect(ws.readyState).toBe(WebSocket.OPEN);
        done();
      });

      ws.on("error", done);
    });

    test("should receive welcome message on connection", (done) => {
      ws = new WebSocket(wsUrl(server));

      ws.on("message", (data) => {
        const message = JSON.parse(data.toString());

        if (message.type === "connect") {
          expect(message.payload.message).toBe("Connected to WebSocket server");
          expect(message.payload.clientId).toBeDefined();
          expect(message.payload.serverTime).toBeDefined();
          done();
        }
      });

      ws.on("error", done);
    });

    test("should handle ping-pong", (done) => {
      ws = new WebSocket(wsUrl(server));

      ws.on("open", () => {
        const pingMessage = {
          id: "test-ping",
          type: "ping",
          payload: {},
          timestamp: Date.now(),
        };

        ws.send(JSON.stringify(pingMessage));
      });

      ws.on("message", (data) => {
        const message = JSON.parse(data.toString());

        if (message.type === "pong") {
          expect(message.payload.timestamp).toBeDefined();
          done();
        }
      });

      ws.on("error", done);
    });

    test("should handle room operations", (done) => {
      ws = new WebSocket(wsUrl(server));

      ws.on("open", () => {
        const joinMessage = {
          id: "test-join",
          type: "join_room",
          payload: { room: "test-room" },
          timestamp: Date.now(),
        };

        ws.send(JSON.stringify(joinMessage));
      });

      ws.on("message", (data) => {
        const message = JSON.parse(data.toString());

        if (message.type === "room_joined") {
          expect(message.payload.room).toBe("test-room");
          expect(message.payload.clientCount).toBe(1);
          done();
        }
      });

      ws.on("error", done);
    });

    test("should handle invalid JSON gracefully", (done) => {
      ws = new WebSocket(wsUrl(server));

      ws.on("open", () => {
        ws.send("invalid json");
      });

      ws.on("message", (data) => {
        const message = JSON.parse(data.toString());

        if (message.type === "error") {
          expect(message.payload.error).toBe("Invalid message format");
          done();
        }
      });

      ws.on("error", done);
    });
  });

  describe("Multi-Client Communication", () => {
    let ws1: WebSocket;
    let ws2: WebSocket;

    beforeEach(async () => {
      server = new BasicWebSocketServer(config);
      await server.start();
    });

    afterEach(async () => {
      const closePromises = [];

      if (ws1 && ws1.readyState === WebSocket.OPEN) {
        closePromises.push(
          new Promise((resolve) => {
            ws1.close();
            ws1.on("close", resolve);
          })
        );
      }

      if (ws2 && ws2.readyState === WebSocket.OPEN) {
        closePromises.push(
          new Promise((resolve) => {
            ws2.close();
            ws2.on("close", resolve);
          })
        );
      }

      // Wait for all connections to close
      await Promise.all(closePromises);
    });

    test("should broadcast to all clients", (done) => {
      let connectionsReady = 0;
      let messagesReceived = 0;

      const checkReady = (): void => {
        connectionsReady++;
        if (connectionsReady === 2) {
          // Both clients connected, send broadcast
          const message: AnyMessage = {
            id: "broadcast-test",
            type: "test_broadcast",
            payload: { data: "hello all" },
            timestamp: Date.now(),
          };

          server.broadcast(message);
        }
      };

      const handleMessage = (data: Buffer): void => {
        const message = JSON.parse(data.toString());

        if (message.type === "test_broadcast") {
          messagesReceived++;
          if (messagesReceived === 2) {
            done();
          }
        }
      };

      ws1 = new WebSocket(wsUrl(server));
      ws2 = new WebSocket(wsUrl(server));

      ws1.on("open", checkReady);
      ws2.on("open", checkReady);

      ws1.on("message", handleMessage);
      ws2.on("message", handleMessage);

      ws1.on("error", done);
      ws2.on("error", done);
    });

    test("should handle room-based communication", (done) => {
      let connectionsReady = 0;
      let roomJoined = 0;
      // These were assigned below without ever being declared — a strict-mode
      // ReferenceError inside the message handler, which swallowed the room
      // flow and made this test time out as shipped.
      let client1Id: string | undefined;
      let client2Id: string | undefined;
      void client1Id;
      void client2Id;

      const checkReady = (): void => {
        connectionsReady++;
        if (connectionsReady === 2) {
          // Both clients connected, join room
          const joinMessage = {
            id: "join-test",
            type: "join_room",
            payload: { room: "test-room" },
            timestamp: Date.now(),
          };

          ws1.send(JSON.stringify(joinMessage));
          ws2.send(JSON.stringify(joinMessage));
        }
      };

      const handleRoomJoin = (): void => {
        roomJoined++;
        if (roomJoined === 2) {
          // Both clients in room, send room message
          const roomMessage = {
            id: "room-test",
            type: "room_message",
            payload: {
              room: "test-room",
              data: "hello room",
            },
            timestamp: Date.now(),
          };

          ws1.send(JSON.stringify(roomMessage));
        }
      };

      ws1 = new WebSocket(wsUrl(server));
      ws2 = new WebSocket(wsUrl(server));

      ws1.on("open", checkReady);
      ws2.on("open", checkReady);

      ws1.on("message", (data) => {
        const message = JSON.parse(data.toString());

        if (message.type === "connect") {
          client1Id = message.payload.clientId;
        } else if (message.type === "room_joined") {
          handleRoomJoin();
        }
      });

      ws2.on("message", (data) => {
        const message = JSON.parse(data.toString());

        if (message.type === "connect") {
          client2Id = message.payload.clientId;
        } else if (message.type === "room_joined") {
          handleRoomJoin();
        } else if (message.type === "room_message") {
          // ws2 should receive the room message from ws1
          expect(message.payload.data).toBe("hello room");
          done();
        }
      });

      ws1.on("error", done);
      ws2.on("error", done);
    });
  });

  describe("Server Interface Methods", () => {
    beforeEach(async () => {
      server = new BasicWebSocketServer(config);
      await server.start();
    });

    test("should get stats", () => {
      const stats = server.getStats();

      expect(stats.totalConnections).toBeDefined();
      expect(stats.activeConnections).toBeDefined();
      expect(stats.totalMessages).toBeDefined();
      expect(stats.uptime).toBeDefined();
    });

    test("should get clients", () => {
      const clients = server.getClients();
      expect(Array.isArray(clients)).toBe(true);
    });

    test("should get rooms", () => {
      const rooms = server.getRooms();
      expect(Array.isArray(rooms)).toBe(true);
    });

    test("should send to non-existent client", () => {
      const message: AnyMessage = {
        id: "test",
        type: "test",
        payload: {},
        timestamp: Date.now(),
      };

      const result = server.sendToClient("non-existent", message);
      expect(result).toBe(false);
    });
  });
});
