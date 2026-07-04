// Basic WebSocket Server Implementation using Fastify

import Fastify, { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { WebSocketManager } from "./websocket-manager";
import crypto from "crypto";
import type {
  WebSocketServer,
  WebSocketConfig,
  WebSocketHooks,
  AnyMessage,
  WebSocketClient,
  WebSocketRoom,
  WebSocketStats,
} from "./types";
import { MAX_PARAM_LENGTH, HttpStatus } from "./constants";

export class BasicWebSocketServer implements WebSocketServer {
  private app: FastifyInstance;
  private manager: WebSocketManager;
  private config: WebSocketConfig;
  private isRunning = false;

  constructor(config: Partial<WebSocketConfig> = {}, hooks?: WebSocketHooks) {
    this.config = {
      port: 3001,
      host: "0.0.0.0",
      pingInterval: 30000, // 30 seconds
      pingTimeout: 60000, // 60 seconds
      maxConnections: 1000,
      enableCompression: true,
      enableCors: true,
      corsOrigin: "*",
      ...config,
    };

    this.app = Fastify({
      logger: true,
      maxParamLength: MAX_PARAM_LENGTH,
    });

    this.manager = new WebSocketManager(this.config, hooks);
    this.setupRoutes();
  }

  /**
   * Setup Fastify routes and WebSocket handlers
   */
  private setupRoutes(): void {
    // Register WebSocket plugin
    this.app.register(websocket);

    // CORS handling - simplified for demo
    if (this.config.enableCors) {
      this.app.addHook("onRequest", async (_request, reply) => {
        reply.header("Access-Control-Allow-Origin", "*");
        reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
        reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
      });
    }

    // Health check endpoint
    this.app.get("/health", async (_request, _reply) => {
      const stats = this.manager.getStats();
      return {
        status: "healthy",
        timestamp: Date.now(),
        stats,
      };
    });

    // WebSocket stats endpoint
    this.app.get("/api/stats", async (_request, _reply) => {
      return this.manager.getStats();
    });

    // WebSocket clients endpoint
    this.app.get("/api/clients", async (_request, _reply) => {
      const clients = this.manager.getClients();
      return clients.map((client) => ({
        id: client.id,
        rooms: Array.from(client.rooms),
        metadata: client.metadata,
        lastPing: client.lastPing,
        connected: client.connected,
      }));
    });

    // WebSocket rooms endpoint
    this.app.get("/api/rooms", async (_request, _reply) => {
      const rooms = this.manager.getRooms();
      return rooms.map((room) => ({
        id: room.id,
        name: room.name,
        clientCount: room.clients.size,
        metadata: room.metadata,
        created: room.created,
      }));
    });

    // Broadcast endpoint for testing
    this.app.post<{
      Body: { message: AnyMessage; room?: string };
    }>("/api/broadcast", async (request, reply) => {
      const { message, room } = request.body;

      if (!message || !message.type) {
        return reply.code(HttpStatus.BAD_REQUEST).send({ error: "Invalid message format" });
      }

      this.manager.broadcast(message, room);

      return {
        success: true,
        broadcast: room ? `room:${room}` : "all",
        timestamp: Date.now(),
      };
    });

    // WebSocket connection handler
    this.app.register(async (fastify) => {
      fastify.get("/ws", { websocket: true }, async (connection, request) => {
        interface WithSocket {
          socket?: import("ws");
        }
        const socket: import("ws") =
          (connection as WithSocket).socket ?? (connection as unknown as import("ws"));

        // Extract client metadata from query params or headers
        const metadata = {
          userAgent: request.headers["user-agent"],
          ip: request.ip,
          query: request.query,
          connectedAt: Date.now(),
        };

        // Add client to manager
        const client = await this.manager.addClient(socket, metadata);

        // Handle incoming messages
        socket.on("message", async (data: Buffer | ArrayBuffer | Buffer[]) => {
          try {
            const message = data.toString();
            await this.manager.handleMessage(client.id, message);
          } catch (error) {
            this.app.log?.error(error, "Error handling message");
          }
        });

        // Handle connection close
        socket.on("close", async () => {
          await this.manager.removeClient(client.id);
        });

        // Handle errors
        socket.on("error", (error: Error) => {
          this.app.log?.error(error, "WebSocket error");
          this.manager.removeClient(client.id);
        });

        // Send welcome message
        this.manager.sendToClient(client.id, {
          id: crypto.randomUUID(),
          type: "connect",
          payload: {
            clientId: client.id,
            message: "Connected to WebSocket server",
            serverTime: Date.now(),
          },
          timestamp: Date.now(),
        });
      });
    });

    // Simple static file serving for demo
    this.app.get("/demo/*", async (_request, reply) => {
      return reply.code(HttpStatus.OK).send("<h1>WebSocket Demo</h1><p>Frontend not built yet</p>");
    });

    // Redirect root to demo
    this.app.get("/", async (_request, reply) => {
      return reply.redirect("/demo/");
    });
  }

  /**
   * Start the WebSocket server
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error("Server is already running");
    }

    try {
      await this.app.listen({
        port: this.config.port,
        host: this.config.host,
      });

      this.isRunning = true;
      const addr = this.app.server?.address();
      if (addr && typeof addr === "object" && typeof addr.port === "number") {
        this.config.port = addr.port;
      }
      this.app.log?.info(`WebSocket server started on ${this.config.host}:${this.config.port}`);
      this.app.log?.info(`WebSocket endpoint: ws://${this.config.host}:${this.config.port}/ws`);
      this.app.log?.info(`Health check: http://${this.config.host}:${this.config.port}/health`);
      this.app.log?.info(`Demo: http://${this.config.host}:${this.config.port}/demo/`);
    } catch (error) {
      this.app.log?.error(error, "Failed to start server");
      throw error;
    }
  }

  /**
   * Stop the WebSocket server
   */
  async stop(): Promise<void> {
    if (!this.isRunning) return;

    try {
      this.manager.destroy();
      await this.app.close();
      this.isRunning = false;
      this.app.log?.info("WebSocket server stopped");
    } catch (error) {
      this.app.log?.error(error, "Error stopping server");
      throw error;
    }
  }

  /**
   * Broadcast message to all clients or specific room
   */
  broadcast(message: AnyMessage, room?: string): void {
    this.manager.broadcast(message, room);
  }

  /**
   * Send message to specific client
   */
  sendToClient(clientId: string, message: AnyMessage): boolean {
    return this.manager.sendToClient(clientId, message);
  }

  /**
   * Get the port the server is listening on (after start(); when port was 0, returns OS-assigned port).
   */
  getPort(): number {
    return this.config.port;
  }

  /**
   * Get server statistics
   */
  getStats(): WebSocketStats {
    return this.manager.getStats();
  }

  /**
   * Get connected clients
   */
  getClients(): WebSocketClient[] {
    return this.manager.getClients();
  }

  /**
   * Get active rooms
   */
  getRooms(): WebSocketRoom[] {
    return this.manager.getRooms();
  }

  /**
   * Add client to room
   */
  addClientToRoom(clientId: string, room: string): boolean {
    // Fire and forget - manager methods are async but interface is sync.
    // Honest return: false for clients the manager doesn't know about.
    if (typeof this.manager.hasClient === "function" && !this.manager.hasClient(clientId)) {
      return false;
    }
    void this.manager.addClientToRoom(clientId, room);
    return true;
  }

  /**
   * Remove client from room
   */
  removeClientFromRoom(clientId: string, room: string): boolean {
    if (typeof this.manager.hasClient === "function" && !this.manager.hasClient(clientId)) {
      return false;
    }
    void this.manager.removeClientFromRoom(clientId, room);
    return true;
  }

  /**
   * Get the Fastify app instance for advanced usage
   */
  getApp(): FastifyInstance {
    return this.app;
  }
}
