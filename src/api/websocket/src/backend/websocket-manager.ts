// WebSocket Manager - Core WebSocket functionality

import { v4 as uuidv4 } from "uuid";
import type {
  WebSocketClient,
  WebSocketRoom,
  WebSocketStats,
  AnyMessage,
  WebSocketHooks,
  WebSocketConfig,
} from "./types";
import { isRoomPayload, isPayloadObject } from "./types";
import { MessageType } from "./constants";

export class WebSocketManager {
  private clients = new Map<string, WebSocketClient>();
  private rooms = new Map<string, WebSocketRoom>();
  private stats = {
    totalConnections: 0,
    totalMessages: 0,
    startTime: Date.now(),
    messagesLastSecond: 0,
    lastMessageTime: Date.now(),
    windowCount: 0,
  };
  private hooks: WebSocketHooks = {};
  private pingInterval?: NodeJS.Timeout;

  constructor(
    private config: WebSocketConfig,
    hooks?: WebSocketHooks
  ) {
    this.hooks = hooks || {};
    // Skip ping interval in test environment to prevent Jest open handles
    const isTestEnv = process.env.NODE_ENV === "test" || process.env.JEST_WORKER_ID !== undefined;
    if (!isTestEnv) {
      this.startPingInterval();
    }
  }

  /**
   * Add a new client connection
   */
  async addClient(
    socket: import("./types").Socket,
    metadata: Record<string, unknown> = {}
  ): Promise<WebSocketClient> {
    const client: WebSocketClient = {
      id: uuidv4(),
      socket,
      rooms: new Set(),
      metadata: { ...metadata, connectedAt: Date.now() },
      lastPing: Date.now(),
      connected: true,
    };

    this.clients.set(client.id, client);
    this.stats.totalConnections++;

    // Protocol-level liveness (RFC 6455): raw `ws` sockets emit "pong" in response to
    // our ping() frames — browsers answer these automatically, so this keeps browser
    // clients alive even if they never send an application-level ping/pong message.
    const rawSocket = socket as unknown as {
      on?: (event: string, listener: () => void) => void;
      ping?: () => void;
    };
    if (typeof rawSocket.on === "function" && typeof rawSocket.ping === "function") {
      rawSocket.on("pong", () => {
        client.lastPing = Date.now();
      });
    }

    // Call onConnect hook
    if (this.hooks.onConnect) {
      await this.hooks.onConnect(client);
    }

    return client;
  }

  /**
   * Remove a client connection
   */
  async removeClient(clientId: string): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return;

    // Remove from all rooms
    for (const roomId of client.rooms) {
      await this.removeClientFromRoom(clientId, roomId);
    }

    client.connected = false;
    this.clients.delete(clientId);

    // Call onDisconnect hook
    if (this.hooks.onDisconnect) {
      await this.hooks.onDisconnect(client);
    }
  }

  /**
   * Handle incoming message from client
   */
  async handleMessage(
    clientId: string,
    rawMessage: string | Buffer | ArrayBuffer | AnyMessage
  ): Promise<void> {
    const client = this.clients.get(clientId);
    if (!client) return;

    try {
      let message: AnyMessage;

      if (typeof rawMessage === "string") {
        message = JSON.parse(rawMessage);
      } else if (Buffer.isBuffer(rawMessage) || rawMessage instanceof ArrayBuffer) {
        message = JSON.parse(
          Buffer.isBuffer(rawMessage) ? rawMessage.toString() : Buffer.from(rawMessage).toString()
        );
      } else {
        message = rawMessage;
      }

      // Ensure message has required fields
      if (!message.id) message.id = uuidv4();
      if (!message.timestamp) message.timestamp = Date.now();
      message.clientId = clientId;

      // Any inbound traffic proves the connection is alive — refresh liveness so
      // active clients are never reaped by the heartbeat sweep.
      client.lastPing = Date.now();

      this.stats.totalMessages++;
      this.updateMessagesPerSecond();

      // Gate hook: runs BEFORE built-in handling so policies like rate limiting
      // also cover join_room/room_message/ping, not just application messages.
      if (this.hooks.onBeforeMessage) {
        const allowed = await this.hooks.onBeforeMessage(client, message);
        if (allowed === false) return;
      }

      // Handle built-in message types
      await this.handleBuiltInMessages(client, message);

      // Call onMessage hook
      if (this.hooks.onMessage) {
        await this.hooks.onMessage(client, message);
      }
    } catch (error) {
      const errorMessage: AnyMessage = {
        id: uuidv4(),
        type: MessageType.ERROR,
        payload: { error: "Invalid message format" },
        timestamp: Date.now(),
        clientId,
      };

      this.sendToClient(clientId, errorMessage);

      if (this.hooks.onError && error instanceof Error) {
        await this.hooks.onError(client, error);
      }
    }
  }

  /**
   * Handle built-in message types
   */
  private async handleBuiltInMessages(client: WebSocketClient, message: AnyMessage): Promise<void> {
    switch (message.type) {
      case MessageType.PING:
        client.lastPing = Date.now();
        this.sendToClient(client.id, {
          id: uuidv4(),
          type: MessageType.PONG,
          // Echo the client's payload (e.g. their timestamp) so they can compute RTT.
          payload: isPayloadObject(message.payload)
            ? { ...message.payload, timestamp: Date.now() }
            : { timestamp: Date.now() },
          timestamp: Date.now(),
        });
        break;

      case MessageType.PONG:
        // Client answered our application-level heartbeat — mark it alive.
        // (Previously PONG was silently ignored, so every client that correctly
        // answered the server's pings was still reaped after pingTimeout.)
        client.lastPing = Date.now();
        break;

      case MessageType.JOIN_ROOM: {
        if (isRoomPayload(message.payload)) {
          await this.addClientToRoom(client.id, message.payload.room);
        }
        break;
      }

      case MessageType.LEAVE_ROOM: {
        if (isRoomPayload(message.payload)) {
          await this.removeClientFromRoom(client.id, message.payload.room);
        }
        break;
      }

      case MessageType.ROOM_MESSAGE: {
        if (isRoomPayload(message.payload)) {
          this.broadcastToRoom(message.payload.room, message, client.id);
        }
        break;
      }
    }
  }

  /**
   * Send message to specific client
   */
  sendToClient(clientId: string, message: AnyMessage): boolean {
    const client = this.clients.get(clientId);
    if (!client || !client.connected) return false;
    return this.deliver(client, message);
  }

  /**
   * Deliver a message to a client's socket. Accepts an optional pre-serialized
   * JSON string so broadcasts can stringify once instead of once per recipient.
   */
  private deliver(client: WebSocketClient, message: AnyMessage, serialized?: string): boolean {
    try {
      const socket = client.socket as unknown as {
        send?: (data: string) => void;
        emit?: (event: string, data: unknown) => void;
        readyState?: number;
        nsp?: unknown;
      };

      // Socket.IO sockets are detected via `nsp` and get a structured emit.
      // (They also have a `send()` method, so the old `if (socket.send)` check
      // routed them through the raw path and consumers received JSON strings
      // instead of objects — the emit branch was dead code.)
      if (socket.nsp !== undefined && typeof socket.emit === "function") {
        socket.emit(MessageType.MESSAGE, message);
        return true;
      }

      if (typeof socket.send === "function") {
        // Raw ws: only OPEN (readyState 1) sockets can send; sending on
        // CONNECTING throws and on CLOSING/CLOSED it errors into the console.
        if (typeof socket.readyState === "number" && socket.readyState !== 1) {
          return false;
        }
        socket.send(serialized ?? JSON.stringify(message));
        return true;
      }

      return false;
    } catch (error) {
      console.error("Failed to send message to client:", error);
      return false;
    }
  }

  /**
   * Broadcast message to all clients or specific room
   */
  broadcast(message: AnyMessage, roomId?: string): void {
    if (roomId) {
      this.broadcastToRoom(roomId, message);
    } else {
      // Serialize once for all raw-WebSocket recipients instead of once per
      // recipient — JSON.stringify dominated broadcast cost at fan-out.
      const serialized = JSON.stringify(message);
      for (const client of this.clients.values()) {
        if (!client.connected) continue;
        this.deliver(client, message, serialized);
      }
    }
  }

  /**
   * Broadcast message to specific room
   */
  broadcastToRoom(roomId: string, message: AnyMessage, excludeClientId?: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    const serialized = JSON.stringify(message);
    for (const clientId of room.clients) {
      if (excludeClientId && clientId === excludeClientId) continue;
      const client = this.clients.get(clientId);
      if (!client || !client.connected) continue;
      this.deliver(client, message, serialized);
    }
  }

  /**
   * Add client to room
   */
  async addClientToRoom(clientId: string, roomId: string): Promise<boolean> {
    const client = this.clients.get(clientId);
    if (!client) return false;

    // Create room if it doesn't exist
    if (!this.rooms.has(roomId)) {
      this.rooms.set(roomId, {
        id: roomId,
        name: roomId,
        clients: new Set(),
        metadata: {},
        created: Date.now(),
      });
    }

    const room = this.rooms.get(roomId)!;
    room.clients.add(clientId);
    client.rooms.add(roomId);

    // Call onRoomJoin hook
    if (this.hooks.onRoomJoin) {
      await this.hooks.onRoomJoin(client, roomId);
    }

    // Notify client
    this.sendToClient(clientId, {
      id: uuidv4(),
      type: MessageType.ROOM_JOINED,
      payload: { room: roomId, clientCount: room.clients.size },
      timestamp: Date.now(),
    });

    return true;
  }

  /**
   * Remove client from room
   */
  async removeClientFromRoom(clientId: string, roomId: string): Promise<boolean> {
    const client = this.clients.get(clientId);
    const room = this.rooms.get(roomId);

    if (!client || !room) return false;

    room.clients.delete(clientId);
    client.rooms.delete(roomId);

    // Remove empty room
    if (room.clients.size === 0) {
      this.rooms.delete(roomId);
    }

    // Call onRoomLeave hook
    if (this.hooks.onRoomLeave) {
      await this.hooks.onRoomLeave(client, roomId);
    }

    // Notify client
    this.sendToClient(clientId, {
      id: uuidv4(),
      type: MessageType.ROOM_LEFT,
      payload: { room: roomId },
      timestamp: Date.now(),
    });

    return true;
  }

  /**
   * Get current statistics
   */
  getStats(): WebSocketStats {
    const uptimeMs = Math.max(1, Date.now() - this.stats.startTime);
    return {
      totalConnections: this.stats.totalConnections,
      activeConnections: this.clients.size,
      totalMessages: this.stats.totalMessages,
      // Report the last completed 1s window; decay to 0 when idle instead of
      // pinning the last observed value forever.
      messagesPerSecond:
        Date.now() - this.stats.lastMessageTime >= 2000 ? 0 : this.stats.messagesLastSecond,
      rooms: this.rooms.size,
      uptime: uptimeMs,
    };
  }

  /**
   * Get all connected clients
   */
  getClients(): WebSocketClient[] {
    return Array.from(this.clients.values());
  }

  /**
   * Get all rooms
   */
  getRooms(): WebSocketRoom[] {
    return Array.from(this.rooms.values());
  }

  /**
   * Start ping interval to check client connections
   */
  private startPingInterval(): void {
    this.pingInterval = setInterval(() => {
      const now = Date.now();
      const timeout = this.config.pingTimeout;

      for (const [clientId, client] of this.clients.entries()) {
        if (now - client.lastPing > timeout) {
          // Dead connection: actually close the underlying socket, don't just
          // forget about it (previously the socket was left open and leaked).
          this.closeSocket(client);
          void this.removeClient(clientId);
        } else {
          // Protocol-level ping for raw ws sockets — browsers/ws clients answer
          // automatically with a pong frame (see the ws README heartbeat pattern).
          const rawSocket = client.socket as unknown as { ping?: () => void };
          if (typeof rawSocket.ping === "function") {
            try {
              rawSocket.ping();
            } catch {
              // Socket already closing; the timeout sweep will reap it.
            }
          }
          // Application-level ping for clients that implement JSON heartbeats.
          this.sendToClient(clientId, {
            id: uuidv4(),
            type: MessageType.PING,
            payload: { timestamp: now },
            timestamp: now,
          });
        }
      }
    }, this.config.pingInterval);
    // Never let the heartbeat timer keep the process alive on its own.
    this.pingInterval.unref?.();
  }

  /**
   * Best-effort close of the underlying transport (ws terminate / Socket.IO disconnect).
   */
  private closeSocket(client: WebSocketClient): void {
    const socket = client.socket as unknown as {
      terminate?: () => void;
      disconnect?: (close?: boolean) => void;
      close?: () => void;
    };
    try {
      if (typeof socket.terminate === "function") {
        socket.terminate();
      } else if (typeof socket.disconnect === "function") {
        socket.disconnect(true);
      } else if (typeof socket.close === "function") {
        socket.close();
      }
    } catch {
      // Already closed.
    }
  }

  /**
   * Synchronously check whether a client is registered.
   */
  hasClient(clientId: string): boolean {
    return this.clients.has(clientId);
  }

  /**
   * Update messages per second counter
   */
  private updateMessagesPerSecond(): void {
    const now = Date.now();
    if (now - this.stats.lastMessageTime >= 1000) {
      // Close the previous 1s window and report ITS count; the old code zeroed
      // the counter and reported the partial current window instead, so the
      // stat never reflected an actual per-second rate (and never decayed).
      this.stats.messagesLastSecond = this.stats.windowCount;
      this.stats.windowCount = 0;
      this.stats.lastMessageTime = now;
    }
    this.stats.windowCount++;
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }

    // Disconnect all clients — close the underlying sockets too, so server
    // shutdown doesn't strand open connections.
    for (const [clientId, client] of this.clients.entries()) {
      this.closeSocket(client);
      void this.removeClient(clientId);
    }

    this.clients.clear();
    this.rooms.clear();
  }
}
