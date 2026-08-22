/** @jest-environment jsdom */

import { renderHook, act, waitFor } from "@testing-library/react";
import { useWebSocket } from "./useWebSocket";
import type { WebSocketMessage } from "../types";

class MockWebSocket {
  public onopen?: () => void;
  public onmessage?: (event: { data: string }) => void;
  public onclose?: (event: CloseEvent) => void;
  public onerror?: (event: Event) => void;
  public sent: string[] = [];
  public close = jest.fn();

  constructor(public url: string) {
    mockSockets.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }
}

const mockSockets: MockWebSocket[] = [];
(globalThis as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket;

interface SocketIoStub {
  id: string;
  connect: jest.Mock;
  disconnect: jest.Mock;
  emit: jest.Mock;
  on: jest.Mock;
  onAny: jest.Mock;
  trigger: (event: string, ...args: unknown[]) => void;
  triggerAny: (event: string, payload: unknown) => void;
}

const socketIoInstances: SocketIoStub[] = [];

const createSocketIoStub = (_url: string): SocketIoStub => {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const anyHandlers: Array<(event: string, payload: unknown) => void> = [];

  const socket: SocketIoStub = {
    id: `socket-${socketIoInstances.length + 1}`,
    connect: jest.fn(() => {
      socket.trigger("connect");
    }),
    disconnect: jest.fn(),
    emit: jest.fn(),
    on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
      const list = handlers.get(event) || [];
      list.push(handler);
      handlers.set(event, list);
      return socket;
    }),
    onAny: jest.fn((handler: (event: string, payload: unknown) => void) => {
      anyHandlers.push(handler);
      return socket;
    }),
    trigger(event: string, ...args: unknown[]): void {
      handlers.get(event)?.forEach((handler) => handler(...args));
    },
    triggerAny(event: string, payload: unknown): void {
      anyHandlers.forEach((handler) => handler(event, payload));
    },
  };

  socketIoInstances.push(socket);
  return socket;
};

jest.mock("socket.io-client", () => ({
  io: jest.fn((url: string) => createSocketIoStub(url)) as unknown,
}));

describe("useWebSocket hook", () => {
  let logSpy: jest.SpiedFunction<typeof console.log>;
  let errorSpy: jest.SpiedFunction<typeof console.error>;
  let warnSpy: jest.SpiedFunction<typeof console.warn>;

  beforeEach(() => {
    mockSockets.length = 0;
    socketIoInstances.length = 0;
    jest.clearAllMocks();
    window.location.href = "http://localhost";
    logSpy = jest.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("manages lifecycle for basic WebSocket connections", async () => {
    const { result, unmount } = renderHook(() =>
      useWebSocket({ serverType: "basic", url: "ws://local/test", autoReconnect: false })
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(mockSockets).toHaveLength(1);
    const socket = mockSockets[0];

    await act(async () => {
      result.current.connect();
    });

    await act(async () => {
      socket.onopen?.();
    });

    const handshake: WebSocketMessage = {
      id: "handshake",
      type: "connect",
      payload: { clientId: "client-1", serverType: "basic" },
      timestamp: Date.now(),
    };

    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify(handshake) });
    });

    await waitFor(() => expect(result.current.connectionStatus.connected).toBe(true));

    const incoming: WebSocketMessage = {
      id: "msg-1",
      type: "chat",
      payload: { text: "hello" },
      timestamp: Date.now(),
    };

    await act(async () => {
      socket.onmessage?.({ data: JSON.stringify(incoming) });
    });

    expect(result.current.lastMessage).toEqual(incoming);
    expect(result.current.messageHistory).toHaveLength(2);

    await act(async () => {
      result.current.sendMessage({ type: "chat", payload: { text: "reply" } });
    });

    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0])).toMatchObject({ type: "chat", payload: { text: "reply" } });

    await act(async () => {
      result.current.disconnect();
    });
    expect(socket.close).toHaveBeenCalled();

    unmount();
  });

  it("integrates with Socket.IO clients", async () => {
    const { result, unmount } = renderHook(() =>
      useWebSocket({ serverType: "socketio", url: "http://local:3003", autoReconnect: false })
    );

    expect(socketIoInstances).toHaveLength(1);
    const socket = socketIoInstances[0];

    await act(async () => {
      socket.trigger("connect");
    });

    expect(result.current.connectionStatus.connected).toBe(true);
    expect(result.current.connectionStatus.clientId).toBeDefined();

    const payload: WebSocketMessage = {
      id: "event-1",
      type: "notification",
      payload: { ok: true },
      timestamp: Date.now(),
      clientId: socket.id,
    };

    await act(async () => {
      socket.triggerAny("notification", payload);
    });

    expect(result.current.lastMessage).toEqual(payload);

    await act(async () => {
      result.current.sendMessage({ type: "chat", payload: { text: "socket" } });
    });
    expect(socket.emit).toHaveBeenCalledWith(
      "chat",
      expect.objectContaining({ payload: { text: "socket" } })
    );

    await act(async () => {
      result.current.disconnect();
    });
    expect(socket.disconnect).toHaveBeenCalled();

    unmount();
  });

  it("answers server application-level pings with a pong and keeps heartbeats out of history", async () => {
    const { result, unmount } = renderHook(() =>
      useWebSocket({ serverType: "basic", url: "ws://local/hb", autoReconnect: false })
    );

    await act(async () => {
      await Promise.resolve();
    });
    const socket = mockSockets[0];

    await act(async () => {
      socket.onopen?.();
    });
    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({
          id: "handshake",
          type: "connect",
          payload: { clientId: "client-hb" },
          timestamp: Date.now(),
        }),
      });
    });

    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({
          id: "ping-1",
          type: "ping",
          payload: { timestamp: 42 },
          timestamp: Date.now(),
        }),
      });
    });

    // The shipped hook never answered the server's JSON heartbeat, so every
    // browser client was reaped after pingTimeout despite being alive.
    const pong = socket.sent
      .map((raw) => JSON.parse(raw) as { type: string; payload: { timestamp?: number } })
      .find((message) => message.type === "pong");
    expect(pong).toBeDefined();
    expect(pong?.payload.timestamp).toBe(42); // echoed for server-side RTT

    // Heartbeat noise must not consume the 100-slot message history.
    expect(
      result.current.messageHistory.every((message) => message.type !== "ping")
    ).toBe(true);

    unmount();
  });

  it("backs off exponentially between reconnect attempts", async () => {
    jest.useFakeTimers();
    const randomSpy = jest.spyOn(Math, "random").mockReturnValue(1); // deterministic: full delay

    try {
      const { unmount } = renderHook(() =>
        useWebSocket({
          serverType: "basic",
          url: "ws://local/rc",
          autoReconnect: true,
          reconnectInterval: 1000,
          maxReconnectAttempts: 3,
        })
      );

      await act(async () => {
        await Promise.resolve();
      });
      expect(mockSockets).toHaveLength(1);

      act(() => {
        mockSockets[0].onclose?.({ code: 1006, reason: "" } as CloseEvent);
      });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("attempt 1/3 in 1000ms"));

      act(() => {
        jest.advanceTimersByTime(1000);
      });
      expect(mockSockets).toHaveLength(2);

      act(() => {
        mockSockets[1].onclose?.({ code: 1006, reason: "" } as CloseEvent);
      });
      // Second attempt doubles the base delay (2 ** 1 * 1000).
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("attempt 2/3 in 2000ms"));

      unmount();
    } finally {
      randomSpy.mockRestore();
      jest.useRealTimers();
    }
  });
});
