// WebSocket Types and Interfaces
import { WebSocket as WSWebSocket } from "ws";
import { Socket as SocketIOSocket } from "socket.io";

// Payload types for different message types
export interface ChatPayload {
  username: string;
  message: string;
  room?: string;
}

export interface NotificationPayload {
  title: string;
  body: string;
  priority: "low" | "medium" | "high";
}

export interface RoomPayload {
  room: string;
  data?: Record<string, unknown>;
}

export interface ErrorPayload {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface GenericPayload {
  [key: string]: unknown;
}

// Union type for all possible payload types
export type MessagePayload =
  | ChatPayload
  | NotificationPayload
  | RoomPayload
  | ErrorPayload
  | GenericPayload
  | WebSocketStats
  | string
  | number
  | boolean
  | null;

export interface WebSocketMessage {
  id: string;
  type: string;
  payload: MessagePayload;
  timestamp: number;
  clientId?: string;
}

export interface BasicMessage extends WebSocketMessage {
  type: "message" | "ping" | "pong" | "error" | "connect" | "disconnect";
}

export interface ChatMessage extends WebSocketMessage {
  type: "chat";
  payload: ChatPayload;
}

export interface NotificationMessage extends WebSocketMessage {
  type: "notification";
  payload: NotificationPayload;
}

export interface RoomMessage extends WebSocketMessage {
  type: "join_room" | "leave_room" | "room_message";
  payload: RoomPayload;
}

// Allow any message type for flexibility
export type AnyMessage = WebSocketMessage;

/**
 * Discriminated union of message types by `type` for type-safe narrowing.
 * Use with switch(message.type) or type guards (isRoomPayload, etc.).
 */
export type TypedWebSocketMessage =
  | ChatMessage
  | NotificationMessage
  | RoomMessage
  | (WebSocketMessage & { type: string; payload: MessagePayload });

/** Type guard: payload has a string `room` property (RoomPayload or compatible). */
export function isRoomPayload(payload: MessagePayload): payload is RoomPayload & { room: string } {
  return (
    payload !== null &&
    typeof payload === "object" &&
    "room" in payload &&
    typeof (payload as RoomPayload).room === "string"
  );
}

/** Type guard: value is a non-primitive payload object (has keys). */
export function isPayloadObject(payload: MessagePayload): payload is Record<string, unknown> {
  return payload !== null && typeof payload === "object" && !Array.isArray(payload);
}

// Socket type that can be either WebSocket or Socket.IO socket
export type Socket = WSWebSocket | SocketIOSocket;

// Client metadata interface
export interface ClientMetadata {
  userAgent?: string;
  ipAddress?: string;
  connectedAt: number;
  [key: string]: unknown;
}

// Room metadata interface
export interface RoomMetadata {
  createdBy?: string;
  description?: string;
  maxClients?: number;
  [key: string]: unknown;
}

export interface WebSocketClient {
  id: string;
  socket: Socket;
  rooms: Set<string>;
  metadata: ClientMetadata;
  lastPing: number;
  connected: boolean;
}

export interface WebSocketRoom {
  id: string;
  name: string;
  clients: Set<string>;
  metadata: RoomMetadata;
  created: number;
}

export interface WebSocketStats {
  totalConnections: number;
  activeConnections: number;
  totalMessages: number;
  messagesPerSecond: number;
  rooms: number;
  uptime: number;
}

export interface WebSocketConfig {
  port: number;
  host: string;
  pingInterval: number;
  pingTimeout: number;
  maxConnections: number;
  enableCompression: boolean;
  enableCors: boolean;
  corsOrigin?: string | string[];
}

export interface WebSocketHooks {
  /**
   * Gate hook that runs BEFORE built-in message handling (ping, join_room,
   * room_message, ...). Return false to drop the message entirely — this is
   * where policies like rate limiting belong, since onMessage only runs after
   * built-ins have already executed.
   */
  onBeforeMessage?: (client: WebSocketClient, message: AnyMessage) => boolean | Promise<boolean>;
  onConnect?: (client: WebSocketClient) => void | Promise<void>;
  onDisconnect?: (client: WebSocketClient) => void | Promise<void>;
  onMessage?: (client: WebSocketClient, message: AnyMessage) => void | Promise<void>;
  onError?: (client: WebSocketClient, error: Error) => void | Promise<void>;
  onRoomJoin?: (client: WebSocketClient, room: string) => void | Promise<void>;
  onRoomLeave?: (client: WebSocketClient, room: string) => void | Promise<void>;
}

export interface WebSocketServer {
  start(): Promise<void>;
  stop(): Promise<void>;
  broadcast(message: AnyMessage, room?: string): void;
  sendToClient(clientId: string, message: AnyMessage): boolean;
  getStats(): WebSocketStats;
  getClients(): WebSocketClient[];
  getRooms(): WebSocketRoom[];
  addClientToRoom(clientId: string, room: string): boolean;
  removeClientFromRoom(clientId: string, room: string): boolean;
}
