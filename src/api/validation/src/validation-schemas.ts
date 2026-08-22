// validation-schemas.ts - Comprehensive validation schemas for common use cases
import { z } from "zod";
import { CommonValidations, FieldLimits } from "./validation-types";

/**
 * SSRF guard for server-fetched URLs (webhooks).
 * Rejects loopback, private (RFC1918), link-local / cloud-metadata,
 * carrier-grade NAT, unspecified, and their common IPv6 equivalents,
 * plus localhost-style hostnames. Exported for testing.
 */
export function isInternalWebhookTarget(rawUrl: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return true; // unparseable → treat as unsafe
  }

  // Hostname classes
  if (hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local")) {
    return true;
  }

  // IPv6 literals arrive from URL.hostname wrapped in brackets — strip them.
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (bare.includes(":")) {
    // IPv6: loopback, unspecified, link-local fe80::/10, unique-local fc00::/7,
    // and IPv4-mapped (delegate to the v4 check).
    if (bare === "::1" || bare === "::") return true;
    if (/^fe[89ab]/i.test(bare)) return true;
    if (/^f[cd]/i.test(bare)) return true;
    const mapped = bare.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (mapped) return isInternalIPv4(mapped[1]);
    return false;
  }

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(bare)) {
    return isInternalIPv4(bare);
  }

  return false;
}

function isInternalIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p > 255)) {
    return true; // malformed → unsafe
  }
  const [a, b] = parts;
  return (
    a === 0 || // 0.0.0.0/8 unspecified
    a === 10 || // 10.0.0.0/8 private
    a === 127 || // 127.0.0.0/8 loopback
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
    (a === 169 && b === 254) || // 169.254.0.0/16 link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12 private
    (a === 192 && b === 168) // 192.168.0.0/16 private
  );
}

/**
 * Calendar-accurate age in whole years.
 * Replaces the previous `elapsedMs / (365.25 * 24h)` approximation, which is
 * off by up to a day around birthdays (someone turning 13 today could be
 * rejected, someone turning 13 tomorrow could be accepted).
 */
export function calendarAgeInYears(dateOfBirth: Date, now: Date = new Date()): number {
  let age = now.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const monthDiff = now.getUTCMonth() - dateOfBirth.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getUTCDate() < dateOfBirth.getUTCDate())) {
    age--;
  }
  return age;
}

/**
 * User-related validation schemas
 * Comprehensive schemas for user management operations
 */
export const UserSchemas = {
  // User registration schema with comprehensive validation
  // Why: Ensures all required fields are present and valid for new user creation
  registration: z
    .object({
      email: CommonValidations.email,
      password: CommonValidations.password,
      confirmPassword: z.string(),
      firstName: z
        .string()
        .min(1, "First name is required")
        .max(FieldLimits.SHORT, "First name must not exceed 50 characters")
        .regex(
          /^[a-zA-Z\s'-]+$/,
          "First name can only contain letters, spaces, hyphens, and apostrophes"
        )
        .trim(),
      lastName: z
        .string()
        .min(1, "Last name is required")
        .max(FieldLimits.SHORT, "Last name must not exceed 50 characters")
        .regex(
          /^[a-zA-Z\s'-]+$/,
          "Last name can only contain letters, spaces, hyphens, and apostrophes"
        )
        .trim(),
      dateOfBirth: z
        .union([z.string().date(), z.string().datetime()], {
          errorMap: () => ({
            message: "Invalid date format (expected YYYY-MM-DD or ISO 8601 datetime)",
          }),
        })
        .transform((str) => new Date(str))
        .refine((date) => calendarAgeInYears(date) >= 13, "Must be at least 13 years old")
        .refine((date) => calendarAgeInYears(date) <= 120, "Invalid date of birth"),
      phone: CommonValidations.phone.optional(),
      acceptTerms: z.boolean().refine((val) => val === true, "Must accept terms and conditions"),
      marketingOptIn: z.boolean().default(false),
    })
    .refine((data) => data.password === data.confirmPassword, {
      message: "Passwords do not match",
      path: ["confirmPassword"],
    }),

  // User login schema with rate limiting considerations
  // Why: Validates login credentials while preventing brute force attacks
  login: z.object({
    email: CommonValidations.email,
    password: z
      .string()
      .min(1, "Password is required")
      .max(FieldLimits.PASSWORD, "Password too long"),
    rememberMe: z.boolean().default(false),
    captchaToken: z.string().optional(), // For rate limiting protection
  }),

  // User profile update schema with partial updates
  // Why: Allows flexible profile updates while maintaining validation
  profileUpdate: z
    .object({
      firstName: z
        .string()
        .min(1, "First name cannot be empty")
        .max(FieldLimits.SHORT, "First name too long")
        .regex(/^[a-zA-Z\s'-]+$/, "Invalid first name format")
        .trim()
        .optional(),
      lastName: z
        .string()
        .min(1, "Last name cannot be empty")
        .max(FieldLimits.SHORT, "Last name too long")
        .regex(/^[a-zA-Z\s'-]+$/, "Invalid last name format")
        .trim()
        .optional(),
      phone: CommonValidations.phone.optional(),
      bio: z
        .string()
        .max(FieldLimits.BIO_AND_NOTES, "Bio must not exceed 500 characters")
        .trim()
        .optional(),
      website: CommonValidations.url.optional(),
      location: z
        .string()
        .max(FieldLimits.MEDIUM, "Location must not exceed 100 characters")
        .trim()
        .optional(),
      // Validate against the runtime's actual IANA timezone database instead
      // of a shape regex. The old pattern (^[A-Za-z_]+/[A-Za-z_]+$) rejected
      // large parts of the real tz database: three-segment zones
      // ("America/Argentina/Buenos_Aires"), single-token zones ("UTC"), and
      // offset zones ("Etc/GMT+8") — while accepting nonsense like "Foo/Bar".
      timezone: z
        .string()
        .refine((tz) => {
          try {
            new Intl.DateTimeFormat("en-US", { timeZone: tz });
            return true;
          } catch {
            return false;
          }
        }, "Invalid IANA timezone")
        .optional(),
      preferences: z
        .object({
          language: z.enum(["en", "es", "fr", "de", "it", "pt", "ja", "ko", "zh"]).default("en"),
          theme: z.enum(["light", "dark", "auto"]).default("auto"),
          notifications: z
            .object({
              email: z.boolean().default(true),
              push: z.boolean().default(true),
              sms: z.boolean().default(false),
            })
            .default({}),
        })
        .optional(),
    })
    .strict(), // Prevent unknown fields

  // Password change schema with security validation
  // Why: Ensures secure password changes with proper verification
  passwordChange: z
    .object({
      currentPassword: z.string().min(1, "Current password is required"),
      newPassword: CommonValidations.password,
      confirmNewPassword: z.string(),
    })
    .refine((data) => data.newPassword === data.confirmNewPassword, {
      message: "New passwords do not match",
      path: ["confirmNewPassword"],
    })
    .refine((data) => data.currentPassword !== data.newPassword, {
      message: "New password must be different from current password",
      path: ["newPassword"],
    }),
} as const;

/**
 * Product/E-commerce validation schemas
 * Schemas for product management and e-commerce operations
 */
export const ProductSchemas = {
  // Product creation schema with comprehensive validation
  // Why: Ensures product data integrity for e-commerce operations
  create: z.object({
    name: z
      .string()
      .min(1, "Product name is required")
      .max(FieldLimits.LONG, "Product name too long")
      .trim(),
    description: z
      .string()
      .min(10, "Description must be at least 10 characters")
      .max(FieldLimits.DESCRIPTION, "Description too long")
      .trim(),
    price: CommonValidations.currencyAmount,
    compareAtPrice: CommonValidations.currencyAmount.optional(),
    sku: z
      .string()
      .min(1, "SKU is required")
      .max(FieldLimits.SHORT, "SKU too long")
      .regex(
        /^[A-Z0-9-_]+$/,
        "SKU can only contain uppercase letters, numbers, hyphens, and underscores"
      )
      .trim(),
    category: z
      .string()
      .min(1, "Category is required")
      .max(FieldLimits.MEDIUM, "Category name too long"),
    tags: z.array(z.string().min(1).max(50)).max(10, "Maximum 10 tags allowed").default([]),
    images: z
      .array(
        z.object({
          url: CommonValidations.url,
          altText: z.string().max(FieldLimits.LONG, "Alt text too long").optional(),
          isPrimary: z.boolean().default(false),
        })
      )
      .min(1, "At least one image is required")
      .max(10, "Maximum 10 images allowed")
      .refine((images) => images.filter((img) => img.isPrimary).length <= 1, {
        message: "Only one image can be marked as primary",
      }),
    inventory: z.object({
      trackQuantity: z.boolean().default(true),
      quantity: z.number().int().nonnegative().default(0),
      lowStockThreshold: z.number().int().nonnegative().default(5),
      allowBackorder: z.boolean().default(false),
    }),
    shipping: z.object({
      weight: z.number().positive("Weight must be positive"),
      dimensions: z.object({
        length: z.number().positive(),
        width: z.number().positive(),
        height: z.number().positive(),
      }),
      shippingClass: z.enum(["standard", "heavy", "fragile", "hazardous"]).default("standard"),
    }),
    seo: z
      .object({
        title: z.string().max(FieldLimits.SEO_TITLE, "SEO title too long").optional(),
        description: z
          .string()
          .max(FieldLimits.SEO_DESCRIPTION, "SEO description too long")
          .optional(),
        keywords: z.array(z.string().min(1).max(50)).max(20).default([]),
      })
      .optional(),
    isActive: z.boolean().default(true),
    isFeatured: z.boolean().default(false),
  }),

  // Product search/filter schema
  // Why: Validates search parameters for product discovery
  search: z
    .object({
      query: z.string().min(1).max(FieldLimits.QUERY).trim().optional(),
      category: z.string().max(FieldLimits.MEDIUM).optional(),
      tags: z.array(z.string().min(1).max(50)).max(10).optional(),
      priceMin: CommonValidations.currencyAmount.optional(),
      priceMax: CommonValidations.currencyAmount.optional(),
      inStock: z.boolean().optional(),
      featured: z.boolean().optional(),
      ...CommonValidations.pagination.shape,
      // Override pagination defaults for products
      sortBy: z.enum(["name", "price", "created", "updated", "popularity"]).default("created"),
      sortOrder: z.enum(["asc", "desc"]).default("desc"),
    })
    .refine(
      (data) => {
        // != null (not truthiness): prices are in cents and 0 is a legal
        // value. The old `if (data.priceMin && data.priceMax)` skipped the
        // check whenever either bound was 0, so priceMin=500, priceMax=0
        // sailed through validation with an impossible range.
        if (data.priceMin != null && data.priceMax != null) {
          return data.priceMin <= data.priceMax;
        }
        return true;
      },
      {
        message: "Minimum price cannot be greater than maximum price",
        path: ["priceMin"],
      }
    ),
} as const;

/**
 * Order/Transaction validation schemas
 * Schemas for order processing and payment handling
 */
export const OrderSchemas = {
  // Order creation schema with comprehensive validation
  // Why: Ensures order integrity and prevents fraud
  create: z.object({
    items: z
      .array(
        z.object({
          productId: CommonValidations.uuid,
          quantity: z.number().int().positive("Quantity must be positive"),
          price: CommonValidations.currencyAmount, // Price at time of order
          customizations: z.record(z.string()).optional(),
        })
      )
      .min(1, "Order must contain at least one item")
      .max(50, "Maximum 50 items per order"),

    shippingAddress: z.object({
      firstName: z.string().min(1).max(50).trim(),
      lastName: z.string().min(1).max(50).trim(),
      company: z.string().max(100).trim().optional(),
      address1: z.string().min(1, "Address is required").max(FieldLimits.LONG).trim(),
      address2: z.string().max(FieldLimits.LONG).trim().optional(),
      city: z.string().min(1, "City is required").max(FieldLimits.MEDIUM).trim(),
      state: z.string().min(1, "State is required").max(FieldLimits.MEDIUM).trim(),
      postalCode: z
        .string()
        .min(1, "Postal code is required")
        .max(20)
        .regex(/^[A-Z0-9\s-]+$/i, "Invalid postal code format")
        .trim(),
      country: z
        .string()
        .length(2, "Country must be 2-letter ISO code")
        .regex(/^[A-Z]{2}$/, "Invalid country code")
        .toUpperCase(),
      phone: CommonValidations.phone.optional(),
    }),

    billingAddress: z
      .object({
        sameAsShipping: z.boolean().default(true),
        firstName: z.string().min(1).max(50).trim().optional(),
        lastName: z.string().min(1).max(50).trim().optional(),
        company: z.string().max(100).trim().optional(),
        address1: z.string().max(FieldLimits.LONG).trim().optional(),
        address2: z.string().max(FieldLimits.LONG).trim().optional(),
        city: z.string().max(FieldLimits.MEDIUM).trim().optional(),
        state: z.string().max(FieldLimits.MEDIUM).trim().optional(),
        postalCode: z.string().max(FieldLimits.POSTAL_CODE).trim().optional(),
        country: z.string().length(2).optional(),
        phone: CommonValidations.phone.optional(),
      })
      .refine(
        (data) => {
          if (!data.sameAsShipping) {
            return (
              data.firstName &&
              data.lastName &&
              data.address1 &&
              data.city &&
              data.state &&
              data.postalCode &&
              data.country
            );
          }
          return true;
        },
        {
          message: "Billing address fields are required when different from shipping",
          path: ["billingAddress"],
        }
      ),

    payment: z.object({
      method: z.enum([
        "credit_card",
        "debit_card",
        "paypal",
        "apple_pay",
        "google_pay",
        "bank_transfer",
      ]),
      token: z.string().min(1, "Payment token is required"), // Tokenized payment info
      savePaymentMethod: z.boolean().default(false),
    }),

    shipping: z.object({
      method: z.enum(["standard", "express", "overnight", "pickup"]),
      cost: CommonValidations.currencyAmount,
    }),

    discounts: z
      .array(
        z.object({
          code: z.string().min(1).max(50),
          type: z.enum(["percentage", "fixed_amount", "free_shipping"]),
          value: z.number().nonnegative(),
          description: z.string().max(FieldLimits.LONG),
        })
      )
      .max(5, "Maximum 5 discount codes per order")
      .default([]),

    notes: z.string().max(FieldLimits.BIO_AND_NOTES, "Order notes too long").trim().optional(),

    metadata: z.record(z.string()).optional(), // For tracking, analytics, etc.
  }),

  // Order status update schema
  // Why: Validates order status changes and tracking information
  statusUpdate: z
    .object({
      status: z.enum([
        "pending",
        "confirmed",
        "processing",
        "shipped",
        "delivered",
        "cancelled",
        "refunded",
        "returned",
      ]),
      trackingNumber: z.string().max(100).optional(),
      carrier: z.enum(["ups", "fedex", "dhl", "usps", "other"]).optional(),
      notes: z.string().max(FieldLimits.BIO_AND_NOTES).optional(),
      notifyCustomer: z.boolean().default(true),
    })
    .refine(
      (data) => {
        if (data.status === "shipped") {
          return data.trackingNumber && data.carrier;
        }
        return true;
      },
      {
        message: "Tracking number and carrier are required when status is shipped",
        path: ["trackingNumber"],
      }
    ),
} as const;

/**
 * API-specific validation schemas
 * Schemas for API operations and system functionality
 */
export const ApiSchemas = {
  // Generic pagination schema
  // Why: Standardizes pagination across all API endpoints
  pagination: CommonValidations.pagination,

  // Search schema with advanced filtering
  // Why: Provides flexible search capabilities across different entities
  search: z.object({
    ...CommonValidations.search.shape,
    dateRange: z
      .object({
        start: CommonValidations.isoDate.optional(),
        end: CommonValidations.isoDate.optional(),
      })
      .optional()
      .refine(
        (data) => {
          if (data?.start && data?.end) {
            return data.start <= data.end;
          }
          return true;
        },
        {
          message: "Start date must be before end date",
        }
      ),
    includeDeleted: z.boolean().default(false),
  }),

  // Bulk operation schema
  // Why: Validates bulk operations while preventing abuse
  bulkOperation: z.object({
    operation: z.enum(["create", "update", "delete", "archive"]),
    items: z
      .array(z.record(z.unknown()))
      .min(1, "At least one item is required")
      .max(1000, "Maximum 1000 items per bulk operation"),
    options: z
      .object({
        continueOnError: z.boolean().default(false),
        validateOnly: z.boolean().default(false),
        batchSize: z.number().int().positive().max(100).default(50),
      })
      .optional(),
  }),

  // File upload schema
  // Why: Validates file uploads with security considerations
  fileUpload: z.object({
    filename: z
      .string()
      .min(1, "Filename is required")
      .max(255, "Filename too long")
      .regex(
        /^[\u0020-\u0021\u0023-\u0029\u002B-\u002E\u0030-\u0039\u003B-\u003D\u0040-\u005B\u005D-\u007B\u007D-\u007E]+$/,
        "Invalid filename characters"
      )
      // The character allowlist alone still admitted "." and ".."
      // (directory-traversal primitives if the name ever reaches a
      // filesystem path join) plus Windows-hostile leading/trailing
      // spaces and trailing dots.
      .refine((name) => name !== "." && name !== "..", "Invalid filename")
      .refine(
        (name) => name === name.trim() && !name.endsWith("."),
        "Filename cannot have leading/trailing spaces or a trailing dot"
      ),
    mimeType: z.string().regex(/^[a-z]+\/[a-z0-9+.-]+$/i, "Invalid MIME type format"),
    size: z
      .number()
      .int()
      .positive("File size must be positive")
      .max(100 * 1024 * 1024, "File size cannot exceed 100MB"), // 100MB limit
    checksum: z
      .string()
      .regex(/^[a-f0-9]{64}$/i, "Invalid SHA-256 checksum")
      .optional(),
    metadata: z
      .object({
        description: z.string().max(FieldLimits.BIO_AND_NOTES).optional(),
        tags: z.array(z.string().min(1).max(50)).max(10).default([]),
        isPublic: z.boolean().default(false),
      })
      .optional(),
  }),

  // Webhook configuration schema
  // Why: Validates webhook endpoints and security settings
  webhook: z.object({
    // SSRF guard: user-supplied webhook URLs are fetched by OUR servers, so
    // internal targets must be rejected — loopback, RFC1918 private ranges,
    // link-local (incl. 169.254.169.254 cloud metadata), and their IPv6
    // equivalents. Hostname-based DNS rebinding still needs a resolve-time
    // check in the HTTP client; this blocks the literal-address class.
    url: CommonValidations.url
      .refine((url) => url.startsWith("https://"), {
        message: "Webhook URL must use HTTPS",
      })
      .refine((url) => !isInternalWebhookTarget(url), {
        message: "Webhook URL must not target internal or private addresses",
      }),
    events: z
      .array(z.string().min(1).max(100))
      .min(1, "At least one event must be selected")
      .max(50, "Maximum 50 events per webhook"),
    secret: z
      .string()
      .min(16, "Webhook secret must be at least 16 characters")
      .max(128, "Webhook secret too long")
      .optional(),
    isActive: z.boolean().default(true),
    retryPolicy: z
      .object({
        maxRetries: z.number().int().nonnegative().max(10).default(3),
        retryDelay: z.number().int().positive().max(3600).default(60), // seconds
        backoffMultiplier: z.number().positive().max(10).default(2),
      })
      .optional(),
  }),
} as const;

/**
 * Schema composition utilities
 * Helper functions for combining and extending schemas
 */
export const SchemaUtils = {
  /**
   * Create a partial version of a schema (all fields optional)
   * Useful for update operations where not all fields are required
   */
  makePartial: <T extends z.ZodRawShape>(schema: z.ZodObject<T>) => {
    return schema.partial();
  },

  /**
   * Create a pick version of a schema (select specific fields)
   * Useful for creating focused schemas from larger ones
   */
  pick: <T extends z.ZodRawShape, K extends keyof T>(schema: z.ZodObject<T>, keys: K[]) => {
    const shape = Object.fromEntries(keys.map((k) => [k, true]));
    type PickKeys = Parameters<z.ZodObject<T>["pick"]>[0];
    return schema.pick(shape as unknown as PickKeys);
  },

  /**
   * Create an omit version of a schema (exclude specific fields)
   * Useful for removing sensitive fields from schemas
   */
  omit: <T extends z.ZodRawShape, K extends keyof T>(schema: z.ZodObject<T>, keys: K[]) => {
    const shape = Object.fromEntries(keys.map((k) => [k, true]));
    type OmitKeys = Parameters<z.ZodObject<T>["omit"]>[0];
    return schema.omit(shape as unknown as OmitKeys);
  },

  /**
   * Extend a schema with additional fields
   * Useful for adding common fields like timestamps
   */
  extend: <T extends z.ZodRawShape, U extends z.ZodRawShape>(
    baseSchema: z.ZodObject<T>,
    extension: U
  ) => {
    return baseSchema.extend(extension);
  },

  /**
   * Create a timestamped version of a schema
   * Adds createdAt and updatedAt fields
   */
  withTimestamps: <T extends z.ZodRawShape>(schema: z.ZodObject<T>) => {
    return schema.extend({
      createdAt: CommonValidations.isoDate,
      updatedAt: CommonValidations.isoDate,
    });
  },

  /**
   * Create an ID-enabled version of a schema
   * Adds id field for database entities
   */
  withId: <T extends z.ZodRawShape>(schema: z.ZodObject<T>) => {
    return schema.extend({
      id: CommonValidations.uuid,
    });
  },
} as const;
