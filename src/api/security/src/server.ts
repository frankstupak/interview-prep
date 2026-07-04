// server.ts
import Fastify, { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import swagger from "@fastify/swagger";
import crypto from "crypto";
import { z } from "zod";
import { AuthenticationManager } from "./auth-methods";
import { RoleBasedAccessControl, Permission } from "./rbac";
import { AuthType, AuthConfig, AuthContext, Role } from "./auth-types";
import { HttpStatus, AuthErrorCode, AuthHeaderPrefix, AuthHeaderName, AuthConfigDefaults, AuthErrorMessage } from "./constants";

/** Request with optional auth context set by authorize middleware */
export interface RequestWithAuth extends FastifyRequest {
  authContext?: AuthContext;
}

/** Register body shape */
interface RegisterBody {
  username?: string;
  password?: string;
  email?: string;
  roles?: Role[];
}

/** Login body shape */
interface LoginBody {
  username?: string;
  password?: string;
  authType?: AuthType;
}

/** OAuth token body shape */
interface OAuthTokenBody {
  grant_type?: string;
  username?: string;
  password?: string;
  refresh_token?: string;
}

// ----- Zod schemas for request validation -----
const registerBodySchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
  email: z.string().email("Valid email is required"),
  roles: z.array(z.nativeEnum(Role)).optional().default([Role.USER]),
});

const loginBodySchema = z.object({
  username: z.string().min(1, "Username is required"),
  password: z.string().min(1, "Password is required"),
  authType: z.nativeEnum(AuthType).optional(),
});

const oauthPasswordGrantSchema = z.object({
  grant_type: z.literal("password"),
  username: z.string().min(1),
  password: z.string().min(1),
});

const oauthRefreshGrantSchema = z.object({
  grant_type: z.literal("refresh_token"),
  refresh_token: z.string().min(1),
});

const oauthTokenBodySchema = z.union([oauthPasswordGrantSchema, oauthRefreshGrantSchema]);

const apiKeyCreateBodySchema = z.object({
  name: z.string().min(1, "API key name is required"),
  scopes: z.array(z.string()).optional().default(["read", "write"]),
  expiresAt: z
    .string()
    .optional()
    .transform((s) => (s ? new Date(s) : undefined)),
});

const keyIdParamsSchema = z.object({ keyId: z.string().min(1) });
const userIdParamsSchema = z.object({ userId: z.string().min(1) });
const contentIdParamsSchema = z.object({ contentId: z.string().min(1) });
const idParamsSchema = z.object({ id: z.string().min(1) });

const contentCreateBodySchema = z.object({
  title: z.string().optional(),
  body: z.string().optional(),
});

const contentUpdateBodySchema = z.record(z.unknown());

// Allow-list of self-service profile fields. Anything else in the body
// (roles, passwordHash, id, ...) is ignored — see PUT /auth/profile.
const profileUpdateBodySchema = z.object({
  email: z.string().email().optional(),
  username: z.string().min(1).optional(),
});

const apiDataPostBodySchema = z.record(z.unknown());

const roleParamsSchema = z.object({
  role: z.enum([Role.ADMIN, Role.USER, Role.GUEST]),
});

// Validate JWT secret is set
if (!process.env.JWT_SECRET) {
  console.warn("JWT_SECRET environment variable is required for production use");
  console.warn("Set JWT_SECRET in your environment or .env file");
  process.exit(1);
}

const config: AuthConfig = {
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: AuthConfigDefaults.JWT_EXPIRES_IN,
  sessionExpiresIn: AuthConfigDefaults.SESSION_EXPIRES_MS,
  bcryptRounds: AuthConfigDefaults.BCRYPT_ROUNDS,
  bearerTokenExpiresIn: AuthConfigDefaults.BEARER_TOKEN_EXPIRES_MS,
  refreshTokenExpiresIn: AuthConfigDefaults.REFRESH_TOKEN_EXPIRES_MS,
  apiKeyPrefix: AuthConfigDefaults.API_KEY_PREFIX,
};

/** Create and configure the Fastify app with swagger and routes (no listen). */
export async function createApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(swagger as unknown as Parameters<typeof app.register>[0], {
    openapi: {
      info: { title: "Security API", description: "Authentication and RBAC", version: "1.0.0" },
      servers: [{ url: "http://localhost:3000", description: "Development" }],
    },
  });

  const authManager = new AuthenticationManager(config);
  const rbac = new RoleBasedAccessControl();

  // Authentication middleware
  async function authenticate(
    request: FastifyRequest,
    reply: FastifyReply
  ): Promise<AuthContext | null> {
    const authHeader = request.headers[AuthHeaderName.AUTHORIZATION];
    const sessionToken = request.headers[AuthHeaderName.X_SESSION_TOKEN] as string;
    const apiKey = request.headers[AuthHeaderName.X_API_KEY] as string;

    if (!authHeader && !sessionToken && !apiKey) {
      reply.code(HttpStatus.UNAUTHORIZED).send({
        error: AuthErrorCode.AUTHENTICATION_REQUIRED,
        message: AuthErrorMessage.NO_AUTH_PROVIDED,
      });
      return null;
    }

    let authResult;
    let authType: AuthType;

    try {
      if (apiKey) {
        // API Key authentication
        authType = AuthType.API_KEY;
        authResult = await authManager.authenticateApiKey(apiKey);
      } else if (sessionToken) {
        // Session token authentication
        authType = AuthType.SESSION_TOKEN;
        authResult = await authManager.authenticateSessionToken(sessionToken);
      } else if (authHeader?.startsWith(AuthHeaderPrefix.BASIC)) {
        // Basic authentication
        authType = AuthType.BASIC;
        authResult = await authManager.authenticateBasic(authHeader);
      } else if (authHeader?.startsWith(AuthHeaderPrefix.BEARER)) {
        const token = authHeader.slice(AuthHeaderPrefix.BEARER.length);

        // JWTs are structurally three dot-separated segments; the opaque
        // bearer tokens issued here never contain dots. Routing by shape
        // (instead of try-JWT-then-fall-back) avoids a wasted signature
        // verification on every opaque-token request AND stops masking JWT
        // errors — an expired JWT used to be reported as
        // "Invalid bearer token" because the fallback overwrote the result.
        if (token.split(".").length === 3) {
          authType = AuthType.JWT;
          authResult = await authManager.authenticateJWT(token);
        } else {
          authType = AuthType.BEARER_TOKEN;
          authResult = await authManager.authenticateBearerToken(token);
        }
      } else {
        reply.code(HttpStatus.UNAUTHORIZED).send({
          error: AuthErrorCode.INVALID_AUTH_FORMAT,
          message: AuthErrorMessage.INVALID_AUTH_FORMAT,
        });
        return null;
      }

      if (!authResult.success) {
        reply
          .code(HttpStatus.UNAUTHORIZED)
          .send({ error: AuthErrorCode.AUTHENTICATION_FAILED, message: authResult.error });
        return null;
      }

      return {
        user: authResult.user,
        authType,
        session: authResult.session,
      };
    } catch (error) {
      app.log.error(error);
      reply.code(HttpStatus.UNAUTHORIZED).send({
        error: AuthErrorCode.AUTHENTICATION_ERROR,
        message: AuthErrorMessage.AUTH_PROCESSING_FAILED,
      });
      return null;
    }
  }

  // Authorization middleware
  function authorize(permission: Permission) {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const authContext = await authenticate(request, reply);
      if (!authContext) return; // authenticate already sent error response

      const authCheck = rbac.requirePermission(permission)(authContext);
      if (!authCheck.allowed) {
        reply
          .code(HttpStatus.FORBIDDEN)
          .send({ error: AuthErrorCode.AUTHORIZATION_FAILED, message: authCheck.error });
        return;
      }

      // Add auth context to request for use in handlers
      (request as RequestWithAuth).authContext = authContext;
    };
  }

  // Public endpoints (no authentication required)

  // Health check
  app.get("/health", async (_request, _reply) => {
    return { status: "ok", timestamp: new Date().toISOString() };
  });

  // Register new user
  app.post("/auth/register", async (request: FastifyRequest<{ Body: RegisterBody }>, reply) => {
    const parsed = registerBodySchema.safeParse(request.body);
    if (!parsed.success) {
      const message = parsed.error.errors.map((e) => e.message).join("; ") || "Validation failed";
      return reply.code(HttpStatus.BAD_REQUEST).send({
        error: AuthErrorCode.INVALID_REQUEST,
        message,
      });
    }
    const body = parsed.data;

    const result = await authManager.registerUser({
      username: body.username,
      password: body.password,
      email: body.email,
      roles: body.roles,
    });

    if (!result.success) {
      return reply
        .code(HttpStatus.BAD_REQUEST)
        .send({ error: AuthErrorCode.REGISTRATION_FAILED, message: result.error });
    }

    return reply.code(HttpStatus.CREATED).send({
      message: "User registered successfully",
      user: result.user,
    });
  });

  // Login with different auth types
  app.post("/auth/login", async (request: FastifyRequest<{ Body: LoginBody }>, reply) => {
    const parsed = loginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      const message = parsed.error.errors.map((e) => e.message).join("; ") || "Validation failed";
      return reply.code(HttpStatus.BAD_REQUEST).send({
        error: AuthErrorCode.INVALID_REQUEST,
        message,
      });
    }
    const body = parsed.data;
    const authType = body.authType ?? AuthType.JWT;

    const result = await authManager.login(
      {
        username: body.username,
        password: body.password,
      },
      authType
    );

    if (!result.success) {
      return reply
        .code(HttpStatus.UNAUTHORIZED)
        .send({ error: AuthErrorCode.LOGIN_FAILED, message: result.error });
    }

    const response: {
      message: string;
      user: typeof result.user;
      authType: AuthType;
      token?: string;
      session?: { id: string; expiresAt: Date };
    } = {
      message: "Login successful",
      user: result.user,
      authType,
    };

    if (result.token) {
      response.token = result.token;
    }

    if (result.session) {
      response.session = {
        id: result.session.id,
        expiresAt: result.session.expiresAt,
      };
    }

    return reply.send(response);
  });

  // Logout
  app.post("/auth/logout", async (request, reply) => {
    const authHeader = request.headers[AuthHeaderName.AUTHORIZATION];
    const sessionToken = request.headers[AuthHeaderName.X_SESSION_TOKEN] as string;
    const apiKey = request.headers[AuthHeaderName.X_API_KEY] as string;

    let token: string;
    let authType: AuthType;

    if (apiKey) {
      authType = AuthType.API_KEY;
      token = "";
    } else if (sessionToken) {
      token = sessionToken;
      authType = AuthType.SESSION_TOKEN;
    } else if (authHeader?.startsWith(AuthHeaderPrefix.BEARER)) {
      token = authHeader.slice(AuthHeaderPrefix.BEARER.length);
      // Route by token shape — JWT logout now actually revokes the token
      // instead of defaulting to a bearer-token lookup that always misses.
      authType = token.split(".").length === 3 ? AuthType.JWT : AuthType.BEARER_TOKEN;
    } else {
      authType = AuthType.BASIC;
      token = ""; // Basic auth doesn't need token cleanup
    }

    const result = await authManager.logout(token, authType);

    return reply.send({
      message: "Logout successful",
      success: result.success,
    });
  });

  // OAuth-style token endpoint
  app.post("/oauth/token", async (request: FastifyRequest<{ Body: OAuthTokenBody }>, reply) => {
    const parsed = oauthTokenBodySchema.safeParse(request.body);
    if (!parsed.success) {
      const isUnsupported =
        request.body &&
        typeof request.body === "object" &&
        "grant_type" in request.body &&
        request.body.grant_type !== "password" &&
        request.body.grant_type !== "refresh_token";
      if (isUnsupported) {
        return reply.code(HttpStatus.BAD_REQUEST).send({
          error: AuthErrorCode.UNSUPPORTED_GRANT_TYPE,
          error_description: "Only password and refresh_token grants are supported",
        });
      }
      return reply.code(HttpStatus.BAD_REQUEST).send({
        error: AuthErrorCode.INVALID_REQUEST,
        error_description: parsed.error.errors.map((e) => e.message).join("; ") || "Invalid request",
      });
    }

    const body = parsed.data;

    if (body.grant_type === "password") {
      const result = await authManager.login(
        { username: body.username, password: body.password },
        AuthType.BEARER_TOKEN
      );

      if (!result.success) {
        return reply.code(HttpStatus.UNAUTHORIZED).send({
          error: AuthErrorCode.INVALID_GRANT,
          error_description: result.error,
        });
      }

      // The old implementation returned the literal string
      // "hidden_for_security" as the refresh_token, which made the
      // refresh_token grant unusable end-to-end through this endpoint.
      // login() now returns the real refresh token for BEARER_TOKEN logins.
      return reply.send({
        access_token: result.token,
        token_type: "Bearer",
        expires_in: Math.floor(config.bearerTokenExpiresIn / 1000),
        refresh_token: result.refreshToken,
        scope: "read write",
      });
    } else {
      const result = await authManager.refreshBearerToken(body.refresh_token);

      if ("success" in result && !result.success) {
        return reply.code(HttpStatus.UNAUTHORIZED).send({
          error: AuthErrorCode.INVALID_GRANT,
          error_description: result.error,
        });
      }

      return reply.send(result);
    }
  });

  // Protected endpoints (authentication required)

  // Get current user profile
  app.get(
    "/auth/profile",
    { preHandler: authorize(Permission.READ_USER) },
    async (request: RequestWithAuth, _reply) => {
      const { user } = request.authContext!;
      const permissions = rbac.getUserPermissions(user);

      return {
        user,
        permissions,
        authType: request.authContext!.authType,
      };
    }
  );

  // Update user profile (users can update their own profile)
  app.put(
    "/auth/profile",
    { preHandler: authorize(Permission.UPDATE_USER) },
    async (request: RequestWithAuth, reply) => {
      const { user } = request.authContext!;
      const parsed = profileUpdateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(HttpStatus.BAD_REQUEST).send({
          error: AuthErrorCode.INVALID_REQUEST,
          message: "Invalid profile update payload",
        });
      }
      // Mass-assignment fix: the old handler spread the raw body over the
      // user ({ ...user, ...body }), letting a request override roles or
      // passwordHash in the returned object — and persisted nothing. Updates
      // now go through an allow-list and are actually stored.
      const result = authManager.updateUser(user.id, parsed.data);
      if (!result.success) {
        return reply.code(HttpStatus.BAD_REQUEST).send({
          error: AuthErrorCode.INVALID_REQUEST,
          message: result.error,
        });
      }
      return reply.send({
        message: "Profile updated successfully",
        user: result.user,
      });
    }
  );

  // API Key Management
  app.post(
    "/auth/api-keys",
    { preHandler: authorize(Permission.API_WRITE) },
    async (request: RequestWithAuth, reply) => {
      const { user } = request.authContext!;
      const parsed = apiKeyCreateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        const message = parsed.error.errors.map((e) => e.message).join("; ") || "Validation failed";
        return reply.code(HttpStatus.BAD_REQUEST).send({
          error: AuthErrorCode.INVALID_REQUEST,
          message,
        });
      }
      const body = parsed.data;

      const result = await authManager.createApiKey(user.id, {
        name: body.name,
        scopes: body.scopes,
        expiresAt: body.expiresAt,
      });

      if (!result.success) {
        return reply.code(HttpStatus.BAD_REQUEST).send({
          error: AuthErrorCode.API_KEY_CREATION_FAILED,
          message: result.error,
        });
      }

      return reply.code(HttpStatus.CREATED).send({
        message: "API key created successfully",
        apiKey: result.apiKey, // Only returned once!
        keyInfo: result.keyInfo,
      });
    }
  );

  app.get(
    "/auth/api-keys",
    { preHandler: authorize(Permission.API_READ) },
    async (request: RequestWithAuth, reply) => {
      const { user } = request.authContext!;
      const apiKeys = authManager.getUserApiKeys(user.id);

      return reply.send({
        apiKeys,
        total: apiKeys.length,
      });
    }
  );

  app.delete(
    "/auth/api-keys/:keyId",
    { preHandler: authorize(Permission.API_WRITE) },
    async (request: RequestWithAuth, reply) => {
      const { user } = request.authContext!;
      const parsed = keyIdParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(HttpStatus.BAD_REQUEST).send({
          error: AuthErrorCode.INVALID_REQUEST,
          message: "keyId is required",
        });
      }
      const { keyId } = parsed.data;

      const result = await authManager.revokeApiKey(user.id, keyId);

      if (!result.success) {
        return reply.code(HttpStatus.NOT_FOUND).send({
          error: AuthErrorCode.API_KEY_NOT_FOUND,
          message: result.error,
        });
      }

      return reply.send({
        message: "API key revoked successfully",
        keyId: parsed.data.keyId,
      });
    }
  );

  // Admin endpoints

  // List all users (admin only)
  app.get(
    "/admin/users",
    { preHandler: authorize(Permission.ADMIN_ACCESS) },
    async (_request: RequestWithAuth, _reply) => {
      const users = authManager.getAllUsers();
      return { users, total: users.length };
    }
  );

  // Get user by ID (admin only)
  app.get(
    "/admin/users/:userId",
    { preHandler: authorize(Permission.ADMIN_ACCESS) },
    async (request: RequestWithAuth, reply) => {
      const parsed = userIdParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(HttpStatus.BAD_REQUEST).send({
          error: AuthErrorCode.INVALID_REQUEST,
          message: "userId is required",
        });
      }
      const { userId } = parsed.data;
      const user = authManager.getUser(userId);

      if (!user) {
        return reply
          .code(HttpStatus.NOT_FOUND)
          .send({ error: AuthErrorCode.USER_NOT_FOUND, message: AuthErrorMessage.USER_NOT_FOUND });
      }

      const permissions = rbac.getUserPermissions(user);
      return { user, permissions };
    }
  );

  // List active sessions (admin only)
  app.get(
    "/admin/sessions",
    { preHandler: authorize(Permission.ADMIN_ACCESS) },
    async (_request: RequestWithAuth, _reply) => {
      const sessions = authManager.getActiveSessions();
      return { sessions, total: sessions.length };
    }
  );

  // Clear expired sessions (admin only)
  app.post(
    "/admin/sessions/cleanup",
    { preHandler: authorize(Permission.ADMIN_ACCESS) },
    async (_request: RequestWithAuth, _reply) => {
      const cleared = authManager.clearExpiredSessions();
      return { message: `Cleared ${cleared} expired sessions`, cleared };
    }
  );

  // List active bearer tokens (admin only)
  app.get(
    "/admin/bearer-tokens",
    { preHandler: authorize(Permission.ADMIN_ACCESS) },
    async (_request: RequestWithAuth, _reply) => {
      const tokens = authManager.getActiveBearerTokens();
      return { tokens, total: tokens.length };
    }
  );

  // Clear expired bearer tokens (admin only)
  app.post(
    "/admin/bearer-tokens/cleanup",
    { preHandler: authorize(Permission.ADMIN_ACCESS) },
    async (_request: RequestWithAuth, _reply) => {
      const cleared = authManager.clearExpiredBearerTokens();
      return { message: `Cleared ${cleared} expired bearer tokens`, cleared };
    }
  );

  // Content management endpoints (demonstrating different permission levels)

  // Read content (all authenticated users)
  app.get(
    "/content",
    { preHandler: authorize(Permission.READ_CONTENT) },
    async (_request: RequestWithAuth, _reply) => {
      return {
        content: [
          { id: "1", title: "Public Content", body: "This is public content", author: "system" },
          { id: "2", title: "User Content", body: "This is user content", author: "user" },
        ],
      };
    }
  );

  // Create content (users and admins)
  app.post(
    "/content",
    { preHandler: authorize(Permission.CREATE_CONTENT) },
    async (request: RequestWithAuth, reply) => {
      const { user } = request.authContext!;
      const parsed = contentCreateBodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(HttpStatus.BAD_REQUEST).send({
          error: AuthErrorCode.INVALID_REQUEST,
          message: parsed.error.errors.map((e) => e.message).join("; ") || "Invalid body",
        });
      }
      const body = parsed.data;

      const content = {
        id: crypto.randomUUID(),
        title: body.title,
        body: body.body,
        author: user.username,
        createdAt: new Date(),
      };

      return reply
        .code(HttpStatus.CREATED)
        .send({ message: "Content created successfully", content });
    }
  );

  // Update content (content owner or admin)
  app.put(
    "/content/:contentId",
    { preHandler: authorize(Permission.UPDATE_CONTENT) },
    async (request: RequestWithAuth, reply) => {
      const { user } = request.authContext!;
      const paramsParsed = contentIdParamsSchema.safeParse(request.params);
      const bodyParsed = contentUpdateBodySchema.safeParse(request.body);
      if (!paramsParsed.success) {
        return reply.code(HttpStatus.BAD_REQUEST).send({
          error: AuthErrorCode.INVALID_REQUEST,
          message: "contentId is required",
        });
      }
      if (!bodyParsed.success) {
        return reply.code(HttpStatus.BAD_REQUEST).send({
          error: AuthErrorCode.INVALID_REQUEST,
          message: "Invalid update payload",
        });
      }
      const { contentId } = paramsParsed.data;
      const body = bodyParsed.data;

      const canAccess = rbac.canAccessResource(user, user.id, Permission.UPDATE_CONTENT);

      if (!canAccess) {
        return reply
          .code(HttpStatus.FORBIDDEN)
          .send({ error: AuthErrorCode.ACCESS_DENIED, message: "Cannot update this content" });
      }

      return { message: "Content updated successfully", contentId, updates: body };
    }
  );

  // Delete content (content owner or admin)
  app.delete(
    "/content/:contentId",
    { preHandler: authorize(Permission.DELETE_CONTENT) },
    async (request: RequestWithAuth, reply) => {
      const { user } = request.authContext!;
      const parsed = contentIdParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(HttpStatus.BAD_REQUEST).send({
          error: AuthErrorCode.INVALID_REQUEST,
          message: "contentId is required",
        });
      }

      const canAccess = rbac.canAccessResource(user, user.id, Permission.DELETE_CONTENT);

      if (!canAccess) {
        return reply
          .code(HttpStatus.FORBIDDEN)
          .send({ error: AuthErrorCode.ACCESS_DENIED, message: "Cannot delete this content" });
      }

      return { message: "Content deleted successfully", contentId: parsed.data.contentId };
    }
  );

  // Role and permission management (admin only)

  // Get all roles and permissions
  app.get(
    "/admin/roles",
    { preHandler: authorize(Permission.MANAGE_ROLES) },
    async (_request: RequestWithAuth, _reply) => {
      const roles = rbac.getAllRoles();
      const permissions = rbac.getAllPermissions();

      const rolePermissions = roles.map((role) => ({
        role,
        permissions: rbac.getRolePermissions(role),
      }));

      return { roles, permissions, rolePermissions };
    }
  );

  // Get role permissions
  app.get(
    "/admin/roles/:role/permissions",
    { preHandler: authorize(Permission.MANAGE_ROLES) },
    async (request: RequestWithAuth, reply) => {
      const parsed = roleParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply
          .code(HttpStatus.BAD_REQUEST)
          .send({ error: AuthErrorCode.INVALID_ROLE, message: AuthErrorMessage.INVALID_ROLE_SPECIFIED });
      }
      const { role } = parsed.data;

      const permissions = rbac.getRolePermissions(role);
      return { role, permissions };
    }
  );

  // API testing endpoints with different permission levels

  // Public API endpoint
  app.get("/api/public", async (_request, _reply) => {
    return { message: "This is a public endpoint", timestamp: new Date().toISOString() };
  });

  // Read-only API endpoint
  app.get(
    "/api/data",
    { preHandler: authorize(Permission.API_READ) },
    async (request: RequestWithAuth, _reply) => {
      return {
        message: "This is protected read data",
        user: request.authContext!.user.username,
        data: ["item1", "item2", "item3"],
      };
    }
  );

  // Write API endpoint
  app.post(
    "/api/data",
    { preHandler: authorize(Permission.API_WRITE) },
    async (request: RequestWithAuth, reply) => {
      const parsed = apiDataPostBodySchema.safeParse(request.body ?? {});
      const data = parsed.success ? parsed.data : {};
      return reply.code(HttpStatus.CREATED).send({
        message: "Data created successfully",
        user: request.authContext!.user.username,
        data,
      });
    }
  );

  // Delete API endpoint (admin only)
  app.delete(
    "/api/data/:id",
    { preHandler: authorize(Permission.API_DELETE) },
    async (request: RequestWithAuth, reply) => {
      const parsed = idParamsSchema.safeParse(request.params);
      if (!parsed.success) {
        return reply.code(HttpStatus.BAD_REQUEST).send({
          error: AuthErrorCode.INVALID_REQUEST,
          message: "id is required",
        });
      }
      return {
        message: "Data deleted successfully",
        user: request.authContext!.user.username,
        deletedId: parsed.data.id,
      };
    }
  );

  // Error handling
  app.setErrorHandler((error, request, reply) => {
    request.log.error(error);
    reply.code(HttpStatus.INTERNAL_SERVER_ERROR).send({
      error: AuthErrorCode.INTERNAL_SERVER_ERROR,
      message: "An internal server error occurred",
    });
  });

  return app;
}

async function startServer(): Promise<void> {
  try {
    const app = await createApp();
    await app.listen({ port: 3000, host: "0.0.0.0" });
    app.log.info("Security API Server running on http://localhost:3000");
    app.log.info("Default users created: admin/admin123, user/user123, guest/guest123");
    app.log.info(
      "Auth: Basic, Session Token (X-Session-Token), JWT/Bearer (Authorization), API Key (X-API-Key)"
    );
    app.log.info("Endpoints: POST /oauth/token, POST/GET/DELETE /auth/api-keys");
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

// Start the server only when this file is executed directly (tsx src/server.ts
// or node dist/server.js). Importing createApp — e.g. from tests — must not
// bind port 3000 as a side effect of the import.
if (require.main === module) {
  startServer().catch((err: unknown) => {
    console.warn("Server failed to start:", err);
  });
}
