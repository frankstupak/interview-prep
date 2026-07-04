/**
 * Comprehensive API Scenarios Server
 *
 * This server demonstrates a wide range of API patterns and scenarios:
 * - Full CRUD operations with advanced querying
 * - Real-time streaming with WebSockets and SSE
 * - File upload and download handling
 * - Authentication and authorization
 * - Rate limiting and security middleware
 * - API documentation with Swagger
 * - Health monitoring and metrics
 * - Error handling and logging
 * - Request/response transformation
 * - Caching strategies
 * - Bulk operations and batch processing
 */

import Fastify, { FastifyInstance, FastifyRequest, FastifyReply, FastifySchema } from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import websocket from "@fastify/websocket";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";

// Middleware
import {
  requestContextMiddleware,
  responseTimeMiddleware,
  errorContextMiddleware,
  requireAuthentication,
  requireRole,
  rateLimitContext,
  corsContext,
  securityHeaders,
  sanitizeRequest,
} from "./middleware/request-context";

// Services
import { CrudService } from "./services/crud-service";
import { StreamingService } from "./services/streaming-service";

// Controllers
import { UserController } from "./controllers/user-controller";

// Types
import { User } from "./types/entities";
import {
  HttpStatus,
  UserRole,
  UserRoleList,
  UserStatusList,
  UserErrorCode,
  HealthStatus,
  MAX_FILE_SIZE_BYTES,
  DEFAULT_PORT,
  StreamingDefaultConfig,
  FILE_SIZE_ERROR_MESSAGE,
} from "./constants";
import type { HttpMethod } from "./types/common";
import { MockUserRepository } from "./repositories/mock-user-repository";

const server: FastifyInstance = Fastify({
  logger:
    process.env.NODE_ENV === "test"
      ? { level: "warn" }
      : {
          level: "info",
          transport: {
            target: "pino-pretty",
            options: {
              colorize: true,
              translateTime: "HH:MM:ss Z",
              ignore: "pid,hostname",
            },
          },
        },
});

// Global services
let streamingService: StreamingService;
let userController: UserController;

interface RouteConfig {
  schema?: FastifySchema;
  preHandler?:
    | ((request: FastifyRequest, reply: FastifyReply) => void | Promise<void>)
    | Array<(request: FastifyRequest, reply: FastifyReply) => void | Promise<void>>;
  handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown> | unknown;
  [key: string]: unknown;
}

const HttpMethods: ReadonlyArray<HttpMethod> = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
];

const isHttpMethod = (value: string): value is HttpMethod =>
  HttpMethods.some((method) => method === value);

function registerRoute(
  server: FastifyInstance,
  method: HttpMethod,
  path: string,
  config: RouteConfig
): void {
  const { handler, ...options } = config;

  switch (method) {
    case "GET":
      server.get(path, options, handler);
      break;
    case "POST":
      server.post(path, options, handler);
      break;
    case "PUT":
      server.put(path, options, handler);
      break;
    case "DELETE":
      server.delete(path, options, handler);
      break;
    case "PATCH":
      server.patch(path, options, handler);
      break;
    case "HEAD":
      server.head(path, options, handler);
      break;
    case "OPTIONS":
      server.options(path, options, handler);
      break;
    default:
      throw new Error(`Unsupported HTTP method: ${method}`);
  }
}

/**
 * Register multiple routes from a route definition object
 * Format: { "METHOD /path": { handler, schema, preHandler, ... } }
 */
function registerRoutes(server: FastifyInstance, routes: Record<string, RouteConfig>): void {
  for (const [route, config] of Object.entries(routes)) {
    const [method, path] = route.split(" ");
    const upperMethod = method.toUpperCase();
    if (!isHttpMethod(upperMethod)) {
      throw new Error(`Unsupported HTTP method: ${method}`);
    }
    registerRoute(server, upperMethod, path, config);
  }
}

/**
 * Register plugins and middleware
 */
async function registerPlugins(): Promise<void> {
  // CORS support
  await server.register(cors, {
    origin: true,
    credentials: true,
  });

  // Multipart support for file uploads
  await server.register(multipart, {
    limits: {
      fileSize: MAX_FILE_SIZE_BYTES,
    },
  });

  // WebSocket support
  await server.register(websocket);

  // Swagger documentation
  await server.register(swagger, {
    swagger: {
      info: {
        title: "API Scenarios Documentation",
        description: "Comprehensive API examples demonstrating various patterns and scenarios",
        version: "1.0.0",
      },
      host: `localhost:${DEFAULT_PORT}`,
      schemes: ["http", "https"],
      consumes: ["application/json", "multipart/form-data"],
      produces: ["application/json"],
      tags: [
        { name: "Users", description: "User management endpoints" },
        { name: "Streaming", description: "Real-time streaming endpoints" },
        { name: "Files", description: "File upload and download endpoints" },
        { name: "Health", description: "Health monitoring endpoints" },
      ],
      securityDefinitions: {
        Bearer: {
          type: "apiKey",
          name: "Authorization",
          in: "header",
          description: "Enter: Bearer {token}",
        },
      },
    },
  });

  await server.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: {
      docExpansion: "list",
      deepLinking: false,
    },
  });

  server.log.info("Plugins registered successfully");
}

/**
 * Register global middleware
 */
function registerMiddleware(): void {
  // Request context middleware (runs first)
  server.addHook("preHandler", requestContextMiddleware);

  // Security headers
  server.addHook("preHandler", securityHeaders);

  // CORS handling
  server.addHook("preHandler", corsContext);

  // Request sanitization
  server.addHook("preHandler", sanitizeRequest);

  // Rate limiting context
  server.addHook("preHandler", rateLimitContext);

  // Response time calculation
  server.addHook("onSend", responseTimeMiddleware);

  // Global error handler
  server.setErrorHandler((error, request, reply) =>
    errorContextMiddleware(
      error instanceof Error ? error : new Error("Unknown error"),
      request,
      reply
    )
  );

  server.log.info("Middleware registered successfully");
}

/**
 * Initialize services
 */
function initializeServices(): void {
  // Initialize streaming service
  streamingService = new StreamingService({
    maxConnections: StreamingDefaultConfig.MAX_CONNECTIONS,
    messageRateLimit: StreamingDefaultConfig.MESSAGE_RATE_LIMIT,
    heartbeatInterval: StreamingDefaultConfig.HEARTBEAT_INTERVAL_MS,
    connectionTimeout: StreamingDefaultConfig.CONNECTION_TIMEOUT_MS,
    enablePersistence: true,
    maxMessageHistory: StreamingDefaultConfig.MAX_MESSAGE_HISTORY,
  });

  // Initialize user service and controller
  const userRepository = new MockUserRepository();
  const userService = new CrudService<User>(userRepository, {
    entityName: "User",
    auditEnabled: true,
    softDelete: true,
    permissions: {
      create: [UserRole.ADMIN, UserRole.MANAGER],
      read: [UserRole.ADMIN, UserRole.MANAGER, UserRole.USER],
      update: [UserRole.ADMIN, UserRole.MANAGER, UserRole.USER],
      delete: [UserRole.ADMIN],
    },
  });

  userController = new UserController(userService);

  server.log.info("Services initialized successfully");
}

/**
 * Register API routes
 */
function registerApiRoutes(): void {
  // Root endpoint with API overview
  server.get("/", async (_request, _reply) => {
    return {
      service: "API Scenarios Examples",
      version: "1.0.0",
      description: "Comprehensive API patterns and scenarios demonstration",
      features: [
        "Full CRUD operations with advanced querying",
        "Real-time streaming with WebSockets",
        "File upload and download handling",
        "Authentication and authorization",
        "Rate limiting and security",
        "API documentation with Swagger",
        "Health monitoring and metrics",
        "Bulk operations and batch processing",
      ],
      endpoints: {
        documentation: "/docs",
        health: "/health",
        metrics: "/metrics",
        users: "/api/v1/users",
        streaming: "/api/v1/stream",
        files: "/api/v1/files",
      },
      examples: {
        "Create User": "POST /api/v1/users",
        "Get Users": "GET /api/v1/users?search=john&role=admin&page=1&limit=10",
        WebSocket: `ws://localhost:${DEFAULT_PORT}/api/v1/stream`,
        "Upload File": "POST /api/v1/files/upload",
      },
    };
  });

  // Health check endpoint
  server.get(
    "/health",
    {
      schema: {
        tags: ["Health"],
        description: "Health check endpoint",
        response: {
          200: {
            type: "object",
            properties: {
              status: { type: "string" },
              timestamp: { type: "string" },
              uptime: { type: "number" },
              version: { type: "string" },
            },
          },
        },
      },
    },
    async (_request, _reply) => {
      return {
        status: HealthStatus.HEALTHY,
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        version: "1.0.0",
        services: {
          streaming: streamingService ? "healthy" : "unavailable",
          database: "healthy", // Mock
        },
      };
    }
  );

  // Metrics endpoint
  server.get(
    "/metrics",
    {
      schema: {
        tags: ["Health"],
        description: "System metrics endpoint",
      },
    },
    async (_request, _reply) => {
      const streamingStats = streamingService?.getStats() || {};

      return {
        timestamp: new Date().toISOString(),
        system: {
          uptime: process.uptime(),
          memory: process.memoryUsage(),
          cpu: process.cpuUsage(),
        },
        streaming: streamingStats,
        requests: {
          total: 0, // Would be tracked by middleware
          success: 0,
          errors: 0,
        },
      };
    }
  );

  // User management routes
  const userRoutes = {
    // Create user
    "POST /api/v1/users": {
      schema: {
        tags: ["Users"],
        description: "Create a new user",
        body: {
          type: "object",
          required: ["username", "email", "password", "firstName", "lastName"],
          properties: {
            username: { type: "string", minLength: 3 },
            email: { type: "string", format: "email" },
            password: { type: "string", minLength: 8 },
            firstName: { type: "string", minLength: 1 },
            lastName: { type: "string", minLength: 1 },
            role: { type: "string", enum: [...UserRoleList] },
          },
        },
        response: {
          201: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: { type: "object" },
            },
          },
        },
      },
      handler: userController.createUser.bind(userController),
    },

    // Get user by ID
    "GET /api/v1/users/:id": {
      schema: {
        tags: ["Users"],
        description: "Get user by ID",
        params: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
        },
      },
      preHandler: [requireAuthentication],
      handler: userController.getUserById.bind(userController),
    },

    // Get users with filtering
    "GET /api/v1/users": {
      schema: {
        tags: ["Users"],
        description: "Get users with advanced filtering and pagination",
        querystring: {
          type: "object",
          properties: {
            search: { type: "string" },
            role: { type: "string", enum: [...UserRoleList] },
            status: { type: "string", enum: [...UserStatusList] },
            page: { type: "integer", minimum: 1 },
            limit: { type: "integer", minimum: 1, maximum: 100 },
            sortBy: { type: "string" },
            sortOrder: { type: "string", enum: ["asc", "desc"] },
          },
        },
      },
      preHandler: [requireAuthentication],
      handler: userController.getUsers.bind(userController),
    },

    // Update user
    "PUT /api/v1/users/:id": {
      schema: {
        tags: ["Users"],
        description: "Update user",
        params: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
        },
        body: {
          type: "object",
          properties: {
            username: { type: "string", minLength: 3 },
            email: { type: "string", format: "email" },
            firstName: { type: "string", minLength: 1 },
            lastName: { type: "string", minLength: 1 },
            role: { type: "string", enum: [...UserRoleList] },
            status: { type: "string", enum: [...UserStatusList] },
          },
        },
      },
      preHandler: [requireAuthentication],
      handler: userController.updateUser.bind(userController),
    },

    // Delete user
    "DELETE /api/v1/users/:id": {
      schema: {
        tags: ["Users"],
        description: "Delete user (soft delete)",
        params: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
        },
      },
      preHandler: [requireAuthentication],
      handler: userController.deleteUser.bind(userController),
    },

    // Change password
    "POST /api/v1/users/:id/change-password": {
      schema: {
        tags: ["Users"],
        description: "Change user password",
        params: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
        },
        body: {
          type: "object",
          required: ["currentPassword", "newPassword", "confirmPassword"],
          properties: {
            currentPassword: { type: "string" },
            newPassword: { type: "string", minLength: 8 },
            confirmPassword: { type: "string", minLength: 8 },
          },
        },
      },
      preHandler: [requireAuthentication],
      handler: userController.changePassword.bind(userController),
    },

    // Upload avatar
    "POST /api/v1/users/:id/avatar": {
      schema: {
        tags: ["Users"],
        description: "Upload user avatar",
        params: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
        },
        consumes: ["multipart/form-data"],
      },
      preHandler: [requireAuthentication],
      handler: userController.uploadAvatar.bind(userController),
    },
  };

  // Register user routes using type-safe helper
  registerRoutes(server, userRoutes);

  // WebSocket streaming endpoint
  server.register(async function (fastify) {
    fastify.get(
      "/api/v1/stream",
      {
        websocket: true,
        schema: {
          tags: ["Streaming"],
          description: "WebSocket streaming endpoint for real-time communication",
        },
      },
      async (connection, request) => {
        await streamingService.handleConnection({ socket: connection }, request);
      }
    );
  });

  // Server-Sent Events endpoint
  server.get(
    "/api/v1/events",
    {
      schema: {
        tags: ["Streaming"],
        description: "Server-Sent Events endpoint for one-way streaming",
      },
    },
    async (request, reply) => {
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Cache-Control",
      });

      // Send initial connection event
      reply.raw.write(
        `data: ${JSON.stringify({
          type: "connection",
          message: "Connected to event stream",
          timestamp: new Date().toISOString(),
        })}\n\n`
      );

      // Send periodic heartbeat
      const heartbeat = setInterval(() => {
        reply.raw.write(
          `data: ${JSON.stringify({
            type: "heartbeat",
            timestamp: new Date().toISOString(),
          })}\n\n`
        );
      }, StreamingDefaultConfig.HEARTBEAT_INTERVAL_MS);

      // Clean up on connection close
      request.raw.on("close", () => {
        clearInterval(heartbeat);
      });
    }
  );

  // File upload endpoint
  server.post(
    "/api/v1/files/upload",
    {
      schema: {
        tags: ["Files"],
        description: "Upload files with validation and processing",
        consumes: ["multipart/form-data"],
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  filename: { type: "string" },
                  size: { type: "number" },
                  mimetype: { type: "string" },
                  url: { type: "string" },
                },
              },
            },
          },
          400: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              error: {
                type: "object",
                properties: {
                  code: { type: "string" },
                  message: { type: "string" },
                },
              },
            },
          },
          500: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              error: {
                type: "object",
                properties: {
                  code: { type: "string" },
                  message: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const data = await request.file();

        if (!data) {
          return reply.code(HttpStatus.BAD_REQUEST).send({
            success: false,
            error: {
              code: UserErrorCode.NO_FILE_UPLOADED,
              message: "No file was uploaded",
            },
          });
        }

        // Validate file size (10MB max)
        const buffer = await data.toBuffer();
        if (buffer.length > MAX_FILE_SIZE_BYTES) {
          return reply.code(HttpStatus.BAD_REQUEST).send({
            success: false,
            error: {
              code: UserErrorCode.FILE_TOO_LARGE,
              message: FILE_SIZE_ERROR_MESSAGE,
            },
          });
        }

        // In a real implementation, save to storage service
        const fileUrl = `/uploads/${Date.now()}-${data.filename}`;

        return {
          success: true,
          data: {
            filename: data.filename,
            size: buffer.length,
            mimetype: data.mimetype,
            url: fileUrl,
          },
        };
      } catch {
        return reply.code(HttpStatus.INTERNAL_SERVER_ERROR).send({
          success: false,
          error: {
            code: "UPLOAD_FAILED",
            message: "File upload failed",
          },
        });
      }
    }
  );

  // Bulk operations endpoint
  server.post(
    "/api/v1/users/bulk",
    {
      schema: {
        tags: ["Users"],
        description: "Bulk user operations (create, update, delete)",
        body: {
          type: "object",
          required: ["operation", "data"],
          properties: {
            operation: { type: "string", enum: ["create", "update", "delete"] },
            data: { type: "array" },
          },
        },
      },
      preHandler: [requireAuthentication, requireRole([UserRole.ADMIN])],
    },
    // Real implementation — was a mock that acknowledged the operation and
    // persisted nothing.
    userController.bulkOperation.bind(userController)
  );

  server.log.info("Routes registered successfully");
}

/**
 * Graceful shutdown handling
 */
const gracefulShutdown = async (): Promise<void> => {
  server.log.info("Shutting down gracefully...");

  try {
    if (streamingService) {
      await streamingService.shutdown();
    }
    await server.close();
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    server.log.error(`Error during shutdown: ${message}`);
    process.exit(1);
  }
};

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

/**
 * Start the server
 */
const start = async (): Promise<void> => {
  try {
    // Initialize everything
    await registerPlugins();
    registerMiddleware();
    initializeServices();
    registerApiRoutes();

    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : DEFAULT_PORT;
    const host = process.env.HOST || "0.0.0.0";

    await server.listen({ port, host });

    server.log.info(`🚀 API Scenarios server running on http://${host}:${port}`);
    server.log.info(`📚 API Documentation: http://localhost:${port}/docs`);
    server.log.info(`🏥 Health Check: http://localhost:${port}/health`);
    server.log.info(`📊 Metrics: http://localhost:${port}/metrics`);
    server.log.info("");
    server.log.info("🔧 Example API calls:");
    server.log.info("  • POST /api/v1/users - Create user");
    server.log.info("  • GET /api/v1/users?search=john - Search users");
    server.log.info(`  • ws://localhost:${port}/api/v1/stream - WebSocket streaming`);
    server.log.info("  • GET /api/v1/events - Server-Sent Events");
    server.log.info("  • POST /api/v1/files/upload - File upload");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    server.log.error(`Failed to start server: ${message}`);
    process.exit(1);
  }
};

declare const require: NodeRequire;
declare const module: NodeModule;
if (typeof require !== "undefined" && require.main === module) {
  start();
}

export default server;

/**
 * Build the server instance with all plugins and routes (no listen).
 * Used by generate-openapi.ts to produce OpenAPI JSON without starting the server.
 */
export async function buildServerForOpenAPI(): Promise<FastifyInstance> {
  await registerPlugins();
  registerMiddleware();
  initializeServices();
  registerApiRoutes();
  return server;
}

/**
 * Create a fresh Fastify instance fully configured for tests
 * - Registers plugins, middleware, services, and routes
 * - Does NOT call listen(); safe to use with app.inject
 */
export async function createTestServer(): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({ logger: { level: "warn" } });

  // Inline equivalents of register functions bound to this app
  await app.register(cors, { origin: true, credentials: true });
  await app.register(multipart, { limits: { fileSize: MAX_FILE_SIZE_BYTES } });
  await app.register(websocket);
  await app.register(swagger as unknown as Parameters<typeof app.register>[0], {
    swagger: {
      info: {
        title: "API Scenarios Documentation",
        description: "Comprehensive API examples demonstrating various patterns and scenarios",
        version: "1.0.0",
      },
      host: `localhost:${DEFAULT_PORT}`,
      schemes: ["http", "https"],
      consumes: ["application/json", "multipart/form-data"],
      produces: ["application/json"],
      tags: [
        { name: "Users", description: "User management endpoints" },
        { name: "Streaming", description: "Real-time streaming endpoints" },
        { name: "Files", description: "File upload and download endpoints" },
        { name: "Health", description: "Health monitoring endpoints" },
      ],
      securityDefinitions: {
        Bearer: {
          type: "apiKey",
          name: "Authorization",
          in: "header",
          description: "Enter: Bearer {token}",
        },
      },
    },
  });
  await app.register(swaggerUi, {
    routePrefix: "/docs",
    uiConfig: { docExpansion: "list", deepLinking: false },
  });

  // Middleware
  app.addHook("preHandler", requestContextMiddleware);
  app.addHook("preHandler", securityHeaders);
  app.addHook("preHandler", corsContext);
  app.addHook("preHandler", sanitizeRequest);
  app.addHook("preHandler", rateLimitContext);
  app.addHook("onSend", responseTimeMiddleware);
  app.setErrorHandler((error, request, reply) =>
    errorContextMiddleware(
      error instanceof Error ? error : new Error("Unknown error"),
      request,
      reply
    )
  );

  // Services
  const localStreamingService = new StreamingService({
    maxConnections: StreamingDefaultConfig.MAX_CONNECTIONS,
    messageRateLimit: StreamingDefaultConfig.MESSAGE_RATE_LIMIT,
    heartbeatInterval: StreamingDefaultConfig.HEARTBEAT_INTERVAL_MS,
    connectionTimeout: StreamingDefaultConfig.CONNECTION_TIMEOUT_MS,
    enablePersistence: true,
    maxMessageHistory: StreamingDefaultConfig.MAX_MESSAGE_HISTORY,
  });
  const userRepository = new MockUserRepository();
  const userService = new CrudService<User>(userRepository, {
    entityName: "User",
    auditEnabled: true,
    softDelete: true,
    permissions: {
      create: [UserRole.ADMIN, UserRole.MANAGER],
      read: [UserRole.ADMIN, UserRole.MANAGER, UserRole.USER],
      update: [UserRole.ADMIN, UserRole.MANAGER, UserRole.USER],
      delete: [UserRole.ADMIN],
    },
  });
  const localUserController = new UserController(userService);

  // Routes
  app.get("/", async (_request, _reply) => {
    return {
      service: "API Scenarios Examples",
      version: "1.0.0",
      description: "Comprehensive API patterns and scenarios demonstration",
      features: [
        "Full CRUD operations with advanced querying",
        "Real-time streaming with WebSockets",
        "File upload and download handling",
        "Authentication and authorization",
        "Rate limiting and security",
        "API documentation with Swagger",
        "Health monitoring and metrics",
        "Bulk operations and batch processing",
      ],
      endpoints: {
        documentation: "/docs",
        health: "/health",
        metrics: "/metrics",
        users: "/api/v1/users",
        streaming: "/api/v1/stream",
        files: "/api/v1/files",
      },
    };
  });

  app.get("/health", async (_request, _reply) => {
    return {
      status: HealthStatus.HEALTHY,
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: "1.0.0",
      services: {
        streaming: localStreamingService ? "healthy" : "unavailable",
        database: "healthy",
      },
    };
  });

  app.get("/metrics", async (_request, _reply) => {
    const streamingStats = localStreamingService?.getStats() || {};
    return {
      timestamp: new Date().toISOString(),
      system: {
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        cpu: process.cpuUsage(),
      },
      streaming: streamingStats,
      requests: { total: 0, success: 0, errors: 0 },
    };
  });

  // User routes using type-safe helper (subset mirrors main server)
  const testUserRoutes = {
    "POST /api/v1/users": {
      handler: localUserController.createUser.bind(localUserController),
    },
    "GET /api/v1/users/:id": {
      preHandler: [requireAuthentication],
      handler: localUserController.getUserById.bind(localUserController),
    },
    "GET /api/v1/users": {
      preHandler: [requireAuthentication],
      handler: localUserController.getUsers.bind(localUserController),
    },
    "PUT /api/v1/users/:id": {
      preHandler: [requireAuthentication],
      handler: localUserController.updateUser.bind(localUserController),
    },
    "DELETE /api/v1/users/:id": {
      preHandler: [requireAuthentication],
      handler: localUserController.deleteUser.bind(localUserController),
    },
    "POST /api/v1/users/:id/change-password": {
      preHandler: [requireAuthentication],
      handler: localUserController.changePassword.bind(localUserController),
    },
    "POST /api/v1/users/:id/avatar": {
      preHandler: [requireAuthentication],
      handler: localUserController.uploadAvatar.bind(localUserController),
    },
    "POST /api/v1/users/bulk": {
      preHandler: [requireAuthentication, requireRole([UserRole.ADMIN])],
      handler: localUserController.bulkOperation.bind(localUserController),
    },
  };

  registerRoutes(app, testUserRoutes);

  // WS
  app.register(async function (fastify) {
    fastify.get("/api/v1/stream", { websocket: true }, async (connection, request) => {
      await localStreamingService.handleConnection({ socket: connection }, request);
    });
  });

  // SSE
  app.get("/api/v1/events", async (request, reply) => {
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    reply.raw.write(
      `data: ${JSON.stringify({ type: "connection", message: "Connected to event stream", timestamp: new Date().toISOString() })}\n\n`
    );
    // For tests, end the stream quickly; clear timer if client closes first
    const endTimer = setTimeout(() => {
      try {
        reply.raw.end();
      } catch (error) {
        console.error("Error ending event stream response:", error);
      }
    }, 10);
    request.raw.on("close", () => {
      clearTimeout(endTimer);
    });
  });

  // File upload (request has .file() from @fastify/multipart)
  app.post("/api/v1/files/upload", async (request, reply) => {
    try {
      const multipartRequest = request as {
        file?: () => Promise<
          { toBuffer: () => Promise<Buffer>; filename: string; mimetype: string } | undefined
        >;
      };
      const data = await multipartRequest.file?.();
      if (!data) {
        return reply.code(HttpStatus.BAD_REQUEST).send({
          success: false,
          error: { code: UserErrorCode.NO_FILE_UPLOADED, message: "No file was uploaded" },
        });
      }
      const buffer = await data.toBuffer();
      if (buffer.length > MAX_FILE_SIZE_BYTES) {
        return reply.code(HttpStatus.BAD_REQUEST).send({
          success: false,
          error: {
            code: UserErrorCode.FILE_TOO_LARGE,
            message: FILE_SIZE_ERROR_MESSAGE,
          },
        });
      }
      const fileUrl = `/uploads/${Date.now()}-${data.filename}`;
      return {
        success: true,
        data: {
          filename: data.filename,
          size: buffer.length,
          mimetype: data.mimetype,
          url: fileUrl,
        },
      };
    } catch (error) {
      app.log.error(error);
      return reply
        .code(HttpStatus.INTERNAL_SERVER_ERROR)
        .send({ success: false, error: { code: "UPLOAD_FAILED", message: "File upload failed" } });
    }
  });

  app.addHook("onClose", async () => {
    await localStreamingService.shutdown();
  });

  return app;
}
