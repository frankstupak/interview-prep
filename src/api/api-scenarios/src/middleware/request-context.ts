/**
 * Request Context Middleware
 *
 * This middleware creates a request context that tracks important
 * information throughout the request lifecycle, including request ID,
 * user information, timing, and other metadata.
 *
 * Key Features:
 * - Unique request ID generation
 * - Request timing and performance tracking
 * - User context extraction from JWT tokens
 * - IP address and user agent tracking
 * - Request/response logging
 */

import { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import jwt from "jsonwebtoken";
import { RequestContext } from "../types/common";
import { HttpStatus, UserErrorCode, AUTH_HEADER_BEARER_PREFIX } from "../constants";

/** RFC 8725 §3.1: verification must run against an explicit algorithm
 *  allowlist — never the algorithm named by the (attacker-controlled)
 *  token header. This app signs HS256 only. */
const JWT_ALLOWED_ALGORITHMS: jwt.Algorithm[] = ["HS256"];

const jwtPayloadSchema = z
  .object({
    userId: z.string().optional(),
    sub: z.string().optional(),
    role: z.string().optional(),
    email: z.string().optional(),
    permissions: z.array(z.string()).optional(),
  })
  .passthrough();

/** Error that may carry HTTP status (e.g. from Fastify or custom errors) */
interface ErrorWithStatus extends Error {
  statusCode?: number;
  status?: number;
}

/**
 * Returns JWT secret from environment. In production, throws if not set.
 * In development/test, returns undefined when not set (JWT verification is skipped).
 */
function getJwtSecret(): string | undefined {
  const secret = process.env.JWT_SECRET;
  if (process.env.NODE_ENV === "production" && !secret) {
    throw new Error("JWT_SECRET environment variable is required in production");
  }
  return secret;
}

// Extend Fastify request to include our context
declare module "fastify" {
  interface FastifyRequest {
    requestContext: RequestContext;
  }
}

/**
 * Request Context Middleware
 * Creates and attaches request context to every incoming request
 */
export async function requestContextMiddleware(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const startTime = Date.now();
  const requestId = uuidv4();

  // Extract IP address (considering proxies)
  const forwardedFor = request.headers["x-forwarded-for"];
  const realIp = request.headers["x-real-ip"];
  const ip =
    (Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor) ||
    (Array.isArray(realIp) ? realIp[0] : realIp) ||
    request.socket.remoteAddress ||
    "unknown";

  // Extract user agent
  const userAgent = request.headers["user-agent"];

  // Initialize base context
  const context: RequestContext = {
    requestId,
    startTime,
    ip: Array.isArray(ip) ? ip[0] : ip,
    userAgent,
  };

  // Extract user information from JWT token if present
  const authHeader = request.headers.authorization;
  if (authHeader && authHeader.startsWith(AUTH_HEADER_BEARER_PREFIX)) {
    const jwtSecret = getJwtSecret();
    if (jwtSecret) {
      try {
        const token = authHeader.substring(AUTH_HEADER_BEARER_PREFIX.length);
        // RFC 8725 §3.1: pin the accepted algorithm set. Without this,
        // jsonwebtoken accepts any HMAC variant the token header names.
        const decoded = jwt.verify(token, jwtSecret, { algorithms: JWT_ALLOWED_ALGORITHMS });
        const parsed = jwtPayloadSchema.safeParse(decoded);
        if (parsed.success) {
          context.userId = parsed.data.userId ?? parsed.data.sub;
          context.userRole = parsed.data.role;
        }
      } catch (error) {
        // Invalid token - continue without user context
        const message = error instanceof Error ? error.message : "Unknown error";
        request.log.warn(`Invalid JWT token in request: ${message}`);
      }
    }
  }

  // Attach context to request using proper type extension
  request.requestContext = context;

  // Log request start
  request.log.info(
    `Request started id=${context.requestId} method=${request.method} url=${request.url} ip=${context.ip} userId=${context.userId ?? "anonymous"}`
  );

  // Add response headers
  reply.header("X-Request-ID", requestId);
  reply.header("X-Response-Time", "0"); // Will be updated in onSend hook
}

/**
 * Response Time Middleware
 * Calculates and logs response time, adds it to response headers
 */
export async function responseTimeMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
  payload: unknown
): Promise<unknown> {
  const context = request.requestContext;
  const executionTime = context?.startTime ? Date.now() - context.startTime : 0;

  // Update response time header
  reply.header("X-Response-Time", executionTime.toString());

  // Log request completion
  if (context) {
    request.log.info(
      `Request completed id=${context.requestId} method=${request.method} url=${request.url} status=${reply.statusCode} timeMs=${executionTime}`
    );
  }

  return payload;
}

/**
 * Error Context Middleware
 * Ensures error responses include request context
 */
export function errorContextMiddleware(
  error: Error,
  request: FastifyRequest,
  reply: FastifyReply
): void {
  const context = request.requestContext;
  const startTime = context?.startTime ?? Date.now();
  const executionTime = Date.now() - startTime;

  // Log error with context
  if (context) {
    request.log.error(
      `Request failed id=${context.requestId} method=${request.method} url=${request.url} error=${error.message} timeMs=${executionTime}`
    );
  }

  // Ensure error response includes request ID
  const errorResponse = {
    success: false,
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: error.message,
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
    },
    meta: {
      timestamp: new Date().toISOString(),
      requestId: context?.requestId || "unknown",
      executionTime,
    },
  };

  const status =
    (error && typeof error === "object" ? (error as ErrorWithStatus).statusCode : undefined) ??
    (error && typeof error === "object" ? (error as ErrorWithStatus).status : undefined) ??
    HttpStatus.INTERNAL_SERVER_ERROR;
  reply.code(status).send(errorResponse);
}

/**
 * User Context Extractor
 * Utility function to extract and validate user context from JWT
 */
export function extractUserContext(token: string): {
  userId?: string;
  userRole?: string;
  email?: string;
  permissions?: string[];
} | null {
  const jwtSecret = getJwtSecret();
  if (!jwtSecret) {
    return null;
  }
  try {
    const decoded = jwt.verify(token, jwtSecret, { algorithms: JWT_ALLOWED_ALGORITHMS });
    const parsed = jwtPayloadSchema.safeParse(decoded);
    if (!parsed.success) {
      return null;
    }

    return {
      userId: parsed.data.userId ?? parsed.data.sub,
      userRole: parsed.data.role,
      email: parsed.data.email,
      permissions: parsed.data.permissions ?? [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("JWT decode failed:", message);
    return null;
  }
}

/**
 * Request Validation Middleware
 * Validates request context and ensures required fields are present
 */
export async function validateRequestContext(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (!request.requestContext) {
    reply.code(HttpStatus.INTERNAL_SERVER_ERROR).send({
      success: false,
      error: {
        code: "MISSING_REQUEST_CONTEXT",
        message: "Request context not initialized",
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      },
    });
    return;
  }

  if (!request.requestContext.requestId) {
    reply.code(HttpStatus.INTERNAL_SERVER_ERROR).send({
      success: false,
      error: {
        code: "INVALID_REQUEST_CONTEXT",
        message: "Request ID not generated",
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      },
    });
    return;
  }
}

/**
 * User Authentication Middleware
 * Ensures user is authenticated and has valid context
 */
export async function requireAuthentication(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  if (!request.requestContext.userId) {
    reply.code(HttpStatus.UNAUTHORIZED).send({
      success: false,
      error: {
        code: "AUTHENTICATION_REQUIRED",
        message: "Authentication required to access this resource",
        statusCode: HttpStatus.UNAUTHORIZED,
      },
      meta: {
        timestamp: new Date().toISOString(),
        requestId: request.requestContext.requestId,
      },
    });
    return;
  }
}

/**
 * Role-based Authorization Middleware
 * Ensures user has required role to access resource
 */
export function requireRole(allowedRoles: string[]) {
  return async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!request.requestContext.userId) {
      reply.code(HttpStatus.UNAUTHORIZED).send({
        success: false,
        error: {
          code: "AUTHENTICATION_REQUIRED",
          message: "Authentication required",
          statusCode: HttpStatus.UNAUTHORIZED,
        },
        meta: {
          timestamp: new Date().toISOString(),
          requestId: request.requestContext.requestId,
        },
      });
      return;
    }

    const userRole = request.requestContext.userRole;
    if (!userRole || !allowedRoles.includes(userRole)) {
      reply.code(HttpStatus.FORBIDDEN).send({
        success: false,
        error: {
          code: UserErrorCode.INSUFFICIENT_PERMISSIONS,
          message: `Access denied. Required roles: ${allowedRoles.join(", ")}`,
          statusCode: HttpStatus.FORBIDDEN,
        },
        meta: {
          timestamp: new Date().toISOString(),
          requestId: request.requestContext.requestId,
        },
      });
      return;
    }
  };
}

/**
 * Request Rate Limiting Context
 * Real per-client fixed-window rate limiter (was: hardcoded placeholder
 * headers advertising limit=1000/remaining=999 with no enforcement).
 *
 * - Window/limit configurable via RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS
 *   (defaults preserve the previously advertised 1000 req/hour policy).
 * - Emits the widely deployed X-RateLimit-Limit/-Remaining/-Reset headers
 *   (the de facto convention retained by the IETF ratelimit-headers draft)
 *   with values that now reflect actual counters.
 * - Over-limit requests get 429 + Retry-After (delay-seconds).
 * - Keyed by requestContext.ip; expired windows are pruned lazily.
 */
interface RateWindow {
  count: number;
  resetAt: number; // epoch ms when the window resets
}

const rateWindows = new Map<string, RateWindow>();
let lastPruneAt = 0;

function rateLimitConfig(): { max: number; windowMs: number } {
  const max = Number.parseInt(process.env.RATE_LIMIT_MAX ?? "", 10);
  const windowMs = Number.parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "", 10);
  return {
    max: Number.isFinite(max) && max > 0 ? max : 1000,
    windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 60 * 60 * 1000,
  };
}

/** Drop expired windows at most once per minute so the map cannot grow unbounded. */
function pruneRateWindows(now: number): void {
  if (now - lastPruneAt < 60_000) return;
  lastPruneAt = now;
  for (const [key, window] of rateWindows) {
    if (now >= window.resetAt) rateWindows.delete(key);
  }
}

/** Test/ops hook: clear all rate-limit state. */
export function resetRateLimitState(): void {
  rateWindows.clear();
  lastPruneAt = 0;
}

export async function rateLimitContext(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const { max, windowMs } = rateLimitConfig();
  const now = Date.now();
  pruneRateWindows(now);

  const key = request.requestContext?.ip ?? request.socket.remoteAddress ?? "unknown";
  let window = rateWindows.get(key);
  if (!window || now >= window.resetAt) {
    window = { count: 0, resetAt: now + windowMs };
    rateWindows.set(key, window);
  }
  window.count++;

  const remaining = Math.max(0, max - window.count);
  reply.header("X-RateLimit-Limit", max.toString());
  reply.header("X-RateLimit-Remaining", remaining.toString());
  reply.header("X-RateLimit-Reset", window.resetAt.toString());

  if (window.count > max) {
    const retryAfterSeconds = Math.max(1, Math.ceil((window.resetAt - now) / 1000));
    reply.header("Retry-After", retryAfterSeconds.toString());
    reply.code(429).send({
      success: false,
      error: {
        code: "RATE_LIMIT_EXCEEDED",
        message: "Too many requests, please retry later",
        statusCode: 429,
      },
      meta: {
        timestamp: new Date().toISOString(),
        requestId: request.requestContext?.requestId ?? "unknown",
      },
    });
    return;
  }
}

/**
 * CORS Context Middleware
 * Handles CORS headers based on request context
 */
export async function corsContext(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const origin = request.headers.origin;

  // In production, you'd check against allowed origins
  const allowedOrigins = [
    "http://localhost:3000",
    "http://localhost:3001",
    "https://yourdomain.com",
  ];

  if (origin && allowedOrigins.includes(origin)) {
    reply.header("Access-Control-Allow-Origin", origin);
  }

  reply.header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
  reply.header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
  reply.header("Access-Control-Allow-Credentials", "true");
  reply.header("Access-Control-Max-Age", "86400"); // 24 hours

  // Handle preflight requests
  if (request.method === "OPTIONS") {
    reply.code(HttpStatus.NO_CONTENT).send();
    return;
  }
}

/**
 * Security Headers Middleware
 * Adds security headers to all responses
 */
export async function securityHeaders(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Security headers
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("X-Frame-Options", "DENY");
  reply.header("X-XSS-Protection", "1; mode=block");
  reply.header("Referrer-Policy", "strict-origin-when-cross-origin");
  reply.header("Permissions-Policy", "geolocation=(), microphone=(), camera=()");

  // Content Security Policy (adjust based on your needs)
  reply.header(
    "Content-Security-Policy",
    "default-src 'self'; " +
      "script-src 'self' 'unsafe-inline'; " +
      "style-src 'self' 'unsafe-inline'; " +
      "img-src 'self' data: https:; " +
      "font-src 'self'; " +
      "connect-src 'self'"
  );

  // HSTS (only in production with HTTPS)
  if (process.env.NODE_ENV === "production") {
    reply.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

/**
 * Strip potentially dangerous patterns from a string value
 */
function sanitizeString(value: string): string {
  return value
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "")
    .replace(/javascript:/gi, "")
    .replace(/on\w+\s*=/gi, "");
}

/**
 * Request Sanitization Middleware
 * Sanitizes request data to prevent common attacks
 */
export async function sanitizeRequest(
  request: FastifyRequest,
  _reply: FastifyReply
): Promise<void> {
  // Sanitize query parameters
  if (isRecord(request.query)) {
    for (const [key, value] of Object.entries(request.query)) {
      if (typeof value === "string") {
        request.query[key] = sanitizeString(value);
      }
    }
  }

  // Sanitize request body (if it's JSON)
  if (request.body && typeof request.body === "object") {
    sanitizeObject(request.body);
  }
}

/**
 * Recursively sanitize object properties
 */
function sanitizeObject(obj: unknown): void {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    obj.forEach((value) => sanitizeObject(value));
    return;
  }

  const record = obj as Record<string, unknown>;
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "string") {
      record[key] = sanitizeString(value);
    } else if (value && typeof value === "object") {
      sanitizeObject(value);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
