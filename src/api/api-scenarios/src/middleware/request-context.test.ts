import { describe, it, expect, beforeEach, jest, afterEach } from "@jest/globals";
import {
  requestContextMiddleware,
  responseTimeMiddleware,
  errorContextMiddleware,
  extractUserContext,
  validateRequestContext,
  requireAuthentication,
  requireRole,
  rateLimitContext,
  corsContext,
  securityHeaders,
  sanitizeRequest,
} from "./request-context";
import { FastifyReply, FastifyRequest } from "fastify";
import { UserRole, UserErrorCode } from "../constants";

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
const jwtModule = require("jsonwebtoken") as typeof import("jsonwebtoken");
const originalDecode = jwtModule.decode;
const originalVerify = jwtModule.verify;
const initialJwtSecret = process.env.JWT_SECRET;

interface MockReply extends Partial<FastifyReply> {
  statusCode: number;
  payload: unknown;
  headers: Record<string, string>;
  code: (status: number) => MockReply;
  send: (payload?: unknown) => MockReply;
  header: (key: string, value: string) => MockReply;
}

const createReply = (): MockReply => {
  const reply: MockReply = {
    statusCode: 200,
    payload: undefined,
    headers: {},
    code(status: number) {
      this.statusCode = status;
      return this;
    },
    send(payload?: unknown) {
      this.payload = payload;
      return this;
    },
    header(key: string, value: string) {
      this.headers[key] = value;
      return this;
    },
  };

  return reply;
};

const createRequest = (overrides: Partial<FastifyRequest> = {}): FastifyRequest => {
  const base: Record<string, unknown> = {
    headers: {},
    method: "GET",
    url: "/test",
    socket: { remoteAddress: "10.0.0.1" },
    log: {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    },
  };

  return { ...base, ...overrides } as FastifyRequest;
};

const getRecordValue = (value: unknown, key: string): unknown => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = Object.entries(value).find(([k]) => k === key);
  return entry ? entry[1] : undefined;
};

describe("request-context middleware", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jwtModule.decode = originalDecode;
    jwtModule.verify = originalVerify;
  });

  afterEach(() => {
    jwtModule.decode = originalDecode;
    jwtModule.verify = originalVerify;
    if (initialJwtSecret === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = initialJwtSecret;
    }
  });

  describe("requestContextMiddleware", () => {
    it("attaches context and decodes bearer token", async () => {
      const request = createRequest({
        headers: {
          authorization: "Bearer token",
          "user-agent": "jest",
          "x-forwarded-for": "203.0.113.10",
        },
      });

      const reply = createReply();
      const verifyMock = jest.fn().mockReturnValue({ userId: "user-123", role: UserRole.ADMIN });
      (jwtModule as unknown as { verify: typeof jwtModule.verify }).verify = verifyMock;
      process.env.JWT_SECRET = "unit-secret";

      expect((request.headers as Record<string, string>).authorization).toBe("Bearer token");
      await requestContextMiddleware(request, reply as FastifyReply);

      // Algorithm allowlist is now pinned per RFC 8725 §3.1.
      expect(verifyMock).toHaveBeenCalledWith("token", "unit-secret", { algorithms: ["HS256"] });
      expect(request.requestContext.userId).toBe("user-123");
      expect(request.requestContext.userRole).toBe(UserRole.ADMIN);
      expect(request.requestContext.ip).toBe("203.0.113.10");
      expect(reply.headers["X-Request-ID"]).toBeDefined();
    });

    it("handles invalid JWT tokens gracefully", async () => {
      const request = createRequest({
        headers: {
          authorization: "Bearer bad-token",
        },
      });
      const reply = createReply();

      const verifyMock = jest.fn(() => {
        throw new Error("invalid token");
      });
      (jwtModule as unknown as { verify: typeof jwtModule.verify }).verify = verifyMock;
      process.env.JWT_SECRET = "test-secret";

      await requestContextMiddleware(request, reply as FastifyReply);

      expect(verifyMock).toHaveBeenCalledWith("bad-token", "test-secret", {
        algorithms: ["HS256"],
      });
      expect(request.requestContext?.userId).toBeUndefined();
      expect(request.log.warn).toHaveBeenCalled();
    });
  });

  describe("responseTimeMiddleware", () => {
    it("records execution time and logs completion", async () => {
      const request = createRequest();
      request.requestContext = {
        requestId: "req-1",
        startTime: Date.now() - 50,
        ip: "127.0.0.1",
      };
      const reply = createReply();

      await responseTimeMiddleware(request, reply as FastifyReply, { ok: true });

      expect(reply.headers["X-Response-Time"]).toBeDefined();
      expect(request.log.info).toHaveBeenCalled();
    });
  });

  describe("errorContextMiddleware", () => {
    it("sends error payload with request metadata", () => {
      const request = createRequest();
      request.requestContext = {
        requestId: "req-err",
        startTime: Date.now() - 20,
        ip: "127.0.0.1",
      };
      const reply = createReply();

      errorContextMiddleware(new Error("boom"), request, reply as FastifyReply);

      expect(reply.statusCode).toBe(500);
      expect(reply.payload.meta.requestId).toBe("req-err");
      expect(reply.payload.meta.executionTime).toBeGreaterThanOrEqual(0);
    });
  });

  describe("extractUserContext", () => {
    it("returns decoded claims when token is valid", () => {
      const verifyMock = jest.fn().mockReturnValue({
        userId: "user-5",
        role: UserRole.MANAGER,
        email: "user@example.com",
        permissions: ["read"],
      });
      (jwtModule as unknown as { verify: typeof jwtModule.verify }).verify = verifyMock;
      process.env.JWT_SECRET = "test-secret";

      const context = extractUserContext("token");

      expect(context).toEqual({
        userId: "user-5",
        userRole: UserRole.MANAGER,
        email: "user@example.com",
        permissions: ["read"],
      });
    });

    it("returns null for invalid tokens", () => {
      const verifyMock = jest.fn(() => {
        throw new Error("bad token");
      });
      (jwtModule as unknown as { verify: typeof jwtModule.verify }).verify = verifyMock;
      process.env.JWT_SECRET = "test-secret";

      expect(extractUserContext("bad")).toBeNull();
    });

    it("returns null when JWT_SECRET is not set", () => {
      const prev = process.env.JWT_SECRET;
      delete process.env.JWT_SECRET;
      expect(extractUserContext("any-token")).toBeNull();
      if (prev !== undefined) process.env.JWT_SECRET = prev;
    });
  });

  describe("validateRequestContext", () => {
    it("returns 500 when context is missing", async () => {
      const request = createRequest();
      const reply = createReply();

      await validateRequestContext(request, reply as FastifyReply);

      expect(reply.statusCode).toBe(500);
      expect(reply.payload.error.code).toBe("MISSING_REQUEST_CONTEXT");
    });
  });

  describe("requireAuthentication", () => {
    it("rejects requests without user context", async () => {
      const request = createRequest();
      request.requestContext = {
        requestId: "req",
      };
      const reply = createReply();

      await requireAuthentication(request, reply as FastifyReply);

      expect(reply.statusCode).toBe(401);
      expect(reply.payload.error.code).toBe("AUTHENTICATION_REQUIRED");
    });
  });

  describe("requireRole", () => {
    it("rejects unauthenticated users", async () => {
      const request = createRequest();
      request.requestContext = {
        requestId: "req",
      };
      const reply = createReply();

      await requireRole([UserRole.ADMIN])(request, reply as FastifyReply);

      expect(reply.statusCode).toBe(401);
    });

    it("rejects users without required role", async () => {
      const request = createRequest();
      request.requestContext = {
        requestId: "req",
        userId: "user",
        userRole: UserRole.USER,
      };
      const reply = createReply();

      await requireRole([UserRole.ADMIN])(request, reply as FastifyReply);

      expect(reply.statusCode).toBe(403);
      expect(reply.payload.error.code).toBe(UserErrorCode.INSUFFICIENT_PERMISSIONS);
    });

    it("allows users with valid role", async () => {
      const request = createRequest();
      request.requestContext = {
        requestId: "req",
        userId: "user",
        userRole: UserRole.ADMIN,
      };
      const reply = createReply();

      await requireRole([UserRole.ADMIN])(request, reply as FastifyReply);

      expect(reply.payload).toBeUndefined();
    });
  });

  describe("rateLimitContext", () => {
    it("adds rate limit headers", async () => {
      const request = createRequest();
      const reply = createReply();

      await rateLimitContext(request, reply as FastifyReply);

      expect(reply.headers["X-RateLimit-Limit"]).toBe("1000");
      expect(reply.headers["X-RateLimit-Remaining"]).toBe("999");
      expect(reply.headers["X-RateLimit-Reset"]).toBeDefined();
    });
  });

  describe("corsContext", () => {
    it("sets CORS headers for allowed origins", async () => {
      const request = createRequest({
        headers: {
          origin: "http://localhost:3000",
        },
      });
      const reply = createReply();

      await corsContext(request, reply as FastifyReply);

      expect(reply.headers["Access-Control-Allow-Origin"]).toBe("http://localhost:3000");
      expect(reply.headers["Access-Control-Allow-Methods"]).toContain("POST");
    });

    it("immediately returns for preflight requests", async () => {
      const request = createRequest({ method: "OPTIONS" });
      const reply = createReply();

      await corsContext(request, reply as FastifyReply);

      expect(reply.statusCode).toBe(204);
    });
  });

  describe("securityHeaders", () => {
    const originalEnv = process.env.NODE_ENV;

    afterEach(() => {
      process.env.NODE_ENV = originalEnv;
    });

    it("sets baseline security headers", async () => {
      const request = createRequest();
      const reply = createReply();

      await securityHeaders(request, reply as FastifyReply);

      expect(reply.headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(reply.headers["Permissions-Policy"]).toContain("geolocation=()");
      expect(reply.headers["Strict-Transport-Security"]).toBeUndefined();
    });

    it("adds HSTS header in production", async () => {
      process.env.NODE_ENV = "production";
      const request = createRequest();
      const reply = createReply();

      await securityHeaders(request, reply as FastifyReply);

      expect(reply.headers["Strict-Transport-Security"]).toContain("max-age");
    });
  });

  describe("sanitizeRequest", () => {
    it("removes suspicious patterns from query and body", async () => {
      const request = createRequest({
        query: {
          q: "<script>alert('xss')</script>",
        },
        body: {
          nested: {
            value: "javascript:alert('xss')",
          },
        },
      });
      const reply = createReply();

      await sanitizeRequest(request, reply as FastifyReply);

      const sanitizedQuery = getRecordValue(request.query, "q");
      const sanitizedBody = getRecordValue(request.body, "nested") as
        | { value?: string }
        | undefined;

      expect(String(sanitizedQuery)).not.toContain("script");
      expect(sanitizedBody?.value).toBe("alert('xss')");
    });
  });
});
