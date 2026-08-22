// validation-types.ts - Type definitions for validation system
import { z } from "zod";

/**
 * Validation error details for comprehensive error reporting
 * Provides structured information about validation failures
 */
export interface ValidationErrorDetail {
  field: string; // Field path (e.g., "user.email", "items[0].price")
  code: string; // Error code (e.g., "invalid_email", "too_small")
  message: string; // Human-readable error message
  received?: unknown; // The actual value that was received
  expected?: string; // Description of what was expected
}

/**
 * Structured validation error response
 * Consistent error format across all API endpoints
 */
export interface ValidationErrorResponse {
  error: "validation_error";
  message: string;
  details: ValidationErrorDetail[];
  timestamp: string;
  path?: string; // API endpoint path where error occurred
}

/**
 * Validation success response with parsed data
 * Generic type for type-safe validation results
 */
export interface ValidationResult<T> {
  success: true;
  data: T;
  warnings?: string[]; // Non-fatal validation warnings
}

/**
 * Validation failure response
 * Contains detailed error information for debugging
 */
export interface ValidationFailure {
  success: false;
  error: ValidationErrorResponse;
}

/**
 * Union type for validation outcomes
 * Enables type-safe handling of validation results
 */
export type ValidationOutcome<T> = ValidationResult<T> | ValidationFailure;

/**
 * Validation middleware options
 * Configuration for different validation scenarios
 */
export interface ValidationOptions {
  stripUnknown?: boolean; // Remove unknown fields from input
  allowUnknown?: boolean; // Allow unknown fields to pass through
  abortEarly?: boolean; // Stop on first validation error
  errorFormat?: "detailed" | "simple"; // Error response format
  transformData?: boolean; // Apply Zod transforms
  customErrorMessages?: Record<string, string>; // Override default error messages
}

/**
 * Schema registry for reusable validation schemas
 * Enables schema composition and reuse across endpoints
 */
export interface SchemaRegistry {
  [key: string]: z.ZodSchema<unknown>;
}

/**
 * Validation context for advanced validation scenarios
 * Provides additional context for custom validation logic
 */
export interface ValidationContext {
  userId?: string; // Current user ID for authorization checks
  userRole?: string; // User role for role-based validation
  requestId?: string; // Request ID for tracing
  metadata?: Record<string, unknown>; // Additional context data
}

/**
 * Custom validation function type
 * For complex business logic validation
 */
export type CustomValidator<T> = (
  data: T,
  context?: ValidationContext
) => Promise<ValidationOutcome<T>>;

/**
 * Validation pipeline step
 * Enables composable validation chains
 */
export interface ValidationStep<T> {
  name: string; // Step identifier
  schema?: z.ZodSchema<T>; // Zod schema for this step
  validator?: CustomValidator<T>; // Custom validation function
  optional?: boolean; // Whether this step can be skipped
  errorMessage?: string; // Custom error message for this step
}

/**
 * Validation pipeline configuration
 * Defines a series of validation steps to execute
 */
export interface ValidationPipeline<T> {
  name: string; // Pipeline identifier
  steps: ValidationStep<T>[]; // Ordered validation steps
  options?: ValidationOptions; // Pipeline-wide options
}

/**
 * Common field length limits used across validation schemas.
 * Replaces magic number literals (50, 100, 200, 500, etc.) for consistency.
 */
export const FieldLimits = {
  /** Short text: names, SKU, tags */
  SHORT: 50,
  /** Medium text: location, category, slug */
  MEDIUM: 100,
  /** Long text: query, product name, address, alt text, description snippet */
  LONG: 200,
  /** Bio, order notes, long descriptions */
  BIO_AND_NOTES: 500,
  /** Search query max length */
  QUERY: 200,
  /** SEO title */
  SEO_TITLE: 60,
  /** SEO meta description */
  SEO_DESCRIPTION: 160,
  /** Product/order description */
  DESCRIPTION: 2000,
  /** Password max length */
  PASSWORD: 128,
  /** Email max length (RFC) */
  EMAIL: 254,
  /** Phone max length */
  PHONE: 16,
  /** Postal code */
  POSTAL_CODE: 20,
} as const;

/**
 * Common validation patterns
 * Reusable validation schemas for common data types
 */
export const CommonValidations = {
  // Email validation with comprehensive pattern.
  // NOTE: .trim()/.toLowerCase() must run BEFORE .email() and the length
  // checks. Zod applies string checks/transforms strictly in chain order, so
  // the previous ordering (email → ... → toLowerCase → trim) rejected inputs
  // like "  User@Example.com  " that the trailing normalizers were clearly
  // meant to accept.
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Invalid email format")
    .min(5, "Email must be at least 5 characters")
    .max(FieldLimits.EMAIL, "Email must not exceed 254 characters"),

  // Password validation with security requirements
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .max(FieldLimits.PASSWORD, "Password must not exceed 128 characters")
    .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
    .regex(/[a-z]/, "Password must contain at least one lowercase letter")
    .regex(/[0-9]/, "Password must contain at least one number")
    .regex(/[^A-Za-z0-9]/, "Password must contain at least one special character"),

  // Phone number validation (international format)
  phone: z
    .string()
    .regex(/^\+[1-9]\d{1,14}$/, "Phone number must be in international format (+1234567890)")
    .min(10, "Phone number must be at least 10 characters")
    .max(FieldLimits.PHONE, "Phone number must not exceed 16 characters"),

  // URL validation with protocol requirement
  url: z
    .string()
    .url("Invalid URL format")
    .regex(/^https?:\/\//, "URL must use HTTP or HTTPS protocol"),

  // UUID validation (v4)
  uuid: z.string().uuid("Invalid UUID format").length(36, "UUID must be exactly 36 characters"),

  // Date validation (ISO 8601 format)
  isoDate: z
    .string()
    .datetime("Invalid ISO 8601 date format")
    .transform((str) => new Date(str)),

  // Positive integer validation
  positiveInt: z.number().int("Must be an integer").positive("Must be a positive number"),

  // Non-empty string validation
  nonEmptyString: z.string().min(1, "String cannot be empty").trim(),

  // Slug validation (URL-friendly string)
  slug: z
    .string()
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      "Slug must contain only lowercase letters, numbers, and hyphens"
    )
    .min(1, "Slug cannot be empty")
    .max(FieldLimits.MEDIUM, "Slug must not exceed 100 characters"),

  // Currency amount validation (cents)
  currencyAmount: z
    .number()
    .int("Amount must be an integer (in cents)")
    .nonnegative("Amount cannot be negative")
    .max(999999999, "Amount too large"), // $9,999,999.99

  // Pagination parameters
  pagination: z.object({
    page: z.number().int().positive().default(1),
    limit: z.number().int().positive().max(100).default(20),
    sortBy: z.string().optional(),
    sortOrder: z.enum(["asc", "desc"]).default("asc"),
  }),

  // Search parameters
  search: z.object({
    query: z.string().min(1).max(FieldLimits.QUERY).trim(),
    filters: z.record(z.string()).optional(),
    facets: z.array(z.string()).optional(),
  }),
} as const;

/**
 * Validation error codes for consistent error handling
 * Standardized error codes for different validation failures
 */
export enum ValidationErrorCode {
  REQUIRED = "required",
  INVALID_TYPE = "invalid_type",
  INVALID_FORMAT = "invalid_format",
  TOO_SMALL = "too_small",
  TOO_BIG = "too_big",
  INVALID_ENUM = "invalid_enum",
  CUSTOM = "custom",
  INVALID_DATE = "invalid_date",
  INVALID_EMAIL = "invalid_email",
  INVALID_URL = "invalid_url",
  INVALID_UUID = "invalid_uuid",
  WEAK_PASSWORD = "weak_password",
  DUPLICATE_VALUE = "duplicate_value",
  BUSINESS_RULE_VIOLATION = "business_rule_violation",
}

/**
 * Validation severity levels
 * Different levels of validation issues
 */
export enum ValidationSeverity {
  ERROR = "error", // Validation failure - request should be rejected
  WARNING = "warning", // Validation concern - request can proceed with warning
  INFO = "info", // Informational - no action needed
}

/**
 * Validation metrics for monitoring
 * Track validation performance and error patterns
 */
export interface ValidationMetrics {
  totalValidations: number; // Total number of validations performed
  successfulValidations: number; // Number of successful validations
  failedValidations: number; // Number of failed validations
  averageValidationTime: number; // Average validation time in milliseconds
  errorsByCode: Record<string, number>; // Count of errors by error code
  errorsByField: Record<string, number>; // Count of errors by field name
  lastReset: Date; // When metrics were last reset
}

/**
 * Validation configuration
 * Global configuration for validation behavior
 */
export interface ValidationConfig {
  enableMetrics: boolean; // Whether to collect validation metrics
  logValidationErrors: boolean; // Whether to log validation errors
  maxValidationTime: number; // Maximum allowed validation time (ms)
  defaultOptions: ValidationOptions; // Default validation options
  customErrorMessages: Record<string, string>; // Global custom error messages
}
