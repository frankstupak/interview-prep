// pagination.ts - Entry file that exports all pagination functionality
export {
  // Types and interfaces
  PaginationType,
  type BasePaginationRequest,
  type PageBasedRequest,
  type OffsetBasedRequest,
  type CursorBasedRequest,
  type PaginationRequest,
  type SortDirection,
  type DataItem,
  type BasePaginationResult,
  type PageBasedResult,
  type OffsetBasedResult,
  type CursorBasedResult,
  type PaginationResult,
  type PaginationConfig,
  type Employee,
} from "./pagination-types";

export {
  // Main pagination functions
  paginate,
  paginateWithPageBased,
  paginateWithOffsetBased,

  // Helper functions
  createPageBasedRequest,
  createOffsetBasedRequest,
  createCursorBasedRequest,
  pageToOffset,
  offsetToPage,
} from "./pagination-methods";

export {
  // Cursor-based (keyset) pagination
  paginateWithCursor,
  createCursorPaginator,
  decodeCursor,
  InvalidCursorError,
  DEFAULT_SORT_FIELD,
  type CursorPaginator,
} from "./cursor";
