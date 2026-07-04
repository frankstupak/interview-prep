// React WebSocket Hook with best practices

import { useState, useEffect, useRef, useCallback } from "react";
import { io, Socket } from "socket.io-client";
import type {
  WebSocketMessage,
  SendableWebSocketMessage,
  ConnectMessage,
  ErrorMessage,
  ConnectionStatus,
  ServerType,
} from "../types";

interface UseWebSocketOptions {
  serverType: ServerType;
  url?: string;
  autoReconnect?: boolean;
  reconnectInterval?: number;
  maxReconnectAttempts?: number;
  onMessage?: (message: WebSocketMessage) => void;
  onConnect?: (clientId?: string) => void;
  onDisconnect?: (reason?: string) => void;
  onError?: (error: Error) => void;
}

interface UseWebSocketReturn {
  connectionStatus: ConnectionStatus;
  sendMessage: (message: SendableWebSocketMessage) => void;
  connect: () => void;
  disconnect: () => void;
  joinRoom: (room: string) => void;
  leaveRoom: (room: string) => void;
  lastMessage: WebSocketMessage | null;
  messageHistory: WebSocketMessage[];
}

export function useWebSocket(options: UseWebSocketOptions): UseWebSocketReturn {
  const {
    serverType,
    url,
    autoReconnect = true,
    reconnectInterval = 3000,
    maxReconnectAttempts = 5,
    onMessage,
    onConnect,
    onDisconnect,
    onError,
  } = options;

  // State
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>({
    connected: false,
    connecting: false,
  });
  const [lastMessage, setLastMessage] = useState<WebSocketMessage | null>(null);
  const [messageHistory, setMessageHistory] = useState<WebSocketMessage[]>([]);

  // Refs
  const wsRef = useRef<WebSocket | null>(null);
  const socketIORef = useRef<Socket | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Get WebSocket URL based on server type
  const getWebSocketUrl = useCallback(() => {
    if (url) return url;

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const host = window.location.hostname;

    switch (serverType) {
      case "basic":
        return `${protocol}//${host}:3001/ws`;
      case "advanced":
        return `${protocol}//${host}:3002/ws`;
      case "socketio":
        return `http://${host}:3003`;
      default:
        return `${protocol}//${host}:3001/ws`;
    }
  }, [serverType, url]);

  // Handle incoming messages
  const handleMessage = useCallback(
    (message: WebSocketMessage) => {
      const isHeartbeat = message.type === "ping" || message.type === "pong";
      // Keep heartbeat traffic out of lastMessage/history — at a 30s server
      // ping interval the 100-slot history would otherwise fill with noise.
      if (!isHeartbeat) {
        setLastMessage(message);
        setMessageHistory((prev) => [...prev.slice(-99), message]); // Keep last 100 messages
      }
      onMessage?.(message);

      // Handle built-in message types (narrow with assertion; GenericWebSocketMessage.type is string so TS doesn't narrow)
      switch (message.type) {
        case "ping": {
          // Answer the server's application-level heartbeat. Browsers answer
          // protocol-level pings automatically, but JS never sees those — the
          // JSON heartbeat is the only one we can (and must) answer ourselves.
          // Echo the server's payload so it can compute round-trip time.
          const pong = {
            id: crypto.randomUUID(),
            type: "pong",
            payload: message.payload ?? { timestamp: Date.now() },
            timestamp: Date.now(),
          };
          try {
            if (socketIORef.current) {
              socketIORef.current.emit("pong", pong);
            } else if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
              wsRef.current.send(JSON.stringify(pong));
            }
          } catch {
            // Connection racing shut; the next reconnect cycle handles it.
          }
          break;
        }
        case "connect": {
          const p = (message as ConnectMessage).payload;
          setConnectionStatus((prev) => ({
            ...prev,
            connected: true,
            connecting: false,
            clientId: p.clientId,
            serverType: p.serverType ?? serverType,
          }));
          reconnectAttemptsRef.current = 0;
          onConnect?.(p.clientId);
          break;
        }
        case "error": {
          const p = (message as ErrorMessage).payload;
          console.warn("WebSocket error:", p);
          onError?.(new Error(p.error ?? "Unknown error"));
          break;
        }
      }
    },
    [onMessage, onConnect, onError, serverType]
  );

  // Connect function
  const connect = useCallback(() => {
    if (connectionStatus.connected || connectionStatus.connecting) return;

    setConnectionStatus((prev) => ({ ...prev, connecting: true, error: undefined }));

    try {
      if (serverType === "socketio") {
        // Socket.IO connection
        const socket = io(getWebSocketUrl(), {
          transports: ["websocket", "polling"],
          autoConnect: false,
        });

        socket.connect();

        socket.on("connect", () => {
          console.warn("Socket.IO connected");
          socketIORef.current = socket;

          // Send initial connect message
          handleMessage({
            id: crypto.randomUUID(),
            type: "connect",
            payload: {
              clientId: socket.id,
              serverType: "socketio",
              message: "Connected to Socket.IO server",
            },
            timestamp: Date.now(),
          });
        });

        socket.on("disconnect", (reason) => {
          console.warn("Socket.IO disconnected:", reason);
          setConnectionStatus((prev) => ({ ...prev, connected: false, connecting: false }));
          socketIORef.current = null;
          onDisconnect?.(reason);

          if (autoReconnect && reconnectAttemptsRef.current < maxReconnectAttempts) {
            scheduleReconnect();
          }
        });

        socket.on("connect_error", (error) => {
          console.warn("Socket.IO connection error:", error);
          setConnectionStatus((prev) => ({
            ...prev,
            connected: false,
            connecting: false,
            error: error.message,
          }));
          onError?.(error);

          if (autoReconnect && reconnectAttemptsRef.current < maxReconnectAttempts) {
            scheduleReconnect();
          }
        });

        // Handle all Socket.IO events as messages (use data.type when present so e.g. chat messages get type "chat")
        socket.onAny((event, data) => {
          if (event !== "connect" && event !== "disconnect" && event !== "connect_error") {
            handleMessage({
              id: data.id || crypto.randomUUID(),
              type: (data && typeof data === "object" && data.type) || event,
              payload: (data && typeof data === "object" && data.payload) !== undefined ? data.payload : data,
              timestamp: data.timestamp ?? Date.now(),
              clientId: data.clientId,
            });
          }
        });
      } else {
        // Standard WebSocket connection
        const ws = new WebSocket(getWebSocketUrl());

        ws.onopen = (): void => {
          console.warn("WebSocket connected");
          wsRef.current = ws;
        };

        ws.onmessage = (event: MessageEvent): void => {
          try {
            const message = JSON.parse(event.data);
            handleMessage(message);
          } catch (error) {
            console.warn("Failed to parse WebSocket message:", error);
          }
        };

        ws.onclose = (event: CloseEvent): void => {
          console.warn("WebSocket closed:", event.code, event.reason);
          setConnectionStatus((prev) => ({ ...prev, connected: false, connecting: false }));
          wsRef.current = null;
          onDisconnect?.(event.reason);

          if (autoReconnect && reconnectAttemptsRef.current < maxReconnectAttempts) {
            scheduleReconnect();
          }
        };

        ws.onerror = (): void => {
          console.warn("WebSocket error");
          setConnectionStatus((prev) => ({
            ...prev,
            connected: false,
            connecting: false,
            error: "Connection failed",
          }));
          onError?.(new Error("WebSocket connection failed"));

          if (autoReconnect && reconnectAttemptsRef.current < maxReconnectAttempts) {
            scheduleReconnect();
          }
        };
      }
    } catch (error) {
      console.warn("Failed to create WebSocket connection:", error);
      setConnectionStatus((prev) => ({
        ...prev,
        connected: false,
        connecting: false,
        error: "Failed to create connection",
      }));
      onError?.(error as Error);
    }
  }, [
    connectionStatus.connected,
    connectionStatus.connecting,
    serverType,
    getWebSocketUrl,
    handleMessage,
    onDisconnect,
    onError,
    autoReconnect,
    maxReconnectAttempts,
  ]);

  // Disconnect function
  const disconnect = useCallback(() => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }

    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }

    if (socketIORef.current) {
      socketIORef.current.disconnect();
      socketIORef.current = null;
    }

    setConnectionStatus((prev) => ({ ...prev, connected: false, connecting: false }));
  }, []);

  // Schedule reconnect with exponential backoff + jitter. Fixed intervals mean
  // every client dropped by a server restart retries in synchronized waves
  // (thundering herd); jitter spreads the retries, the exponential curve backs
  // off a dead server, and the 30s cap keeps recovery latency bounded.
  const scheduleReconnect = useCallback((): void => {
    if (reconnectTimeoutRef.current) return;

    reconnectAttemptsRef.current++;
    const exponential = Math.min(
      reconnectInterval * 2 ** (reconnectAttemptsRef.current - 1),
      30000
    );
    // Randomize between 50% and 100% of the computed delay.
    const delay = exponential / 2 + Math.random() * (exponential / 2);
    console.warn(
      `Scheduling reconnect attempt ${reconnectAttemptsRef.current}/${maxReconnectAttempts} in ${Math.round(delay)}ms`
    );

    reconnectTimeoutRef.current = setTimeout(() => {
      reconnectTimeoutRef.current = null;
      connect();
    }, delay);
  }, [connect, reconnectInterval, maxReconnectAttempts]);

  // Send message function
  const sendMessage = useCallback(
    (message: SendableWebSocketMessage): void => {
      if (!connectionStatus.connected) {
        console.warn("Cannot send message: not connected");
        return;
      }

      const fullMessage: WebSocketMessage = {
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        ...message,
      };

      try {
        if (serverType === "socketio" && socketIORef.current) {
          socketIORef.current.emit(message.type, fullMessage);
        } else if (wsRef.current) {
          wsRef.current.send(JSON.stringify(fullMessage));
        }
        // Show sent message in the log (prefix type so Message Console shows "Sent: ...")
        setMessageHistory((prev) => [
          ...prev.slice(-99),
          { ...fullMessage, type: `sent_${fullMessage.type}` },
        ]);
      } catch (error) {
        console.warn("Failed to send message:", error);
        onError?.(error as Error);
      }
    },
    [connectionStatus.connected, serverType, onError]
  );

  // Room management functions
  const joinRoom = useCallback(
    (room: string): void => {
      sendMessage({
        type: "join_room",
        payload: { room },
      });
    },
    [sendMessage]
  );

  const leaveRoom = useCallback(
    (room: string): void => {
      sendMessage({
        type: "leave_room",
        payload: { room },
      });
    },
    [sendMessage]
  );

  // Auto-connect on mount, disconnect on unmount
  useEffect((): (() => void) => {
    connect();

    return (): void => {
      disconnect();
    };
  }, []);

  return {
    connectionStatus,
    sendMessage,
    connect,
    disconnect,
    joinRoom,
    leaveRoom,
    lastMessage,
    messageHistory,
  };
}
