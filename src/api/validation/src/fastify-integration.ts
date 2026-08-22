// fastify-integration.ts - Fastify integration for Zod validation
import { FastifyInstance, FastifyRequest, FastifyReply, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import fp from "fastify-plugin";
import { ValidationEngine, globalValidationEngine } from "./validation-engine";
import {
  ValidationOptions,
  ValidationContext,
  ValidationErrorResponse,
  ValidationOutcome,
} from "./validation-types";
import { HttpStatus } from "./constants";

/**
 * Fastify plugin options for validation integration
 * Configures validation behavior across the application
 */
export interface FastifyValidationOptions extends FastifyPluginOptions {
  engine?: ValidationEngine; // Custom validation engine instance
  globalOptions?: ValidationOptions; // Default validation options
  errorHandler?: (error: ValidationErrorResponse, reply: FastifyReply) => void;
  contextExtractor?: (request: FastifyRequest) => ValidationContext;
}

/**
 * Request validation schemas for different parts of the request
 * Enables comprehensive request validation
 */
export interface RequestValidationSchemas {
  body?: z.ZodSchema<unknown>;
  querystring?: z.ZodSchema<unknown>;
  params?: z.ZodSchema<unknown>;
  headers?: z.ZodSchema<unknown>;
}

/**
 * Response validation schemas for different status codes
 * Enables response validation for API consistency
 */
export interface ResponseValidationSchemas {
  [statusCode: number]: z.ZodSchema<unknown>;
}

/**
 * Complete endpoint validation configuration
 * Defines all validation requirements for an endpoint
 */
export interface EndpointValidation {
  request?: RequestValidationSchemas;
  response?: ResponseValidationSchemas;
  options?: ValidationOptions;
  context?: ValidationContext;
}

/**
 * Fastify validation plugin
 * Integrates Zod validation with Fastify request/response lifecycle
 */
type RequestWithUser = FastifyRequest & { user?: { id?: string; role?: string } };

async function fastifyValidationPlugin(
  fastify: FastifyInstance,
  options: FastifyValidationOptions = {}
): Promise<void> {
  const engine = options.engine || globalValidationEngine;

  const defaultErrorHandler = (error: ValidationErrorResponse, reply: FastifyReply): void => {
    reply.code(HttpStatus.BAD_REQUEST).send(error);
  };

  const errorHandler = options.errorHandler || defaultErrorHandler;

  const defaultContextExtractor = (request: FastifyRequest): ValidationContext => ({
    userId: (request as RequestWithUser).user?.id,
    userRole: (request as RequestWithUser).user?.role,
    requestId: request.id,
    metadata: {
      ip: request.ip,
      userAgent: request.headers["user-agent"],
      method: request.method,
      url: request.url,
    },
  });

  const contextExtractor = options.contextExtractor || defaultContextExtractor;

  /**
   * Validate request data against schemas
   * Core validation function for request processing
   */
  async function validateRequest(
    request: FastifyRequest,
    schemas: RequestValidationSchemas,
    validationOptions?: ValidationOptions
  ): Promise<{
    body?: unknown;
    querystring?: unknown;
    params?: unknown;
    headers?: unknown;
    context: ValidationContext;
  }> {
    const context = contextExtractor(request);
    const results: {
      body?: unknown;
      querystring?: unknown;
      params?: unknown;
      headers?: unknown;
      context: ValidationContext;
    } = { context };

    // Validate request body
    // Why: Ensures request body matches expected schema
    if (schemas.body) {
      const bodyResult = await engine.validate(
        schemas.body,
        request.body,
        { ...options.globalOptions, ...validationOptions },
        context
      );

      if (!bodyResult.success) {
        throw bodyResult.error;
      }

      results.body = bodyResult.data;
    }

    // Validate query parameters
    // Why: Ensures query parameters are properly typed and validated
    if (schemas.querystring) {
      const queryResult = await engine.validate(
        schemas.querystring,
        request.query,
        { ...options.globalOptions, ...validationOptions },
        context
      );

      if (!queryResult.success) {
        throw queryResult.error;
      }

      results.querystring = queryResult.data;
    }

    // Validate route parameters
    // Why: Ensures route parameters match expected types
    if (schemas.params) {
      const paramsResult = await engine.validate(
        schemas.params,
        request.params,
        { ...options.globalOptions, ...validationOptions },
        context
      );

      if (!paramsResult.success) {
        throw paramsResult.error;
      }

      results.params = paramsResult.data;
    }

    // Validate request headers
    // Why: Ensures required headers are present and valid
    if (schemas.headers) {
      const headersResult = await engine.validate(
        schemas.headers,
        request.headers,
        { ...options.globalOptions, ...validationOptions },
        context
      );

      if (!headersResult.success) {
        throw headersResult.error;
      }

      results.headers = headersResult.data;
    }

    return results;
  }

  /**
   * Validate response data against schema
   * Ensures API responses match documented schemas
   */
  async function validateResponse(
    data: unknown,
    statusCode: number,
    schemas: ResponseValidationSchemas,
    context: ValidationContext,
    validationOptions?: ValidationOptions
  ): Promise<unknown> {
    const schema = schemas[statusCode];
    if (!schema) {
      // No validation schema for this status code
      return data;
    }

    const result = await engine.validate(
      schema,
      data,
      { ...options.globalOptions, ...validationOptions },
      context
    );

    if (!result.success) {
      fastify.log.warn(result.error, "Response validation error");
      return data;
    }

    return result.data;
  }

  /**
   * Create validation preHandler hook
   * Fastify hook that validates requests before handler execution
   */
  function createValidationPreHandler(
    schemas: RequestValidationSchemas,
    validationOptions?: ValidationOptions
  ): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
    return async function validationPreHandler(
      request: FastifyRequest,
      reply: FastifyReply
    ): Promise<void> {
      try {
        const validated = await validateRequest(request, schemas, validationOptions);
        (request as FastifyRequest & { validated: typeof validated }).validated = validated;
      } catch (error) {
        // Handle validation errors
        // Why: Provide consistent error responses for validation failures
        if (typeof error === "object" && error !== null && "error" in error) {
          errorHandler(error as ValidationErrorResponse, reply);
        } else {
          reply.code(HttpStatus.INTERNAL_SERVER_ERROR).send({
            error: "internal_server_error",
            message: "Validation processing failed",
          });
        }
      }
    };
  }

  /**
   * Create response validation hook
   * Fastify hook that validates responses before sending
   */
  function createResponseValidationHook(
    schemas: ResponseValidationSchemas,
    validationOptions?: ValidationOptions
  ): (request: FastifyRequest, reply: FastifyReply, payload: unknown) => Promise<unknown> {
    return async function responseValidationHook(
      request: FastifyRequest,
      reply: FastifyReply,
      payload: unknown
    ): Promise<unknown> {
      try {
        const context = contextExtractor(request);
        const validatedPayload = await validateResponse(
          payload,
          reply.statusCode,
          schemas,
          context,
          validationOptions
        );
        return validatedPayload;
      } catch (error) {
        fastify.log.warn(error, "Response validation failed");
        return payload;
      }
    };
  }

  // Register validation decorators on Fastify instance
  // Why: Provides convenient methods for adding validation to routes

  /**
   * Add request validation to a route
   * Decorator method for easy validation setup
   */
  fastify.decorate(
    "addValidation",
    function (
      this: FastifyInstance,
      validation: EndpointValidation
    ): {
      preHandler?: (req: FastifyRequest, rep: FastifyReply) => Promise<void>;
      preSerialization?: (
        req: FastifyRequest,
        rep: FastifyReply,
        payload: unknown
      ) => Promise<unknown>;
    } {
      const hooks: {
        preHandler?: (req: FastifyRequest, rep: FastifyReply) => Promise<void>;
        preSerialization?: (
          req: FastifyRequest,
          rep: FastifyReply,
          payload: unknown
        ) => Promise<unknown>;
      } = {};

      // Add request validation
      if (validation.request) {
        hooks.preHandler = createValidationPreHandler(validation.request, validation.options);
      }

      // Add response validation
      if (validation.response) {
        hooks.preSerialization = createResponseValidationHook(
          validation.response,
          validation.options
        );
      }

      return hooks;
    }
  );

  /**
   * Validate data using the configured engine
   * Direct access to validation engine from Fastify instance
   */
  fastify.decorate("validate", async function <
    T,
  >(schema: z.ZodType<T, z.ZodTypeDef, unknown>, data: unknown, validationOptions?: ValidationOptions, context?: ValidationContext): Promise<
    ValidationOutcome<T>
  > {
    return engine.validate(schema, data, validationOptions, context);
  });

  /**
   * Get validation metrics
   * Access to validation performance metrics
   */
  fastify.decorate("getValidationMetrics", function (): ReturnType<ValidationEngine["getMetrics"]> {
    return engine.getMetrics();
  });

  /**
   * Reset validation metrics
   * Clear accumulated validation statistics
   */
  fastify.decorate("resetValidationMetrics", function (): void {
    engine.resetMetrics();
  });
}

/**
 * Type-safe route handler with validation
 * Provides full type safety for validated requests
 */
export interface ValidatedRouteHandler<
  TBody = unknown,
  TQuerystring = unknown,
  TParams = unknown,
  THeaders = unknown,
> {
  (
    request: FastifyRequest & {
      validated: {
        body: TBody;
        querystring: TQuerystring;
        params: TParams;
        headers: THeaders;
        context: ValidationContext;
      };
    },
    reply: FastifyReply
  ): Promise<unknown> | unknown;
}

/**
 * Helper function to create type-safe validated routes
 * Combines route registration with validation setup
 */
export function createValidatedRoute<
  TBody = unknown,
  TQuerystring = unknown,
  TParams = unknown,
  THeaders = unknown,
>(
  fastify: FastifyInstance,
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH",
  url: string,
  validation: EndpointValidation,
  handler: ValidatedRouteHandler<TBody, TQuerystring, TParams, THeaders>
): void {
  type WithAddValidation = FastifyInstance & {
    addValidation(v: EndpointValidation): {
      preHandler?: (req: FastifyRequest, rep: FastifyReply) => Promise<void>;
      preSerialization?: (
        req: FastifyRequest,
        rep: FastifyReply,
        payload: unknown
      ) => Promise<unknown>;
    };
  };
  const hooks = (fastify as WithAddValidation).addValidation(validation);

  fastify.route({
    method,
    url,
    ...hooks,
    handler: handler as (
      request: FastifyRequest,
      reply: FastifyReply
    ) => Promise<unknown> | unknown,
  });
}

/**
 * Validation middleware factory
 * Creates reusable validation middleware for common patterns
 */
export const ValidationMiddleware = {
  /**
   * Require authentication for validation context
   * Ensures user context is available for validation
   */
  requireAuth: (
    request: FastifyRequest,
    reply: FastifyReply,
    done: (err?: Error) => void
  ): void => {
    if (!(request as RequestWithUser).user) {
      reply.code(HttpStatus.UNAUTHORIZED).send({
        error: "unauthorized",
        message: "Authentication required",
      });
      return;
    }
    done();
  },

  /**
   * Rate limiting for validation-heavy endpoints
   * Prevents abuse of validation endpoints
   *
   * NOTE: This returns a cleanup function that should be called when
   * the server shuts down to prevent memory leaks.
   */
  rateLimit: (
    maxRequests: number,
    windowMs: number
  ): ((request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => void) & {
    cleanup: () => void;
  } => {
    const requests = new Map<string, { count: number; resetTime: number }>();
    const MAX_ENTRIES = 10000; // Prevent unbounded growth

    // Cleanup old entries periodically
    const cleanupInterval = setInterval(() => {
      const now = Date.now();
      const currentWindow = Math.floor(now / windowMs) * windowMs;

      // Remove entries from previous windows
      for (const [key, data] of requests.entries()) {
        if (data.resetTime < currentWindow) {
          requests.delete(key);
        }
      }

      // If still too many entries, remove oldest ones (FIFO)
      if (requests.size > MAX_ENTRIES) {
        const entriesToRemove = requests.size - MAX_ENTRIES;
        const keys = Array.from(requests.keys());
        for (let i = 0; i < entriesToRemove; i++) {
          requests.delete(keys[i]);
        }
      }
    }, windowMs);

    // Return middleware with cleanup capability
    const middleware = (
      request: FastifyRequest,
      reply: FastifyReply,
      done: (err?: Error) => void
    ): void => {
      const key = request.ip;
      const now = Date.now();
      const windowStart = Math.floor(now / windowMs) * windowMs;

      let requestData = requests.get(key);
      if (!requestData || requestData.resetTime !== windowStart) {
        requestData = { count: 0, resetTime: windowStart };
      }

      requestData.count++;
      requests.set(key, requestData);

      if (requestData.count > maxRequests) {
        reply.code(HttpStatus.TOO_MANY_REQUESTS).send({
          error: "rate_limit_exceeded",
          message: "Too many validation requests",
        });
        return;
      }

      done();
    };

    const m = middleware as typeof middleware & { cleanup: () => void };
    m.cleanup = (): void => {
      clearInterval(cleanupInterval);
      requests.clear();
    };

    return m;
  },

  /**
   * Content type validation
   * Ensures request has expected content type
   */
  requireContentType: (
    contentType: string
  ): ((request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void) => void) => {
    const expected = contentType.toLowerCase();
    return (request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void): void => {
      // Compare the media type exactly (parameters like charset stripped).
      // The previous substring check (`includes`) accepted supersets such as
      // "application/jsonx" or "text/application/json-ish" for
      // "application/json".
      const header = request.headers["content-type"];
      const mediaType = header?.split(";")[0]?.trim().toLowerCase();
      if (mediaType !== expected) {
        reply.code(HttpStatus.UNSUPPORTED_MEDIA_TYPE).send({
          error: "unsupported_media_type",
          message: `Expected content type: ${contentType}`,
        });
        return;
      }
      done();
    };
  },
};

// Export the plugin with proper typing
// Declare 5.x to match validation module's Fastify peer (fixes OpenAPI generation)
export default fp(fastifyValidationPlugin, {
  name: "fastify-zod-validation",
  fastify: "5.x",
});

// Extend Fastify types to include validation decorators
declare module "fastify" {
  interface FastifyInstance {
    addValidation(validation: EndpointValidation): {
      preHandler?: (req: FastifyRequest, rep: FastifyReply) => Promise<void>;
      preSerialization?: (
        req: FastifyRequest,
        rep: FastifyReply,
        payload: unknown
      ) => Promise<unknown>;
    };
    validate<T>(
      schema: z.ZodType<T, z.ZodTypeDef, unknown>,
      data: unknown,
      options?: ValidationOptions,
      context?: ValidationContext
    ): Promise<ValidationOutcome<T>>;
    getValidationMetrics(): ReturnType<ValidationEngine["getMetrics"]>;
    resetValidationMetrics(): void;
  }
}
