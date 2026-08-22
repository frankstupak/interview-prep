import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import { randomUUID } from "node:crypto";
import Fastify, { FastifyInstance } from "fastify";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import validationPlugin, {
  ValidationMiddleware,
  createValidatedRoute,
  FastifyValidationOptions,
} from "./fastify-integration";
import {
  ValidationEngine,
  globalValidationEngine,
  validateData,
  validateBatch as validateBatchWrapper,
} from "./validation-engine";
import {
  ValidationErrorCode,
  ValidationPipeline,
  ValidationOutcome,
  ValidationOptions,
  ValidationErrorResponse,
} from "./validation-types";
import { CommonValidations } from "./validation-types";
import { UserSchemas, ProductSchemas, OrderSchemas, ApiSchemas } from "./validation-schemas";
import { HttpStatus } from "./constants";

describe("ValidationEngine", () => {
  let engine: ValidationEngine;

  beforeEach(() => {
    engine = new ValidationEngine();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it("strips unknown fields by default and records warnings", async () => {
    const schema = z.object({
      name: z.string(),
      age: z.number().int().min(0),
    });

    const result = await engine.validate(schema, { name: "Ada", age: 37, extra: true });
    const metrics = engine.getMetrics();

    expect(result.success).toBe(true);
    expect(result).toHaveProperty("warnings");
    expect(result.success && result.data).toEqual({ name: "Ada", age: 37 });
    expect(result.success && result.warnings).toEqual(["Stripped unknown fields: extra"]);
    expect(metrics.totalValidations).toBe(1);
    expect(metrics.successfulValidations).toBe(1);
    expect(metrics.failedValidations).toBe(0);
  });

  it("honors allowUnknown option and preserves fields", async () => {
    const schema = z.object({ name: z.string() });

    const options: ValidationOptions = {
      stripUnknown: false,
      allowUnknown: true,
      abortEarly: false,
      errorFormat: "detailed",
      transformData: true,
    };

    const result = await engine.validate(schema, { name: "Grace", nickname: "Amazing" }, options);

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({ name: "Grace", nickname: "Amazing" });
    expect(result.success && result.warnings).toBeUndefined();
  });

  it("returns structured errors and updates metrics on failure", async () => {
    const schema = z.object({ age: z.number().int().min(18) });
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);

    const result = await engine.validate(schema, { age: 10 });
    const metrics = engine.getMetrics();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.error).toBe("validation_error");
      expect(result.error.details[0].field).toBe("age");
      expect(result.error.details[0].code).toBe(ValidationErrorCode.TOO_SMALL);
    }
    expect(metrics.totalValidations).toBe(1);
    expect(metrics.successfulValidations).toBe(0);
    expect(metrics.failedValidations).toBe(1);
    consoleError.mockRestore();
  });

  it("fails when validation exceeds configured timeout", async () => {
    jest.useFakeTimers({ doNotFake: ["performance"] });
    const slowEngine = new ValidationEngine({ maxValidationTime: 5 });
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);

    const schema = z
      .string()
      .min(1)
      .transform(async (value) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return value;
      });

    const promise = slowEngine.validate(schema, "hello");
    jest.advanceTimersByTime(6);
    const result = await promise;
    const metrics = slowEngine.getMetrics();

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe("Validation timeout");
      expect(result.error.details[0].field).toBe("unknown");
      expect(result.error.details[0].code).toBe(ValidationErrorCode.CUSTOM);
    }
    expect(metrics.failedValidations).toBe(1);
    expect(metrics.totalValidations).toBe(1);
    consoleError.mockRestore();
  });

  it("supports validation pipelines with optional steps", async () => {
    const pipeline: ValidationPipeline<{ count: number }> = {
      name: "sample",
      steps: [
        {
          name: "basic",
          schema: z.object({ count: z.number().int().min(0) }),
        },
        {
          name: "optional-check",
          optional: true,
          validator: async () => ({
            success: false,
            error: {
              error: "validation_error",
              message: "optional failed",
              details: [
                {
                  field: "optional",
                  code: ValidationErrorCode.CUSTOM,
                  message: "optional failure",
                },
              ],
              timestamp: new Date().toISOString(),
            },
          }),
        },
      ],
    };

    const result = await engine.validatePipeline(pipeline, { count: 2 });

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({ count: 2 });
    expect(result.success && result.warnings).toEqual([
      "Optional validation step 'optional-check' failed: optional failed",
    ]);
  });

  it("stops pipeline execution when a required step fails", async () => {
    const pipeline: ValidationPipeline<{ count: number }> = {
      name: "sample",
      steps: [
        {
          name: "basic",
          schema: z.object({ count: z.number().int().min(0) }),
        },
        {
          name: "threshold",
          validator: async (payload): Promise<ValidationOutcome<{ count: number }>> => {
            if (payload.count > 5) {
              return {
                success: false,
                error: {
                  error: "validation_error",
                  message: "too large",
                  details: [
                    {
                      field: "threshold",
                      code: ValidationErrorCode.CUSTOM,
                      message: "over limit",
                    },
                  ],
                  timestamp: new Date().toISOString(),
                },
              };
            }
            return { success: true, data: payload };
          },
        },
      ],
    };

    const result = await engine.validatePipeline(pipeline, { count: 10 });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.message).toBe("too large");
      expect(result.error.details[0].field).toBe("threshold");
    }
  });

  it("validates batches and aggregates summary details", async () => {
    const schema = z.object({ value: z.number().int().min(0) });
    const consoleError = jest.spyOn(console, "error").mockImplementation(() => undefined);

    const payload = [{ value: 1 }, { value: -1 }, { value: 10 }];
    const result = await engine.validateBatch(schema, payload);
    const metrics = engine.getMetrics();

    expect(result.summary.total).toBe(3);
    expect(result.summary.successful).toBe(2);
    expect(result.summary.failed).toBe(1);
    expect(result.summary.errors[0].field).toBe("[1].value");
    expect(metrics.totalValidations).toBe(3);
    expect(metrics.failedValidations).toBe(1);
    consoleError.mockRestore();
  });

  it("updates configuration and metrics", async () => {
    engine.updateConfig({
      defaultOptions: {
        stripUnknown: false,
        allowUnknown: true,
        abortEarly: false,
        errorFormat: "detailed",
        transformData: true,
      },
      enableMetrics: true,
      logValidationErrors: false,
    });

    const config = engine.getConfig();
    expect(config.defaultOptions.allowUnknown).toBe(true);
    expect(config.logValidationErrors).toBe(false);

    const result = await engine.validate(z.object({ a: z.string() }), { a: "x", b: "y" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ a: "x", b: "y" });
    }

    engine.resetMetrics();
    const metrics = engine.getMetrics();
    expect(metrics.totalValidations).toBe(0);
    expect(metrics.successfulValidations).toBe(0);
    expect(metrics.failedValidations).toBe(0);
  });

  it("uses global engine helpers", async () => {
    globalValidationEngine.resetMetrics();
    const schema = z.object({ id: CommonValidations.uuid });

    const single = await validateData(schema, { id: "550e8400-e29b-41d4-a716-446655440000" });
    const batch = await validateBatchWrapper(schema, [
      { id: "550e8400-e29b-41d4-a716-446655440000" },
      { id: "invalid" },
    ]);
    const metrics = globalValidationEngine.getMetrics();

    expect(single.success).toBe(true);
    expect(batch.summary.total).toBe(2);
    expect(batch.summary.failed).toBe(1);
    expect(metrics.totalValidations).toBe(3);
    expect(metrics.successfulValidations).toBe(2);
    expect(metrics.failedValidations).toBe(1);
  });
});

describe("Validation Schemas", () => {
  it("validates user registration happy path", async () => {
    const result = await UserSchemas.registration.safeParseAsync({
      email: "user@example.com",
      password: "Str0ng!Pass",
      confirmPassword: "Str0ng!Pass",
      firstName: "Ada",
      lastName: "Lovelace",
      dateOfBirth: new Date(Date.now() - 20 * 365 * 24 * 60 * 60 * 1000).toISOString(),
      acceptTerms: true,
      marketingOptIn: true,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.email).toBe("user@example.com");
    }
  });

  it("enforces registration password confirmation and age", async () => {
    const result = await UserSchemas.registration.safeParseAsync({
      email: "user@example.com",
      password: "Str0ng!Pass",
      confirmPassword: "Different1!",
      firstName: "Ada",
      lastName: "Lovelace",
      dateOfBirth: new Date().toISOString(),
      acceptTerms: true,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      const fields = result.error.issues.map((issue) => issue.path.join("."));
      expect(fields).toContain("confirmPassword");
    }
  });

  it("validates product creation constraints", async () => {
    const result = await ProductSchemas.create.safeParseAsync({
      name: "Widget",
      description: "A detailed description of the widget.",
      price: 1000,
      sku: "WIDGET-1",
      category: "Tools",
      tags: ["tool", "widget"],
      images: [{ url: "https://example.com/image.jpg", isPrimary: true }],
      inventory: {
        trackQuantity: true,
        quantity: 5,
        lowStockThreshold: 2,
        allowBackorder: false,
      },
      shipping: {
        weight: 1,
        dimensions: { length: 1, width: 2, height: 3 },
        shippingClass: "standard",
      },
      isActive: true,
      isFeatured: false,
    });

    expect(result.success).toBe(true);
  });

  it("rejects product images with multiple primaries", async () => {
    const result = await ProductSchemas.create.safeParseAsync({
      name: "Widget",
      description: "A detailed description of the widget.",
      price: 1000,
      sku: "WIDGET-1",
      category: "Tools",
      images: [
        { url: "https://example.com/1.jpg", isPrimary: true },
        { url: "https://example.com/2.jpg", isPrimary: true },
      ],
      inventory: {
        trackQuantity: true,
        quantity: 5,
        lowStockThreshold: 2,
        allowBackorder: false,
      },
      shipping: {
        weight: 1,
        dimensions: { length: 1, width: 2, height: 3 },
        shippingClass: "standard",
      },
      isActive: true,
    });

    expect(result.success).toBe(false);
  });

  it("validates order schema totals and items", async () => {
    const result = await OrderSchemas.create.safeParseAsync({
      items: [
        {
          productId: "550e8400-e29b-41d4-a716-446655440000",
          quantity: 2,
          price: 1500,
        },
      ],
      shippingAddress: {
        firstName: "Ada",
        lastName: "Lovelace",
        address1: "123 Main St",
        city: "Example",
        state: "EX",
        postalCode: "12345",
        country: "US",
      },
      payment: {
        method: "credit_card",
        token: "tok_123",
        savePaymentMethod: true,
      },
      billingAddress: { sameAsShipping: true },
      shipping: { method: "standard", cost: 500 },
      discounts: [],
    });

    expect(result.success).toBe(true);
  });

  it("enforces pagination bounds", async () => {
    const valid = await ApiSchemas.pagination.safeParseAsync({ page: 1, limit: 20 });
    const invalid = await ApiSchemas.pagination.safeParseAsync({ page: 0, limit: 500 });

    expect(valid.success).toBe(true);
    expect(invalid.success).toBe(false);
  });
});

describe("Fastify validation plugin", () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(() => {
    app = Fastify({ logger: false });
  });

  afterEach(async () => {
    await app.close();
  });

  it("decorates Fastify instance with validation helpers", async () => {
    await app.register(validationPlugin);

    expect(typeof (app as FastifyInstance & { addValidation: unknown }).addValidation).toBe(
      "function"
    );
    expect(typeof (app as FastifyInstance & { validate: unknown }).validate).toBe("function");
    expect(
      typeof (app as FastifyInstance & { getValidationMetrics: unknown }).getValidationMetrics
    ).toBe("function");
    expect(
      typeof (app as FastifyInstance & { resetValidationMetrics: unknown }).resetValidationMetrics
    ).toBe("function");
  });

  it("validates requests and responses via createValidatedRoute", async () => {
    const options: FastifyValidationOptions = {
      globalOptions: {
        stripUnknown: true,
        allowUnknown: false,
        abortEarly: false,
        errorFormat: "detailed",
        transformData: true,
      },
    };

    await app.register(validationPlugin, options);

    createValidatedRoute<{ email: string }>(
      app,
      "POST",
      "/users",
      {
        request: {
          body: z.object({ email: CommonValidations.email }),
        },
        response: {
          201: z.object({ id: CommonValidations.uuid, email: CommonValidations.email }),
        },
      },
      async (request, reply) => {
        expect(request.validated.body.email).toBe("user@example.com");
        reply.code(HttpStatus.CREATED);
        return { id: randomUUID(), email: request.validated.body.email };
      }
    );

    const response = await app.inject({
      method: "POST",
      url: "/users",
      payload: { email: "user@example.com", extra: "ignored" },
    });

    expect(response.statusCode).toBe(HttpStatus.CREATED);
    const body = response.json();
    expect(body.email).toBe("user@example.com");
    expect(body.id).toHaveLength(36);
    const metrics = (
      app as FastifyInstance & { getValidationMetrics: () => unknown }
    ).getValidationMetrics();
    expect(metrics.totalValidations).toBeGreaterThan(0);
  });

  it("handles validation failures with custom error handler", async () => {
    const errors: Array<{ status: number; payload: unknown }> = [];

    await app.register(validationPlugin, {
      errorHandler: (error: ValidationErrorResponse, reply: FastifyReply) => {
        errors.push({ status: reply.statusCode, payload: error });
        reply.code(HttpStatus.UNPROCESSABLE_ENTITY).send({ ...error, statusCode: HttpStatus.UNPROCESSABLE_ENTITY });
      },
    });

    createValidatedRoute<{ id: string }>(
      app,
      "POST",
      "/test",
      {
        request: {
          body: z.object({ id: CommonValidations.uuid }),
        },
      },
      async () => ({})
    );

    const response = await app.inject({
      method: "POST",
      url: "/test",
      payload: { id: "not-a-uuid" },
    });

    expect(response.statusCode).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
    expect(errors).toHaveLength(1);
    expect((errors[0].payload as ValidationErrorResponse).details[0].field).toBe("id");
  });
});

describe("Validation middleware", () => {
  it("blocks unauthenticated requests", () => {
    const reply = {
      code: jest.fn().mockReturnThis(),
      send: jest.fn(),
    } as unknown as Parameters<typeof ValidationMiddleware.requireAuth>[1];

    ValidationMiddleware.requireAuth({} as import("fastify").FastifyRequest, reply, jest.fn());

    expect(reply.code).toHaveBeenCalledWith(HttpStatus.UNAUTHORIZED);
    expect(reply.send).toHaveBeenCalledWith({
      error: "unauthorized",
      message: "Authentication required",
    });
  });

  it("enforces rate limits and exposes cleanup", () => {
    jest.useFakeTimers();
    const middleware = ValidationMiddleware.rateLimit(1, 1000);
    const reply = {
      code: jest.fn().mockReturnThis(),
      send: jest.fn(),
    } as unknown as Parameters<ReturnType<typeof ValidationMiddleware.rateLimit>>[1];

    const next = jest.fn();
    const request = { ip: "127.0.0.1" } as import("fastify").FastifyRequest;

    middleware(request, reply, next);
    expect(next).toHaveBeenCalledTimes(1);

    middleware(request, reply, next);
    expect(reply.code).toHaveBeenLastCalledWith(429);
    expect(reply.send).toHaveBeenLastCalledWith({
      error: "rate_limit_exceeded",
      message: "Too many validation requests",
    });

    (middleware as typeof middleware & { cleanup: () => void }).cleanup();
    jest.advanceTimersByTime(1000);
    jest.useRealTimers();
  });

  it("validates content type header", () => {
    const middleware = ValidationMiddleware.requireContentType("application/json");
    const reply = {
      code: jest.fn().mockReturnThis(),
      send: jest.fn(),
    } as unknown as Parameters<ReturnType<typeof ValidationMiddleware.requireContentType>>[1];
    const next = jest.fn();

    middleware({ headers: {} } as import("fastify").FastifyRequest, reply, next);
    expect(reply.code).toHaveBeenCalledWith(415);
    expect(reply.send).toHaveBeenCalledWith({
      error: "unsupported_media_type",
      message: "Expected content type: application/json",
    });

    middleware(
      {
        headers: { "content-type": "application/json; charset=utf-8" },
      } as import("fastify").FastifyRequest,
      reply,
      next
    );
    expect(next).toHaveBeenCalled();
  });
});


describe("Uplift regressions — engine option semantics", () => {
  let engine: ValidationEngine;

  beforeEach(() => {
    engine = new ValidationEngine({ logValidationErrors: false });
  });

  it("honors allowUnknown passed alone (previously silently ignored)", async () => {
    const schema = z.object({ a: z.string() });
    const result = await engine.validate(schema, { a: "x", b: "y" }, { allowUnknown: true });

    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({ a: "x", b: "y" });
  });

  it("applies strict mode to ZodEffects schemas (refine-wrapped objects)", async () => {
    const schema = z.object({ a: z.string() }).refine(() => true);
    const result = await engine.validate(
      schema,
      { a: "x", b: "y" },
      { stripUnknown: false, allowUnknown: false }
    );

    expect(result.success).toBe(false);
  });

  it("strips unknown keys through ZodEffects schemas and reports warnings", async () => {
    const result = await engine.validate(UserSchemas.registration, {
      email: "user@example.com",
      password: "Str0ng!Pass",
      confirmPassword: "Str0ng!Pass",
      firstName: "Ada",
      lastName: "Lovelace",
      dateOfBirth: "1990-05-10",
      acceptTerms: true,
      injected: "field",
    });

    expect(result.success).toBe(true);
    expect(result.success && result.warnings).toEqual(["Stripped unknown fields: injected"]);
  });

  it("does not downgrade a schema's own .strict() under engine defaults", async () => {
    // profileUpdate is declared .strict() ("Prevent unknown fields"); the old
    // engine replaced it with .strip() and silently accepted unknown keys.
    const result = await engine.validate(UserSchemas.profileUpdate, {
      firstName: "Ada",
      hacker: "field",
    });

    expect(result.success).toBe(false);
  });

  it("allows an explicit caller option to override a .strict() schema", async () => {
    const result = await engine.validate(
      UserSchemas.profileUpdate,
      { firstName: "Ada", hacker: "field" },
      { stripUnknown: true }
    );

    expect(result.success).toBe(true);
    expect(result.success && (result.data as Record<string, unknown>).hacker).toBeUndefined();
  });

  it("abortEarly reports exactly the first issue", async () => {
    const schema = z.object({ a: z.string(), b: z.number(), c: z.boolean() });
    const bad = { a: 1, b: "x", c: 3 };

    const early = await engine.validate(schema, bad, { abortEarly: true });
    const full = await engine.validate(schema, bad, { abortEarly: false });

    expect(early.success).toBe(false);
    expect(full.success).toBe(false);
    if (!early.success && !full.success) {
      expect(early.error.details).toHaveLength(1);
      expect(full.error.details).toHaveLength(3);
      expect(early.error.details[0].field).toBe(full.error.details[0].field);
    }
  });

  it("does not leave an unhandled rejection when an async refinement fails after timeout", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);

    try {
      const slow = new ValidationEngine({ maxValidationTime: 5, logValidationErrors: false });
      const schema = z.string().refine(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        throw new Error("late failure");
      });

      const result = await slow.validate(schema, "x");
      expect(result.success).toBe(false);

      // Give the losing promise time to reject.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(rejections).toHaveLength(0);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("keeps context flowing through the validateData convenience wrapper", async () => {
    const result = await validateData(
      z.object({ a: z.string() }),
      { a: 1 },
      { errorFormat: "detailed" },
      { requestId: "req-123" }
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.path).toBe("req-123");
    }
  });

  it("validateBatch with concurrency preserves index order and overlaps async work", async () => {
    const DELAY_MS = 10;
    const ITEMS = 24;
    const schema = z
      .object({ value: z.number() })
      .refine(async (payload) => {
        await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
        return payload.value >= 0;
      }, "must be non-negative");

    const payload = Array.from({ length: ITEMS }, (_, i) => ({
      value: i === 7 ? -1 : i,
    }));

    const t0 = performance.now();
    const sequential = await engine.validateBatch(schema, payload);
    const tSeq = performance.now() - t0;

    const t1 = performance.now();
    const concurrent = await engine.validateBatch(schema, payload, undefined, undefined, {
      concurrency: 8,
    });
    const tConc = performance.now() - t1;

    // Identical outcomes, index-stable errors.
    expect(concurrent.summary).toEqual(sequential.summary);
    expect(concurrent.summary.failed).toBe(1);
    expect(concurrent.summary.errors[0].field).toBe("[7].root");
    expect(concurrent.results).toHaveLength(ITEMS);
    concurrent.results.forEach((r, i) => expect(r.success).toBe(i !== 7));

    // Overlapped I/O must be meaningfully faster than serialized I/O.
    // Sequential floor is ITEMS * DELAY_MS (~240ms); concurrency 8 needs ~3
    // waves (~30ms). Assert a loose 2x to stay CI-flake-proof.
    expect(tConc).toBeLessThan(tSeq / 2);
  });
});

describe("Uplift regressions — schema fixes", () => {
  it("accepts padded/mixed-case emails and normalizes them (trim before checks)", () => {
    const result = CommonValidations.email.safeParse("  User@Example.COM  ");

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toBe("user@example.com");
    }
  });

  it("rejects priceMin > priceMax even when priceMax is 0", async () => {
    const result = await ProductSchemas.search.safeParseAsync({ priceMin: 500, priceMax: 0 });
    expect(result.success).toBe(false);

    const ok = await ProductSchemas.search.safeParseAsync({ priceMin: 0, priceMax: 500 });
    expect(ok.success).toBe(true);
  });

  it("accepts real IANA timezones and rejects junk", () => {
    const parse = (timezone: string): boolean =>
      UserSchemas.profileUpdate.safeParse({ timezone }).success;

    expect(parse("America/Argentina/Buenos_Aires")).toBe(true);
    expect(parse("UTC")).toBe(true);
    expect(parse("Etc/GMT+8")).toBe(true);
    expect(parse("America/New_York")).toBe(true);
    expect(parse("Not/AZone")).toBe(false);
  });

  it("rejects traversal and Windows-hostile filenames in fileUpload", () => {
    const parse = (filename: string): boolean =>
      ApiSchemas.fileUpload.safeParse({ filename, mimeType: "image/png", size: 10 }).success;

    expect(parse("..")).toBe(false);
    expect(parse(".")).toBe(false);
    expect(parse("evil.exe ")).toBe(false);
    expect(parse(" evil.exe")).toBe(false);
    expect(parse("evil.exe.")).toBe(false);
    expect(parse("report-2026_final.pdf")).toBe(true);
  });

  it("rejects internal/private webhook targets (SSRF guard)", () => {
    const parse = (url: string): boolean =>
      ApiSchemas.webhook.safeParse({ url, events: ["order.created"] }).success;

    expect(parse("https://localhost/hook")).toBe(false);
    expect(parse("https://api.localhost/hook")).toBe(false);
    expect(parse("https://169.254.169.254/latest/meta-data")).toBe(false);
    expect(parse("https://10.0.0.5/hook")).toBe(false);
    expect(parse("https://172.16.0.1/hook")).toBe(false);
    expect(parse("https://192.168.8.1/hook")).toBe(false);
    expect(parse("https://[::1]/hook")).toBe(false);
    expect(parse("https://hooks.example.com/order")).toBe(true);
  });

  it("accepts date-only dateOfBirth and computes calendar-accurate age", async () => {
    const dateOnly = await UserSchemas.registration.safeParseAsync({
      email: "user@example.com",
      password: "Str0ng!Pass",
      confirmPassword: "Str0ng!Pass",
      firstName: "Ada",
      lastName: "Lovelace",
      dateOfBirth: "1990-05-10",
      acceptTerms: true,
    });
    expect(dateOnly.success).toBe(true);

    // Someone whose 13th birthday is TODAY must be accepted; the old
    // 365.25-day approximation drifted around birthdays.
    const now = new Date();
    const thirteenToday = new Date(Date.UTC(now.getUTCFullYear() - 13, now.getUTCMonth(), now.getUTCDate()));
    const boundary = await UserSchemas.registration.safeParseAsync({
      email: "user@example.com",
      password: "Str0ng!Pass",
      confirmPassword: "Str0ng!Pass",
      firstName: "Ada",
      lastName: "Lovelace",
      dateOfBirth: thirteenToday.toISOString().slice(0, 10),
      acceptTerms: true,
    });
    expect(boundary.success).toBe(true);
  });

  it("requireContentType matches the media type exactly, not as a substring", () => {
    const middleware = ValidationMiddleware.requireContentType("application/json");
    const reply = {
      code: jest.fn().mockReturnThis(),
      send: jest.fn(),
    } as unknown as Parameters<ReturnType<typeof ValidationMiddleware.requireContentType>>[1];
    const next = jest.fn();

    middleware(
      { headers: { "content-type": "application/jsonx" } } as import("fastify").FastifyRequest,
      reply,
      next
    );
    expect(reply.code).toHaveBeenCalledWith(415);
    expect(next).not.toHaveBeenCalled();

    middleware(
      {
        headers: { "content-type": "Application/JSON; charset=utf-8" },
      } as import("fastify").FastifyRequest,
      reply,
      next
    );
    expect(next).toHaveBeenCalledTimes(1);
  });
});
