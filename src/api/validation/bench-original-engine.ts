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
} from "./src/validation-types";

/**
 * Core validation engine class
 * Provides comprehensive validation capabilities with Zod integration
 */
export class ValidationEngine {
  private metrics: ValidationMetrics;
  private config: ValidationConfig;

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
    schema: z.ZodSchema<T>,
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

      // Update metrics
      // Why: Track validation attempts for monitoring
      if (this.config.enableMetrics) {
        this.metrics.totalValidations++;
      }

      // Apply validation options to schema
      // Why: Configure Zod behavior based on validation requirements
      let configuredSchema = schema;

      if (validationOptions.stripUnknown) {
        // Use native Zod .strip() method to remove unknown properties
        // This is the correct way to handle unknown properties in Zod
        if (schema instanceof z.ZodObject) {
          configuredSchema = schema.strip() as unknown as z.ZodSchema<T>;
        }
      } else if (validationOptions.allowUnknown) {
        // Use native Zod .passthrough() to allow unknown properties
        if (schema instanceof z.ZodObject) {
          configuredSchema = schema.passthrough() as unknown as z.ZodSchema<T>;
        }
      } else {
        // Use native Zod .strict() to reject unknown properties
        if (schema instanceof z.ZodObject) {
          configuredSchema = schema.strict() as unknown as z.ZodSchema<T>;
        }
      }

      // Perform validation with timeout
      // Why: Prevent validation from hanging indefinitely
      const validationPromise = this.performValidation(configuredSchema, data, validationOptions);
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error("Validation timeout")),
          this.config.maxValidationTime
        );
      });

      const result = await Promise.race([validationPromise, timeoutPromise]);

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
      const validationError = this.handleValidationError(error, context);

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
    schema: z.ZodSchema<T>,
    dataArray: unknown[],
    options?: ValidationOptions,
    context?: ValidationContext
  ): Promise<{
    results: ValidationOutcome<T>[];
    summary: {
      total: number;
      successful: number;
      failed: number;
      errors: ValidationErrorDetail[];
    };
  }> {
    const results: ValidationOutcome<T>[] = [];
    const errors: ValidationErrorDetail[] = [];
    let successful = 0;
    let failed = 0;

    // Validate each item in the batch
    // Why: Process multiple items efficiently while collecting comprehensive results
    for (let i = 0; i < dataArray.length; i++) {
      const result = await this.validate(schema, dataArray[i], options, context);
      results.push(result);

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
   * Perform the actual Zod validation
   * Internal method that handles the core validation logic
   */
  private async performValidation<T>(
    schema: z.ZodSchema<T>,
    data: unknown,
    options: ValidationOptions
  ): Promise<T> {
    // Configure Zod parsing options
    // Why: Apply validation options to control Zod behavior
    if (options.abortEarly) {
      // Use safeParseAsync for early abort
      const result = await schema.safeParseAsync(data);
      if (!result.success) {
        throw result.error;
      }
      return result.data;
    } else {
      // Use parseAsync for complete validation
      return await schema.parseAsync(data);
    }
  }

  /**
   * Handle validation errors and convert to structured format
   * Transforms Zod errors into consistent error responses
   */
  private handleValidationError(error: unknown, context?: ValidationContext): ValidationFailure {
    if (error instanceof z.ZodError) {
      // Transform Zod errors to structured format
      // Why: Provide consistent, detailed error information
      const details: ValidationErrorDetail[] = error.issues.map((issue) => ({
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
  schema: z.ZodSchema<T>,
  data: unknown,
  options?: ValidationOptions
): Promise<ValidationOutcome<T>> {
  return globalValidationEngine.validate(schema, data, options);
}

/**
 * Convenience function for batch validation
 * Quick access to batch validation functionality
 */
export async function validateBatch<T>(
  schema: z.ZodSchema<T>,
  dataArray: unknown[],
  options?: ValidationOptions
): Promise<{
  results: ValidationOutcome<T>[];
  summary: {
    total: number;
    successful: number;
    failed: number;
    errors: ValidationErrorDetail[];
  };
}> {
  return globalValidationEngine.validateBatch(schema, dataArray, options);
}
