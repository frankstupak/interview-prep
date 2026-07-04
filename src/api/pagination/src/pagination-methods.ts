// pagination-methods.ts
import {
  PaginationType,
  PaginationRequest,
  PaginationResult,
  PageBasedRequest,
  OffsetBasedRequest,
  PageBasedResult,
  OffsetBasedResult,
  DataItem,
  PaginationConfig,
} from "./pagination-types";
import { paginateWithCursor } from "./cursor";
import { normalizeLimit, normalizeOffset, normalizePage } from "./normalize";

/** Exhaustiveness helper: ensures all union variants are handled at compile time. */
function assertNever(value: never): never {
  const display =
    typeof value === "object" && value !== null && "type" in value
      ? String((value as { type: unknown }).type)
      : String(value);
  throw new Error(`Invalid pagination type: ${display}`);
}

// Default configuration
const DEFAULT_CONFIG: PaginationConfig = {
  defaultLimit: 10,
  maxLimit: 100,
};

/**
 * Validates and normalizes pagination request parameters
 * @param request - The pagination request to validate
 * @param config - Configuration for pagination limits
 * @returns Normalized pagination request
 */
function validateAndNormalizePaginationRequest(
  request: PaginationRequest,
  config: PaginationConfig = DEFAULT_CONFIG
): PaginationRequest {
  // Validate and normalize limit. Integer-safe: fractional, NaN and
  // non-finite inputs previously flowed straight into Array.slice and
  // Math.ceil, silently returning wrong rows or NaN totalPages.
  const limit = normalizeLimit(request.limit, config.defaultLimit, config.maxLimit);

  if (request.type === PaginationType.PAGE_BASED) {
    const pageRequest = request as PageBasedRequest;
    return {
      ...pageRequest,
      limit,
      page: normalizePage(pageRequest.page), // Integer, at least 1
    };
  } else {
    const offsetRequest = request as OffsetBasedRequest;
    return {
      ...offsetRequest,
      limit,
      offset: normalizeOffset(offsetRequest.offset), // Integer, at least 0
    };
  }
}

/**
 * Performs page-based pagination on a dataset
 * @param data - The complete dataset to paginate
 * @param request - Page-based pagination request
 * @param config - Configuration for pagination limits
 * @returns Page-based pagination result
 */
export function paginateWithPageBased<T extends DataItem>(
  data: T[],
  request: PageBasedRequest,
  config: PaginationConfig = DEFAULT_CONFIG
): PageBasedResult<T> {
  // Validate and normalize the request
  const normalizedRequest = validateAndNormalizePaginationRequest(
    request,
    config
  ) as PageBasedRequest;
  const page = normalizedRequest.page!; // Safe to assert non-null after validation
  const limit = normalizedRequest.limit!; // Safe to assert non-null after validation

  // Calculate pagination values
  const total = data.length;
  const totalPages = Math.ceil(total / limit);
  const startIndex = (page - 1) * limit;
  const endIndex = startIndex + limit;

  // Extract the data for this page
  const paginatedData = data.slice(startIndex, endIndex);

  // Calculate navigation flags
  const hasNextPage = page < totalPages;
  const hasPreviousPage = page > 1;

  return {
    type: PaginationType.PAGE_BASED,
    data: paginatedData,
    total,
    limit,
    page,
    totalPages,
    hasNextPage,
    hasPreviousPage,
  };
}

/**
 * Performs offset-based pagination on a dataset
 * @param data - The complete dataset to paginate
 * @param request - Offset-based pagination request
 * @param config - Configuration for pagination limits
 * @returns Offset-based pagination result
 */
export function paginateWithOffsetBased<T extends DataItem>(
  data: T[],
  request: OffsetBasedRequest,
  config: PaginationConfig = DEFAULT_CONFIG
): OffsetBasedResult<T> {
  // Validate and normalize the request
  const normalizedRequest = validateAndNormalizePaginationRequest(
    request,
    config
  ) as OffsetBasedRequest;
  const offset = normalizedRequest.offset!; // Safe to assert non-null after validation
  const limit = normalizedRequest.limit!; // Safe to assert non-null after validation

  // Calculate pagination values
  const total = data.length;
  const startIndex = offset;
  const endIndex = startIndex + limit;

  // Extract the data for this offset
  const paginatedData = data.slice(startIndex, endIndex);

  // Calculate if there are more items
  const hasMore = endIndex < total;

  return {
    type: PaginationType.OFFSET_BASED,
    data: paginatedData,
    total,
    limit,
    offset,
    hasMore,
  };
}

/**
 * Generic pagination function that handles both page-based and offset-based pagination
 * @param data - The complete dataset to paginate
 * @param request - Pagination request (either page-based or offset-based)
 * @param config - Configuration for pagination limits
 * @returns Pagination result matching the request type
 */
export function paginate<T extends DataItem>(
  data: T[],
  request: PaginationRequest,
  config: PaginationConfig = DEFAULT_CONFIG
): PaginationResult<T> {
  switch (request.type) {
    case PaginationType.PAGE_BASED:
      return paginateWithPageBased(data, request, config);
    case PaginationType.OFFSET_BASED:
      return paginateWithOffsetBased(data, request, config);
    case PaginationType.CURSOR_BASED:
      return paginateWithCursor(data, request, config);
    default:
      return assertNever(request);
  }
}

/**
 * Helper function to create a page-based pagination request
 * @param page - Page number (1-based)
 * @param limit - Number of items per page
 * @returns Page-based pagination request
 */
export function createPageBasedRequest(page: number = 1, limit: number = 10): PageBasedRequest {
  return {
    type: PaginationType.PAGE_BASED,
    page,
    limit,
  };
}

/**
 * Helper function to create an offset-based pagination request
 * @param offset - Number of items to skip
 * @param limit - Number of items to return
 * @returns Offset-based pagination request
 */
export function createOffsetBasedRequest(
  offset: number = 0,
  limit: number = 10
): OffsetBasedRequest {
  return {
    type: PaginationType.OFFSET_BASED,
    offset,
    limit,
  };
}

/**
 * Utility function to convert page-based parameters to offset-based
 * @param page - Page number (1-based)
 * @param limit - Number of items per page
 * @returns Equivalent offset value
 */
export function pageToOffset(page: number, limit: number): number {
  return (Math.max(page, 1) - 1) * limit;
}

/**
 * Utility function to convert offset-based parameters to page-based
 * @param offset - Number of items to skip
 * @param limit - Number of items per page
 * @returns Equivalent page number (1-based)
 */
export function offsetToPage(offset: number, limit: number): number {
  return Math.floor(Math.max(offset, 0) / limit) + 1;
}

/**
 * Helper function to create a cursor-based pagination request
 * @param options - cursor (omit for first page), limit, sortBy, sortDirection, scope
 * @returns Cursor-based pagination request
 */
export function createCursorBasedRequest(
  options: Omit<import("./pagination-types").CursorBasedRequest, "type"> = {}
): import("./pagination-types").CursorBasedRequest {
  return {
    type: PaginationType.CURSOR_BASED,
    ...options,
  };
}
