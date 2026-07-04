// validation-engine.ts - Core validation engine with Zod integration
import { z } from "zod";
import {
  ValidationErrorDetail,
  ValidationErrorResponse,
  ValidationFailure,
  ValidationOutcome,
  ValidationOptions,
  ValidationContext,
  ValidationPipeline,
  ValidationMetrics,
  ValidationConfig,
  ValidationErrorCode,
} from "./validation-types";

/**
 * Core validation engine class
 * Provides comprehensive validation capabilities with Zod integration
 */
/** How unknown object keys should be handled for a given validation call. */
type UnknownKeysMode = "strip" | "passthrough" | "strict" | "none";

export class ValidationEngine {
  private metrics: ValidationMetrics;
  private config: ValidationConfig;

  /**
   * Cache of unknown-keys-configured schema variants, keyed by original schema.
   * Why: schema.strip()/.strict()/.passthrough() each allocate a brand-new schema
   * object. Doing that on every validate() call is pure per-request garbage; schemas
   * are module-level constants, so a WeakMap cache is safe and always hits after first use.
   */
  private static readonly configuredSchemaCache = new WeakMap<
    z.ZodTypeAny,
    Map<string, z.ZodTypeAny>
  >();

  /**
   * Tracks whether a schema can be parsed synchronously (no async refinements
   * or transforms). Lets validate() skip the Promise.race + setTimeout machinery
   * entirely for the common all-sync case.
   */
  private static readonly syncParseCache = new WeakMap<z.ZodTypeAny, boolean>();

  /**
   * Static asyncness analysis: returns true only when the schema tree provably
   * contains no node that can perform async work. Conservative by design —
   * any ZodEffects (refine/superRefine/transform/preprocess — asyncness is a
   * runtime property of the callback, undetectable statically), ZodPromise,
   * ZodLazy (may recurse into anything), ZodFunction, or unrecognized node
   * type routes the schema to the async parse path, which is always correct.
   */
  private static isDefinitelySync(schema: z.ZodTypeAny): boolean {
    const def = schema._def as { typeName?: z.ZodFirstPartyTypeKind } & Record<string, unknown>;
    switch (def.typeName) {
      // Leaf types: always sync.
      case z.ZodFirstPartyTypeKind.ZodString:
      case z.ZodFirstPartyTypeKind.ZodNumber:
      case z.ZodFirstPartyTypeKind.ZodBigInt:
      case z.ZodFirstPartyTypeKind.ZodBoolean:
      case z.ZodFirstPartyTypeKind.ZodDate:
      case z.ZodFirstPartyTypeKind.ZodSymbol:
      case z.ZodFirstPartyTypeKind.ZodUndefined:
      case z.ZodFirstPartyTypeKind.ZodNull:
      case z.ZodFirstPartyTypeKind.ZodAny:
      case z.ZodFirstPartyTypeKind.ZodUnknown:
      case z.ZodFirstPartyTypeKind.ZodNever:
      case z.ZodFirstPartyTypeKind.ZodVoid:
      case z.ZodFirstPartyTypeKind.ZodLiteral:
      case z.ZodFirstPartyTypeKind.ZodEnum:
      case z.ZodFirstPartyTypeKind.ZodNativeEnum:
      case z.ZodFirstPartyTypeKind.ZodNaN:
        return true;

      case z.ZodFirstPartyTypeKind.ZodObject: {
        const obj = schema as z.ZodObject<z.ZodRawShape>;
        const shape = obj.shape;
        for (const key of Object.keys(shape)) {
          if (!ValidationEngine.isDefinitelySync(shape[key])) {
            return false;
          }
        }
        const catchall = (obj._def as { catchall?: z.ZodTypeAny }).catchall;
        if (
          catchall &&
          (catchall._def as { typeName?: z.ZodFirstPartyTypeKind }).typeName !==
            z.ZodFirstPartyTypeKind.ZodNever
        ) {
          return ValidationEngine.isDefinitelySync(catchall);
        }
        return true;
      }

      case z.ZodFirstPartyTypeKind.ZodArray:
        return ValidationEngine.isDefinitelySync((def.type as z.ZodTypeAny) ?? z.never());

      case z.ZodFirstPartyTypeKind.ZodUnion:
      case z.ZodFirstPartyTypeKind.ZodDiscriminatedUnion: {
        const options = def.options as z.ZodTypeAny[] | Map<unknown, z.ZodTypeAny>;
        const list = Array.isArray(options) ? options : Array.from(options.values());
        return list.every((o) => ValidationEngine.isDefinitelySync(o));
      }

      case z.ZodFirstPartyTypeKind.ZodIntersection:
        return (
          ValidationEngine.isDefinitelySync(def.left as z.ZodTypeAny) &&
          ValidationEngine.isDefinitelySync(def.right as z.ZodTypeAny)
        );

      case z.ZodFirstPartyTypeKind.ZodTuple: {
        const items = (def.items as z.ZodTypeAny[]) ?? [];
        if (!items.every((i) => ValidationEngine.isDefinitelySync(i))) {
          return false;
        }
        const rest = def.rest as z.ZodTypeAny | null | undefined;
        return rest ? ValidationEngine.isDefinitelySync(rest) : true;
      }

      case z.ZodFirstPartyTypeKind.ZodRecord:
        return (
          (!def.keyType || ValidationEngine.isDefinitelySync(def.keyType as z.ZodTypeAny)) &&
          ValidationEngine.isDefinitelySync(def.valueType as z.ZodTypeAny)
        );

      case z.ZodFirstPartyTypeKind.ZodMap:
        return (
          ValidationEngine.isDefinitelySync(def.keyType as z.ZodTypeAny) &&
          ValidationEngine.isDefinitelySync(def.valueType as z.ZodTypeAny)
        );

      case z.ZodFirstPartyTypeKind.ZodSet:
        return ValidationEngine.isDefinitelySync(def.valueType as z.ZodTypeAny);

      // Single-child wrappers: sync iff the child is sync.
      case z.ZodFirstPartyTypeKind.ZodOptional:
      case z.ZodFirstPartyTypeKind.ZodNullable:
        return ValidationEngine.isDefinitelySync(def.innerType as z.ZodTypeAny);
      case z.ZodFirstPartyTypeKind.ZodDefault:
      case z.ZodFirstPartyTypeKind.ZodCatch:
      case z.ZodFirstPartyTypeKind.ZodReadonly:
        return ValidationEngine.isDefinitelySync(def.innerType as z.ZodTypeAny);
      case z.ZodFirstPartyTypeKind.ZodBranded:
        return ValidationEngine.isDefinitelySync(def.type as z.ZodTypeAny);
      case z.ZodFirstPartyTypeKind.ZodPipeline:
        return (
          ValidationEngine.isDefinitelySync(def.in as z.ZodTypeAny) &&
          ValidationEngine.isDefinitelySync(def.out as z.ZodTypeAny)
        );

      // Potentially async or unbounded: always route to the async path.
      case z.ZodFirstPartyTypeKind.ZodEffects:
      case z.ZodFirstPartyTypeKind.ZodPromise:
      case z.ZodFirstPartyTypeKind.ZodLazy:
      case z.ZodFirstPartyTypeKind.ZodFunction:
      default:
        return false;
    }
  }

  constructor(config?: Partial<ValidationConfig>) {
    // Initialize default configuration
    // Why: Provides sensible defaults while allowing customization
    this.config = {
      enableMetrics: true,
      logValidationErrors: true,
      maxValidationTime: 5000, // 5 seconds
      defaultOptions: {
        stripUnknown: true,
        allowUnknown: false,
        abortEarly: false,
        errorFormat: "detailed",
        transformData: true,
      },
      customErrorMessages: {},
      ...config,
    };

    // Initialize metrics tracking
    // Why: Enables monitoring of validation performance and error patterns
    this.metrics = {
      totalValidations: 0,
      successfulValidations: 0,
      failedValidations: 0,
      averageValidationTime: 0,
      errorsByCode: {},
      errorsByField: {},
      lastReset: new Date(),
    };
  }

  /**
   * Validate data against a Zod schema
   * Core validation method with comprehensive error handling
   */
  async validate<T>(
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    data: unknown,
    options?: ValidationOptions,
    context?: ValidationContext
  ): Promise<ValidationOutcome<T>> {
    const startTime = performance.now();
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

    try {
      // Merge options with defaults
      // Why: Allows per-validation customization while maintaining defaults
      const validationOptions: ValidationOptions = {
        ...this.config.defaultOptions,
        ...options,
      };

      // Track whether the CALLER explicitly chose an unknown-keys behavior.
      // Why: an explicit caller choice may override a schema's own .strict()
      // declaration, but engine defaults must never silently downgrade it.
      const explicitUnknownKeys =
        options != null && ("stripUnknown" in options || "allowUnknown" in options);

      // Update metrics
      // Why: Track validation attempts for monitoring
      if (this.config.enableMetrics) {
        this.metrics.totalValidations++;
      }

      // Resolve unknown-keys mode with well-defined precedence:
      // allowUnknown > stripUnknown > strict. Previously the if-chain checked
      // stripUnknown first, so `{ allowUnknown: true }` alone was silently
      // ignored (default stripUnknown=true won). allowUnknown is the most
      // specific intent, so it wins.
      const mode: UnknownKeysMode = validationOptions.allowUnknown
        ? "passthrough"
        : validationOptions.stripUnknown
          ? "strip"
          : "strict";

      const configuredSchema = this.applyUnknownKeysMode(
        schema,
        mode,
        explicitUnknownKeys
      ) as z.ZodType<T, z.ZodTypeDef, unknown>;

      // Fast path: synchronous parse for schemas that provably contain no
      // async work. Why: the async path costs a setTimeout + Promise.race +
      // microtask hops per call, and typical request schemas (params, query,
      // pagination, headers) are fully synchronous.
      //
      // Detection is STATIC (a one-time walk of the schema tree, cached in a
      // WeakMap): only schemas with no ZodEffects/ZodPromise/ZodLazy/
      // ZodFunction node anywhere can be guaranteed sync. Runtime probing via
      // safeParse() — including zod's own ~standard.validate wrapper, which
      // probes sync-first — is NOT safe here: on an async schema Zod starts
      // the refinement, then throws and abandons its promise, and if that
      // orphaned promise rejects the process dies with an unhandled
      // rejection (verified empirically against zod 3.25).
      let parseResult: z.SafeParseReturnType<unknown, T> | undefined;

      let knownSync = ValidationEngine.syncParseCache.get(schema);
      if (knownSync === undefined) {
        knownSync = ValidationEngine.isDefinitelySync(schema);
        ValidationEngine.syncParseCache.set(schema, knownSync);
      }

      if (knownSync) {
        parseResult = configuredSchema.safeParse(data);
      } else {
        // Schema may perform async work — parse with a timeout guard.
        // Why: prevent async refinements (DB lookups etc.) from hanging
        // forever. safeParseAsync catches thrown refinement errors
        // internally, so the losing promise in the race never surfaces an
        // unhandled rejection.
        const validationPromise = configuredSchema.safeParseAsync(data);
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error("Validation timeout")),
            this.config.maxValidationTime
          );
        });

        parseResult = await Promise.race([validationPromise, timeoutPromise]);
      }

      if (!parseResult.success) {
        throw parseResult.error;
      }
      const result = parseResult.data;

      // Record successful validation
      // Why: Track success metrics for monitoring
      if (this.config.enableMetrics) {
        this.metrics.successfulValidations++;
        this.updateAverageTime(startTime);
      }

      return {
        success: true,
        data: result,
        warnings: this.generateWarnings(data, result, context),
      };
    } catch (error) {
      // Handle validation errors
      // Why: Provide structured error information for debugging and user feedback
      const mergedOptions: ValidationOptions = { ...this.config.defaultOptions, ...options };
      const validationError = this.handleValidationError(error, context, mergedOptions);

      // Record failed validation
      // Why: Track failure metrics and error patterns
      if (this.config.enableMetrics) {
        this.metrics.failedValidations++;
        this.updateErrorMetrics(validationError.error);
        this.updateAverageTime(startTime);
      }

      // Log validation errors if enabled
      // Why: Enable debugging and monitoring of validation issues
      if (this.config.logValidationErrors) {
        console.error("Validation error:", validationError.error);
      }

      return validationError;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  /**
   * Apply an unknown-keys mode (strip/passthrough/strict) to a schema.
   *
   * Fixes three defects in the original implementation:
   * 1. ZodEffects bypass: schemas wrapped by .refine()/.transform() (e.g. the
   *    registration schema) are ZodEffects, not ZodObject, so `instanceof
   *    z.ZodObject` never matched and every unknown-keys option was a silent
   *    no-op. We now unwrap effects recursively and rebuild the wrapper around
   *    the configured inner object.
   * 2. Strict-schema downgrade: a schema declared `.strict()` by its author
   *    (e.g. profileUpdate, documented "Prevent unknown fields") was replaced
   *    with `.strip()` by the engine default, silently accepting unknown keys.
   *    Engine DEFAULTS no longer weaken an explicit .strict(); an EXPLICIT
   *    caller option still can.
   * 3. Per-call allocation: .strip()/.strict()/.passthrough() each build a new
   *    schema object. Variants are now cached per (schema, mode) in a WeakMap.
   */
  private applyUnknownKeysMode(
    schema: z.ZodTypeAny,
    mode: UnknownKeysMode,
    explicit: boolean
  ): z.ZodTypeAny {
    if (mode === "none") {
      return schema;
    }

    let cacheForSchema = ValidationEngine.configuredSchemaCache.get(schema);
    // Explicit and non-explicit resolve differently only for .strict() schemas;
    // cache them under distinct keys to avoid cross-contamination.
    const cacheKey = explicit ? `explicit-${mode}` : mode;
    const cached = cacheForSchema?.get(cacheKey);
    if (cached) {
      return cached;
    }

    const configured = this.buildConfiguredSchema(schema, mode, explicit);

    if (!cacheForSchema) {
      cacheForSchema = new Map();
      ValidationEngine.configuredSchemaCache.set(schema, cacheForSchema);
    }
    cacheForSchema.set(cacheKey, configured);
    return configured;
  }

  /** Build the configured variant (uncached). */
  private buildConfiguredSchema(
    schema: z.ZodTypeAny,
    mode: UnknownKeysMode,
    explicit: boolean
  ): z.ZodTypeAny {
    if (schema instanceof z.ZodObject) {
      const declared = (schema._def as { unknownKeys?: string }).unknownKeys;
      // Respect the schema author's .strict() unless the caller explicitly
      // asked for something else.
      if (declared === "strict" && !explicit) {
        return schema;
      }
      switch (mode) {
        case "strip":
          return schema.strip();
        case "passthrough":
          return schema.passthrough();
        case "strict":
          return schema.strict();
        default:
          return schema;
      }
    }

    if (schema instanceof z.ZodEffects) {
      const inner = schema.innerType() as z.ZodTypeAny;
      const configuredInner = this.buildConfiguredSchema(inner, mode, explicit);
      if (configuredInner === inner) {
        return schema;
      }
      // Rebuild the effects wrapper around the configured inner schema,
      // preserving the original refine/transform/preprocess effect.
      return new z.ZodEffects({
        ...(schema._def as z.ZodEffectsDef<z.ZodTypeAny>),
        schema: configuredInner,
      });
    }

    // Non-object root schemas (string, array, union, ...) have no
    // unknown-keys concept; return unchanged.
    return schema;
  }

  /**
   * Validate data through a validation pipeline
   * Enables complex, multi-step validation scenarios
   */
  async validatePipeline<T>(
    pipeline: ValidationPipeline<T>,
    data: unknown,
    context?: ValidationContext
  ): Promise<ValidationOutcome<T>> {
    let currentData = data;
    const warnings: string[] = [];

    // Execute each validation step in sequence
    // Why: Allow complex validation logic with multiple stages
    for (const step of pipeline.steps) {
      try {
        let stepResult: ValidationOutcome<unknown>;

        if (step.schema) {
          // Use Zod schema validation
          stepResult = await this.validate(step.schema, currentData, pipeline.options, context);
        } else if (step.validator) {
          // Use custom validation function
          stepResult = await step.validator(currentData as T, context);
        } else {
          throw new Error(`Validation step '${step.name}' has no schema or validator`);
        }

        if (!stepResult.success) {
          // Handle step failure
          if (step.optional) {
            warnings.push(
              `Optional validation step '${step.name}' failed: ${stepResult.error.message}`
            );
            continue;
          } else {
            return stepResult;
          }
        }

        // Update data for next step
        currentData = stepResult.data;
        if (stepResult.warnings) {
          warnings.push(...stepResult.warnings);
        }
      } catch (error) {
        const errorMessage = step.errorMessage || `Validation step '${step.name}' failed`;
        return {
          success: false,
          error: {
            error: "validation_error",
            message: errorMessage,
            details: [
              {
                field: step.name,
                code: ValidationErrorCode.CUSTOM,
                message: error instanceof Error ? error.message : "Unknown error",
              },
            ],
            timestamp: new Date().toISOString(),
          },
        };
      }
    }

    return {
      success: true,
      data: currentData as T,
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  /**
   * Validate multiple data items in batch
   * Efficient validation of arrays or multiple objects
   */
  async validateBatch<T>(
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    dataArray: unknown[],
    options?: ValidationOptions,
    context?: ValidationContext,
    batchOptions?: { concurrency?: number }
  ): Promise<{
    results: ValidationOutcome<T>[];
    summary: {
      total: number;
      successful: number;
      failed: number;
      errors: ValidationErrorDetail[];
    };
  }> {
    const results: ValidationOutcome<T>[] = new Array(dataArray.length);
    const errors: ValidationErrorDetail[] = [];
    let successful = 0;
    let failed = 0;

    // Concurrency: schemas with async refinements (DB uniqueness checks, remote
    // lookups...) previously serialized the whole batch — item N+1 could not
    // start until item N's I/O finished. A small worker pool overlaps that I/O.
    // Default remains 1 (sequential) for full backward compatibility; results
    // and error ordering are index-stable either way.
    const concurrency = Math.max(1, Math.floor(batchOptions?.concurrency ?? 1));

    if (concurrency === 1) {
      // Validate each item in the batch
      // Why: Process multiple items efficiently while collecting comprehensive results
      for (let i = 0; i < dataArray.length; i++) {
        results[i] = await this.validate(schema, dataArray[i], options, context);
      }
    } else {
      let nextIndex = 0;
      const worker = async (): Promise<void> => {
        for (let i = nextIndex++; i < dataArray.length; i = nextIndex++) {
          results[i] = await this.validate(schema, dataArray[i], options, context);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(concurrency, dataArray.length) }, () => worker())
      );
    }

    // Aggregate in index order so summaries are deterministic regardless of
    // completion order.
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (result.success) {
        successful++;
      } else {
        failed++;
        // Add batch index to error details
        const batchErrors = result.error.details.map((detail) => ({
          ...detail,
          field: `[${i}].${detail.field}`,
        }));
        errors.push(...batchErrors);
      }
    }

    return {
      results,
      summary: {
        total: dataArray.length,
        successful,
        failed,
        errors,
      },
    };
  }

  /**
   * Handle validation errors and convert to structured format
   * Transforms Zod errors into consistent error responses
   */
  private handleValidationError(
    error: unknown,
    context?: ValidationContext,
    options?: ValidationOptions
  ): ValidationFailure {
    if (error instanceof z.ZodError) {
      // abortEarly contract: report only the first issue.
      // Why: Zod always runs full validation (there is no mid-parse abort in
      // Zod v3), so the previous implementation's safeParseAsync-vs-parseAsync
      // switch changed NOTHING — abortEarly was decorative. What callers
      // actually observe is the error payload, so we honor the option there.
      const issues = options?.abortEarly ? error.issues.slice(0, 1) : error.issues;

      // Transform Zod errors to structured format
      // Why: Provide consistent, detailed error information
      const details: ValidationErrorDetail[] = issues.map((issue) => ({
        field: issue.path.join(".") || "root",
        code: this.mapZodErrorCode(issue.code),
        message: this.getCustomErrorMessage(issue) || issue.message,
        received: this.getIssueReceived(issue),
        expected: this.getExpectedValue(issue),
      }));

      return {
        success: false,
        error: {
          error: "validation_error",
          message: `Validation failed with ${details.length} error(s)`,
          details,
          timestamp: new Date().toISOString(),
          path: context?.requestId,
        },
      };
    } else {
      // Handle non-Zod errors
      // Why: Provide consistent error format even for unexpected errors
      const errorMessage = error instanceof Error ? error.message : "Unknown validation error";

      return {
        success: false,
        error: {
          error: "validation_error",
          message: errorMessage,
          details: [
            {
              field: "unknown",
              code: ValidationErrorCode.CUSTOM,
              message: errorMessage,
            },
          ],
          timestamp: new Date().toISOString(),
        },
      };
    }
  }

  /**
   * Map Zod error codes to our standardized error codes
   * Provides consistent error codes across the application
   */
  private mapZodErrorCode(zodCode: z.ZodIssueCode): string {
    const codeMap: Record<z.ZodIssueCode, string> = {
      [z.ZodIssueCode.invalid_type]: ValidationErrorCode.INVALID_TYPE,
      [z.ZodIssueCode.invalid_literal]: ValidationErrorCode.INVALID_FORMAT,
      [z.ZodIssueCode.unrecognized_keys]: ValidationErrorCode.INVALID_FORMAT,
      [z.ZodIssueCode.invalid_union]: ValidationErrorCode.INVALID_FORMAT,
      [z.ZodIssueCode.invalid_union_discriminator]: ValidationErrorCode.INVALID_FORMAT,
      [z.ZodIssueCode.invalid_enum_value]: ValidationErrorCode.INVALID_ENUM,
      [z.ZodIssueCode.invalid_arguments]: ValidationErrorCode.INVALID_FORMAT,
      [z.ZodIssueCode.invalid_return_type]: ValidationErrorCode.INVALID_FORMAT,
      [z.ZodIssueCode.invalid_date]: ValidationErrorCode.INVALID_DATE,
      [z.ZodIssueCode.invalid_string]: ValidationErrorCode.INVALID_FORMAT,
      [z.ZodIssueCode.too_small]: ValidationErrorCode.TOO_SMALL,
      [z.ZodIssueCode.too_big]: ValidationErrorCode.TOO_BIG,
      [z.ZodIssueCode.invalid_intersection_types]: ValidationErrorCode.INVALID_FORMAT,
      [z.ZodIssueCode.not_multiple_of]: ValidationErrorCode.INVALID_FORMAT,
      [z.ZodIssueCode.not_finite]: ValidationErrorCode.INVALID_FORMAT,
      [z.ZodIssueCode.custom]: ValidationErrorCode.CUSTOM,
    };

    return codeMap[zodCode] || ValidationErrorCode.CUSTOM;
  }

  /**
   * Get custom error message if available
   * Allows overriding default Zod error messages
   */
  private getCustomErrorMessage(issue: z.ZodIssue): string | undefined {
    const fieldPath = issue.path.join(".");
    return (
      this.config.customErrorMessages[fieldPath] || this.config.customErrorMessages[issue.code]
    );
  }

  /**
   * Get received value from Zod issue (present on invalid_type and some other codes)
   */
  private getIssueReceived(issue: z.ZodIssue): unknown {
    return "received" in issue
      ? (issue as z.ZodIssue & { received?: unknown }).received
      : undefined;
  }

  /**
   * Get expected value description for error details
   * Provides helpful information about what was expected
   */
  private getExpectedValue(issue: z.ZodIssue): string | undefined {
    switch (issue.code) {
      case z.ZodIssueCode.invalid_type: {
        const typed = issue as z.ZodIssue & { expected?: string; received?: unknown };
        return `Expected ${typed.expected ?? "unknown"}, received ${typed.received ?? "unknown"}`;
      }
      case z.ZodIssueCode.too_small:
        return `Minimum ${issue.minimum} ${issue.type}`;
      case z.ZodIssueCode.too_big:
        return `Maximum ${issue.maximum} ${issue.type}`;
      case z.ZodIssueCode.invalid_enum_value:
        return `One of: ${issue.options?.join(", ")}`;
      default:
        return undefined;
    }
  }

  /**
   * Generate warnings for successful validations
   * Provides non-fatal feedback about the validation
   */
  private generateWarnings(
    originalData: unknown,
    validatedData: unknown,
    _context?: ValidationContext
  ): string[] | undefined {
    const warnings: string[] = [];

    // Check for stripped fields
    if (
      typeof originalData === "object" &&
      originalData !== null &&
      typeof validatedData === "object" &&
      validatedData !== null
    ) {
      const originalKeys = Object.keys(originalData as Record<string, unknown>);
      const validatedKeys = Object.keys(validatedData as Record<string, unknown>);
      const strippedKeys = originalKeys.filter((key) => !validatedKeys.includes(key));

      if (strippedKeys.length > 0) {
        warnings.push(`Stripped unknown fields: ${strippedKeys.join(", ")}`);
      }
    }

    return warnings.length > 0 ? warnings : undefined;
  }

  /**
   * Update average validation time metric
   * Tracks performance of validation operations
   */
  private updateAverageTime(startTime: number): void {
    const duration = performance.now() - startTime;
    const total = this.metrics.totalValidations;
    const currentAvg = this.metrics.averageValidationTime;

    // Calculate running average
    this.metrics.averageValidationTime = (currentAvg * (total - 1) + duration) / total;
  }

  /**
   * Update error metrics for monitoring
   * Tracks error patterns and frequencies
   */
  private updateErrorMetrics(error: ValidationErrorResponse): void {
    error.details.forEach((detail) => {
      // Count errors by code
      this.metrics.errorsByCode[detail.code] = (this.metrics.errorsByCode[detail.code] || 0) + 1;

      // Count errors by field
      this.metrics.errorsByField[detail.field] =
        (this.metrics.errorsByField[detail.field] || 0) + 1;
    });
  }

  /**
   * Get current validation metrics
   * Provides performance and error statistics
   */
  getMetrics(): ValidationMetrics {
    return { ...this.metrics };
  }

  /**
   * Reset validation metrics
   * Clears accumulated statistics
   */
  resetMetrics(): void {
    this.metrics = {
      totalValidations: 0,
      successfulValidations: 0,
      failedValidations: 0,
      averageValidationTime: 0,
      errorsByCode: {},
      errorsByField: {},
      lastReset: new Date(),
    };
  }

  /**
   * Update validation configuration
   * Allows runtime configuration changes
   */
  updateConfig(config: Partial<ValidationConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current validation configuration
   * Returns current configuration settings
   */
  getConfig(): ValidationConfig {
    return { ...this.config };
  }
}

/**
 * Global validation engine instance
 * Provides singleton access to validation functionality
 */
export const globalValidationEngine = new ValidationEngine();

/**
 * Convenience function for simple validation
 * Quick access to validation without creating engine instance
 */
export async function validateData<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  data: unknown,
  options?: ValidationOptions,
  context?: ValidationContext
): Promise<ValidationOutcome<T>> {
  // Context was previously accepted by the engine but silently dropped here.
  return globalValidationEngine.validate(schema, data, options, context);
}

/**
 * Convenience function for batch validation
 * Quick access to batch validation functionality
 */
export async function validateBatch<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  dataArray: unknown[],
  options?: ValidationOptions,
  context?: ValidationContext,
  batchOptions?: { concurrency?: number }
): Promise<{
  results: ValidationOutcome<T>[];
  summary: {
    total: number;
    successful: number;
    failed: number;
    errors: ValidationErrorDetail[];
  };
}> {
  return globalValidationEngine.validateBatch(schema, dataArray, options, context, batchOptions);
}
