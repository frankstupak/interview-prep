// Advanced WebSocket Server with rate limiting, authentication, and advanced features

import crypto from "node:crypto";
import Fastify, { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { WebSocketManager } from "./websocket-manager";
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

interface AdvancedWebSocketConfig extends WebSocketConfig {
  enableRateLimit: boolean;
  rateLimitRequests: number;
  rateLimitWindow: number;
  enableAuth: boolean;
  authTokenHeader: string;
  /** Tokens accepted when enableAuth is true (compared in constant time). */
  authTokens: string[];
  enableMessageHistory: boolean;
  maxHistorySize: number;
  enablePresence: boolean;
}

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

interface MessageHistory {
  messages: AnyMessage[];
  maxSize: number;
}

export class AdvancedWebSocketServer implements WebSocketServer {
  private app: FastifyInstance;
  private manager: WebSocketManager;
  private config: AdvancedWebSocketConfig;
  private isRunning = false;
  private rateLimitMap = new Map<string, RateLimitEntry>();
  private messageHistory = new Map<string, MessageHistory>();
  private presenceMap = new Map<string, Record<string, unknown>>();
  // Messages already counted by the onBeforeMessage rate-limit gate (WeakSet:
  // entries vanish with the message object, no cleanup needed).
  private rateLimitCounted = new WeakSet<object>();
  private cleanupIntervalId: NodeJS.Timeout | null = null; // Store interval ID for cleanup

  constructor(config: Partial<AdvancedWebSocketConfig> = {}, hooks?: WebSocketHooks) {
    this.config = {
      port: 3002,
      host: "0.0.0.0",
      pingInterval: 30000,
      pingTimeout: 60000,
      maxConnections: 1000,
      enableCompression: true,
      enableCors: true,
      corsOrigin: "*",
      enableRateLimit: true,
      rateLimitRequests: 100,
      rateLimitWindow: 60000, // 1 minute
      enableAuth: false,
      authTokenHeader: "authorization",
      authTokens: ["valid-token"],
      enableMessageHistory: true,
      maxHistorySize: 100,
      enablePresence: true,
      ...config,
    };

    this.app = Fastify({
      logger: true,
      maxParamLength: MAX_PARAM_LENGTH,
    });

    // Enhanced hooks with additional functionality
    const enhancedHooks: WebSocketHooks = {
      ...hooks,
      onBeforeMessage: async (client, message) => {
        // Rate limiting must gate BUILT-IN handlers too: with the old
        // onMessage-only check, a rate-limited client could still flood rooms
        // via room_message, because built-ins run before onMessage.
        if (this.config.enableRateLimit) {
          if (!this.checkRateLimit(client.id)) {
            this.sendToClient(client.id, {
              id: crypto.randomUUID(),
              type: "error",
              payload: { error: "Rate limit exceeded", code: "RATE_LIMIT" },
              timestamp: Date.now(),
            });
            return false;
          }
          // Mark as already counted so the onMessage hook doesn't double-count.
          this.rateLimitCounted.add(message as object);
        }
        if (hooks?.onBeforeMessage) {
          return hooks.onBeforeMessage(client, message);
        }
        return true;
      },
      onConnect: async (client) => {
        if (this.config.enablePresence) {
          await this.updatePresence(client.id, { status: "online", lastSeen: Date.now() });
        }
        if (hooks?.onConnect) await hooks.onConnect(client);
      },
      onDisconnect: async (client) => {
        if (this.config.enablePresence) {
          await this.updatePresence(client.id, { status: "offline", lastSeen: Date.now() });
        }
        if (hooks?.onDisconnect) await hooks.onDisconnect(client);
      },
      onMessage: async (client, message) => {
        // Rate limiting (legacy path — only counts messages that did NOT pass
        // through onBeforeMessage, e.g. direct hook invocation; normal traffic
        // is already counted by the gate above).
        if (this.config.enableRateLimit && !this.rateLimitCounted.has(message as object)) {
          if (!this.checkRateLimit(client.id)) {
            this.sendToClient(client.id, {
              id: crypto.randomUUID(),
              type: "error",
              payload: { error: "Rate limit exceeded", code: "RATE_LIMIT" },
              timestamp: Date.now(),
            });
            return;
          }
        }
        this.rateLimitCounted.delete(message as object);

        // Message history
        if (this.config.enableMessageHistory) {
          this.addToHistory(message);
        }

        if (hooks?.onMessage) await hooks.onMessage(client, message);
      },
    };

    this.manager = new WebSocketManager(this.config, enhancedHooks);
    this.setupRoutes();
    this.startCleanupInterval();
  }

  /**
   * Setup enhanced routes with advanced features
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

    // Authentication middleware
    if (this.config.enableAuth) {
      this.app.addHook("preHandler", async (_request, reply) => {
        if (_request.url.startsWith("/api/") && _request.url !== "/api/auth") {
          const token = _request.headers[this.config.authTokenHeader] as string;
          if (!token || !this.validateToken(token)) {
            return reply.code(HttpStatus.UNAUTHORIZED).send({ error: "Unauthorized" });
          }
        }
      });
    }

    // Enhanced health check with detailed metrics
    this.app.get("/health", async (_request, _reply) => {
      const stats = this.manager.getStats();
      const systemHealth = {
        status: "healthy",
        timestamp: Date.now(),
        stats,
        rateLimitEntries: this.rateLimitMap.size,
        messageHistorySize: Array.from(this.messageHistory.values()).reduce(
          (sum, history) => sum + history.messages.length,
          0
        ),
        presenceEntries: this.presenceMap.size,
        memory: process.memoryUsage(),
        uptime: process.uptime(),
      };
      return systemHealth;
    });

    // Enhanced stats with rate limiting info
    this.app.get("/api/stats", async (_request, _reply) => {
      const baseStats = this.manager.getStats();
      return {
        ...baseStats,
        rateLimiting: {
          enabled: this.config.enableRateLimit,
          activeEntries: this.rateLimitMap.size,
          requestsPerWindow: this.config.rateLimitRequests,
          windowMs: this.config.rateLimitWindow,
        },
        messageHistory: {
          enabled: this.config.enableMessageHistory,
          totalMessages: Array.from(this.messageHistory.values()).reduce(
            (sum, history) => sum + history.messages.length,
            0
          ),
        },
        presence: {
          enabled: this.config.enablePresence,
          activeUsers: this.presenceMap.size,
        },
      };
    });

    // Message history endpoint
    this.app.get<{
      Querystring: { room?: string; limit?: number; offset?: number };
    }>("/api/history", async (request, reply) => {
      if (!this.config.enableMessageHistory) {
        return reply.code(HttpStatus.NOT_FOUND).send({ error: "Message history not enabled" });
      }

      // Coerce query params: over HTTP they arrive as STRINGS, and the old
      // `offset ? -offset : undefined` treated "0" as truthy — so
      // GET /api/history?offset=0 sliced to (-limit, -0) === (-limit, 0) and
      // always returned an empty page.
      const { room = "global" } = request.query;
      const limit = Math.max(0, Number(request.query.limit ?? 50) || 0);
      const offset = Math.max(0, Number(request.query.offset ?? 0) || 0);
      const history = this.messageHistory.get(room);

      if (!history) {
        return { messages: [], total: 0 };
      }

      const messages = history.messages
        .slice(offset > 0 ? -(limit + offset) : -limit, offset > 0 ? -offset : undefined)
        .reverse();

      return {
        messages,
        total: history.messages.length,
        room,
        limit,
        offset,
      };
    });

    // Presence endpoint
    this.app.get("/api/presence", async (request, reply) => {
      if (!this.config.enablePresence) {
        return reply.code(HttpStatus.NOT_FOUND).send({ error: "Presence not enabled" });
      }

      const presence = Array.from(this.presenceMap.entries()).map(([clientId, data]) => ({
        clientId,
        ...data,
      }));

      return { presence, total: presence.length };
    });

    // Rate limit status endpoint
    this.app.get<{
      Querystring: { clientId?: string };
    }>("/api/rate-limit", async (request, reply) => {
      if (!this.config.enableRateLimit) {
        return reply.code(HttpStatus.NOT_FOUND).send({ error: "Rate limiting not enabled" });
      }

      const { clientId } = request.query;

      if (clientId) {
        const entry = this.rateLimitMap.get(clientId);
        return {
          clientId,
          requests: entry?.count || 0,
          resetTime: entry?.resetTime || 0,
          remaining: entry
            ? Math.max(0, this.config.rateLimitRequests - entry.count)
            : this.config.rateLimitRequests,
        };
      }

      const allEntries = Array.from(this.rateLimitMap.entries()).map(([id, entry]) => ({
        clientId: id,
        requests: entry.count,
        resetTime: entry.resetTime,
        remaining: Math.max(0, this.config.rateLimitRequests - entry.count),
      }));

      return { entries: allEntries, total: allEntries.length };
    });

    // Enhanced broadcast with history and presence
    this.app.post<{
      Body: {
        message: AnyMessage;
        room?: string;
        saveToHistory?: boolean;
        updatePresence?: boolean;
      };
    }>("/api/broadcast", async (request, reply) => {
      const { message, room, saveToHistory = true, updatePresence = false } = request.body;

      if (!message || !message.type) {
        return reply.code(HttpStatus.BAD_REQUEST).send({ error: "Invalid message format" });
      }

      // Add to history if enabled
      if (this.config.enableMessageHistory && saveToHistory) {
        this.addToHistory(message, room);
      }

      // Update presence if requested
      if (this.config.enablePresence && updatePresence && message.clientId) {
        await this.updatePresence(message.clientId, { lastActivity: Date.now() });
      }

      this.manager.broadcast(message, room);

      return {
        success: true,
        broadcast: room ? `room:${room}` : "all",
        savedToHistory: saveToHistory && this.config.enableMessageHistory,
        timestamp: Date.now(),
      };
    });

    // WebSocket connection handler with advanced features
    this.app.register(async (fastify) => {
      fastify.get("/ws", { websocket: true }, async (connection, request) => {
        interface WithSocket {
          socket?: import("ws");
        }
        const socket: import("ws") =
          (connection as WithSocket).socket ?? (connection as unknown as import("ws"));

        // Authentication check for WebSocket connections
        if (this.config.enableAuth) {
          const token = request.headers[this.config.authTokenHeader] as string;
          if (!token || !this.validateToken(token)) {
            socket.close(1008, "Unauthorized");
            return;
          }
        }

        // Connection limit check
        if (this.manager.getStats().activeConnections >= this.config.maxConnections) {
          socket.close(1013, "Server overloaded");
          return;
        }

        const metadata = {
          userAgent: request.headers["user-agent"],
          ip: request.ip,
          query: request.query,
          connectedAt: Date.now(),
          authenticated: this.config.enableAuth,
        };

        const client = await this.manager.addClient(socket, metadata);

        // Enhanced message handling
        socket.on("message", async (data: Buffer | ArrayBuffer | Buffer[]) => {
          try {
            const message = data.toString();
            await this.manager.handleMessage(client.id, message);
          } catch (error) {
            this.app.log?.error(error, "Error handling message");
            this.sendToClient(client.id, {
              id: crypto.randomUUID(),
              type: "error",
              payload: { error: "Message processing failed" },
              timestamp: Date.now(),
            });
          }
        });

        socket.on("close", async () => {
          await this.manager.removeClient(client.id);
        });

        socket.on("error", (error: Error) => {
          this.app.log?.error(error, "WebSocket error");
          this.manager.removeClient(client.id);
        });

        // Send enhanced welcome message
        this.manager.sendToClient(client.id, {
          id: crypto.randomUUID(),
          type: "connect",
          payload: {
            clientId: client.id,
            message: "Connected to Advanced WebSocket server",
            serverTime: Date.now(),
            features: {
              rateLimit: this.config.enableRateLimit,
              auth: this.config.enableAuth,
              messageHistory: this.config.enableMessageHistory,
              presence: this.config.enablePresence,
            },
          },
          timestamp: Date.now(),
        });
      });
    });
  }

  /**
   * Rate limiting check
   */
  private checkRateLimit(clientId: string): boolean {
    if (!this.config.enableRateLimit) return true;

    const now = Date.now();
    const entry = this.rateLimitMap.get(clientId);

    if (!entry || now > entry.resetTime) {
      // Create new entry or reset expired one
      this.rateLimitMap.set(clientId, {
        count: 1,
        resetTime: now + this.config.rateLimitWindow,
      });
      return true;
    }

    if (entry.count >= this.config.rateLimitRequests) {
      return false;
    }

    entry.count++;
    return true;
  }

  /**
   * Add message to history
   */
  private addToHistory(message: AnyMessage, room = "global"): void {
    if (!this.config.enableMessageHistory) return;

    let history = this.messageHistory.get(room);
    if (!history) {
      history = { messages: [], maxSize: this.config.maxHistorySize };
      this.messageHistory.set(room, history);
    }

    history.messages.push(message);

    // Trim history if it exceeds max size
    if (history.messages.length > history.maxSize) {
      history.messages = history.messages.slice(-history.maxSize);
    }
  }

  /**
   * Update presence information
   */
  private async updatePresence(clientId: string, data: Record<string, unknown>): Promise<void> {
    if (!this.config.enablePresence) return;

    const existing = this.presenceMap.get(clientId) || {};
    this.presenceMap.set(clientId, { ...existing, ...data });
  }

  /**
   * Validate authentication token (placeholder implementation)
   */
  private validateToken(token: string): boolean {
    // The old check accepted ANY string starting with "Bearer " — i.e.
    // `Authorization: Bearer anything-at-all` bypassed auth entirely.
    // Compare the presented token against configured tokens in constant time
    // (length check first: timingSafeEqual requires equal-length buffers, and
    // length is not a secret here).
    const presented = token.startsWith("Bearer ") ? token.slice("Bearer ".length) : token;
    const presentedBuffer = Buffer.from(presented);
    return this.config.authTokens.some((expected) => {
      const expectedBuffer = Buffer.from(expected);
      return (
        expectedBuffer.length === presentedBuffer.length &&
        crypto.timingSafeEqual(expectedBuffer, presentedBuffer)
      );
    });
  }

  /**
   * Start cleanup interval for expired entries
   */
  private startCleanupInterval(): void {
    this.cleanupIntervalId = setInterval(() => {
      const now = Date.now();

      // Clean up expired rate limit entries
      for (const [clientId, entry] of this.rateLimitMap.entries()) {
        if (now > entry.resetTime) {
          this.rateLimitMap.delete(clientId);
        }
      }

      // Clean up offline presence entries older than 1 hour
      for (const [clientId, data] of this.presenceMap.entries()) {
        if (data.status === "offline" && now - (data.lastSeen as number) > 3600000) {
          this.presenceMap.delete(clientId);
        }
      }
    }, 60000); // Run every minute
  }

  // Implement WebSocketServer interface methods
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
      this.app.log?.info(
        `Advanced WebSocket server started on ${this.config.host}:${this.config.port}`
      );
      this.app.log?.info(
        `Features: RateLimit=${this.config.enableRateLimit} Auth=${this.config.enableAuth} History=${this.config.enableMessageHistory} Presence=${this.config.enablePresence}`
      );
    } catch (error) {
      this.app.log?.error(error, "Failed to start server");
      throw error;
    }
  }

  async stop(): Promise<void> {
    // Clear the cleanup interval even if the server never started listening —
    // the interval is created in the constructor, so the old early-return
    // leaked a live timer for constructed-but-never-started servers.
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }

    if (!this.isRunning) return;

    try {
      this.manager.destroy();
      await this.app.close();
      this.isRunning = false;
      this.app.log?.info("Advanced WebSocket server stopped");
    } catch (error) {
      this.app.log?.error(error, "Error stopping server");
      throw error;
    }
  }

  broadcast(message: AnyMessage, room?: string): void {
    this.manager.broadcast(message, room);
  }

  sendToClient(clientId: string, message: AnyMessage): boolean {
    return this.manager.sendToClient(clientId, message);
  }

  getStats(): WebSocketStats {
    return this.manager.getStats();
  }

  getClients(): WebSocketClient[] {
    return this.manager.getClients();
  }

  getRooms(): WebSocketRoom[] {
    return this.manager.getRooms();
  }

  addClientToRoom(clientId: string, room: string): boolean {
    // Honest return: previously this returned true even for unknown clients.
    // (hasClient guard is feature-detected so mocked managers keep working.)
    if (typeof this.manager.hasClient === "function" && !this.manager.hasClient(clientId)) {
      return false;
    }
    void this.manager.addClientToRoom(clientId, room);
    return true;
  }

  removeClientFromRoom(clientId: string, room: string): boolean {
    if (typeof this.manager.hasClient === "function" && !this.manager.hasClient(clientId)) {
      return false;
    }
    void this.manager.removeClientFromRoom(clientId, room);
    return true;
  }
}
