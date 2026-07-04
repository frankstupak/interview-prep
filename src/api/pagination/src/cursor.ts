// cursor.ts - opaque keyset ("cursor") pagination.
//
// The pattern used by Stripe, Slack and GitHub: the server hands the client
// an opaque base64url token that encodes the position of the last item seen
// (sort-key value + unique id tiebreaker). The next request seeks strictly
// past that tuple instead of counting rows from the start, which makes
// pagination immune to the classic offset failure mode: rows inserted or
// deleted between requests shifting every subsequent offset, duplicating or
// skipping rows.
//
// Design notes:
// - Total order = (sortBy value, id). The id tiebreaker is mandatory: a
//   non-unique sort key (e.g. department) without one skips/duplicates rows
//   on collisions at page boundaries.
// - Cursors are scoped: they record the sortBy, direction and an optional
//   caller-supplied scope tag (e.g. the active filter). A cursor replayed
//   against a different sort/filter is rejected with InvalidCursorError
//   instead of silently returning nonsense.
// - Seeking uses binary search (O(log n)) on the sorted view rather than a
//   linear scan, and the anchor item does NOT need to still exist - the
//   search lands on the tuple's insertion point, so deleting the anchor
//   between requests cannot break the sequence.

import {
  CursorBasedRequest,
  CursorBasedResult,
  DataItem,
  PaginationConfig,
  PaginationType,
  SortDirection,
} from "./pagination-types";
import { normalizeLimit } from "./normalize";

const DEFAULT_CONFIG: PaginationConfig = { defaultLimit: 10, maxLimit: 100 };
const CURSOR_VERSION = 1;
export const DEFAULT_SORT_FIELD = "id";

/** Thrown when a cursor is malformed, tampered with, or replayed against a different sort/filter. */
export class InvalidCursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCursorError";
  }
}

type CursorKey = string | number | boolean | null;

interface CursorPayload {
  v: number; // version
  k: CursorKey; // sort-key value of the anchor item
  id: number; // unique tiebreaker
  s: string; // sortBy field
  d: SortDirection;
  nav: "next" | "prev"; // direction this cursor travels
  sc: string; // scope tag (filter fingerprint), "" when unscoped
}

/** Reduce an arbitrary field value to a JSON-safe, comparable key. */
function toKey(value: unknown): CursorKey {
  if (value === null || value === undefined) return null;
  const t = typeof value;
  if (t === "number" || t === "string" || t === "boolean") return value as CursorKey;
  return String(value);
}

const TYPE_RANK: Record<string, number> = { boolean: 1, number: 2, string: 3 };

function keyRank(v: CursorKey): number {
  return v === null ? 0 : TYPE_RANK[typeof v];
}

/** Deterministic total order over keys (nulls first, then by type, then by value). */
function compareKeys(a: CursorKey, b: CursorKey): number {
  const ra = keyRank(a);
  const rb = keyRank(b);
  if (ra !== rb) return ra - rb;
  if (a === null || b === null) return 0;
  if (typeof a === "number" && typeof b === "number") {
    const na = Number.isNaN(a) ? -Infinity : a;
    const nb = Number.isNaN(b) ? -Infinity : b;
    return na < nb ? -1 : na > nb ? 1 : 0;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Comparator establishing the (sortBy, id) total order in the given direction. */
export function makeComparator<T extends DataItem>(
  sortBy: string,
  direction: SortDirection
): (x: T, y: T) => number {
  const sign = direction === "desc" ? -1 : 1;
  return (x, y) => {
    const c = compareKeys(toKey(x[sortBy]), toKey(y[sortBy]));
    if (c !== 0) return sign * c;
    return sign * (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
  };
}

/** Encode a payload as an opaque base64url token. */
function encodePayload(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function isSortDirection(v: unknown): v is SortDirection {
  return v === "asc" || v === "desc";
}

/** Decode and shape-validate a cursor token. Throws InvalidCursorError on any defect. */
export function decodeCursor(cursor: string): CursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new InvalidCursorError("Malformed cursor: token is not decodable");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new InvalidCursorError("Malformed cursor: payload is not an object");
  }
  const p = parsed as Record<string, unknown>;
  if (p.v !== CURSOR_VERSION) {
    throw new InvalidCursorError("Malformed cursor: unsupported cursor version");
  }
  if (typeof p.id !== "number" || !Number.isFinite(p.id)) {
    throw new InvalidCursorError("Malformed cursor: missing item id");
  }
  if (typeof p.s !== "string" || !isSortDirection(p.d)) {
    throw new InvalidCursorError("Malformed cursor: missing sort metadata");
  }
  if (p.nav !== "next" && p.nav !== "prev") {
    throw new InvalidCursorError("Malformed cursor: missing navigation direction");
  }
  const key = toKey(p.k);
  return {
    v: CURSOR_VERSION,
    k: key,
    id: p.id,
    s: p.s,
    d: p.d,
    nav: p.nav,
    sc: typeof p.sc === "string" ? p.sc : "",
  };
}

interface ResolvedCursorOptions {
  sortBy: string;
  direction: SortDirection;
  scope: string;
  limit: number;
}

function resolveOptions(
  request: CursorBasedRequest,
  config: PaginationConfig
): ResolvedCursorOptions {
  return {
    sortBy: request.sortBy ?? DEFAULT_SORT_FIELD,
    direction: request.sortDirection ?? "asc",
    scope: request.scope ?? "",
    limit: normalizeLimit(request.limit, config.defaultLimit, config.maxLimit),
  };
}

/**
 * Core pagination over an ALREADY-SORTED view. Binary-searches the anchor
 * tuple's boundary, so per-page seek cost is O(log n) instead of the O(n)
 * linear scan a findIndex-based implementation pays.
 */
function paginateSorted<T extends DataItem>(
  sorted: T[],
  opts: ResolvedCursorOptions,
  cursor: string | undefined
): CursorBasedResult<T> {
  const { sortBy, direction, scope, limit } = opts;
  const sign = direction === "desc" ? -1 : 1;

  let start: number;
  let end: number;

  if (cursor === undefined || cursor === "") {
    start = 0;
    end = Math.min(limit, sorted.length);
  } else {
    const payload = decodeCursor(cursor);
    if (payload.s !== sortBy || payload.d !== direction) {
      throw new InvalidCursorError(
        `Cursor was issued for sort "${payload.s} ${payload.d}" but the request asked for "${sortBy} ${direction}"`
      );
    }
    if (payload.sc !== scope) {
      throw new InvalidCursorError(
        "Cursor was issued for a different filter scope; restart pagination without a cursor"
      );
    }
    // Compare an item to the anchor tuple under the active total order.
    const cmpAnchor = (item: T): number => {
      const c = compareKeys(toKey(item[sortBy]), payload.k);
      if (c !== 0) return sign * c;
      return sign * (item.id < payload.id ? -1 : item.id > payload.id ? 1 : 0);
    };

    if (payload.nav === "next") {
      // First index strictly AFTER the anchor tuple.
      let lo = 0;
      let hi = sorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (cmpAnchor(sorted[mid]) <= 0) lo = mid + 1;
        else hi = mid;
      }
      start = lo;
      end = Math.min(start + limit, sorted.length);
    } else {
      // First index at-or-after the anchor tuple; page is the window before it.
      let lo = 0;
      let hi = sorted.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (cmpAnchor(sorted[mid]) < 0) lo = mid + 1;
        else hi = mid;
      }
      end = lo;
      start = Math.max(0, end - limit);
    }
  }

  const data = sorted.slice(start, end);
  const hasBefore = start > 0 && data.length > 0;
  const hasAfter = end < sorted.length && data.length > 0;

  const makeToken = (item: T, nav: "next" | "prev"): string =>
    encodePayload({
      v: CURSOR_VERSION,
      k: toKey(item[sortBy]),
      id: item.id,
      s: sortBy,
      d: direction,
      nav,
      sc: scope,
    });

  return {
    type: PaginationType.CURSOR_BASED,
    data,
    total: sorted.length,
    limit,
    sortBy,
    sortDirection: direction,
    nextCursor: hasAfter ? makeToken(data[data.length - 1], "next") : null,
    prevCursor: hasBefore ? makeToken(data[0], "prev") : null,
    hasMore: hasAfter,
  };
}

/**
 * One-shot cursor pagination. Sorts a copy of the data on every call - fine
 * for request-scoped datasets; for repeated pagination over the same large
 * dataset use createCursorPaginator, which sorts once.
 */
export function paginateWithCursor<T extends DataItem>(
  data: T[],
  request: CursorBasedRequest,
  config: PaginationConfig = DEFAULT_CONFIG
): CursorBasedResult<T> {
  const opts = resolveOptions(request, config);
  const sorted = [...data].sort(makeComparator<T>(opts.sortBy, opts.direction));
  return paginateSorted(sorted, opts, request.cursor);
}

export interface CursorPaginator<T extends DataItem> {
  /** Fetch a page. Omit the cursor for the first page. */
  page(cursor?: string, limit?: number): CursorBasedResult<T>;
  /** Number of items in the sorted view. */
  readonly size: number;
}

/**
 * Sort-once paginator for repeated pagination over a stable dataset.
 * Every page() call is O(log n + limit).
 */
export function createCursorPaginator<T extends DataItem>(
  data: T[],
  options: { sortBy?: string; sortDirection?: SortDirection; scope?: string } = {},
  config: PaginationConfig = DEFAULT_CONFIG
): CursorPaginator<T> {
  const base: CursorBasedRequest = {
    type: PaginationType.CURSOR_BASED,
    sortBy: options.sortBy,
    sortDirection: options.sortDirection,
    scope: options.scope,
  };
  const opts = resolveOptions(base, config);
  const sorted = [...data].sort(makeComparator<T>(opts.sortBy, opts.direction));
  return {
    page(cursor?: string, limit?: number): CursorBasedResult<T> {
      const perCall: ResolvedCursorOptions = {
        ...opts,
        limit: normalizeLimit(limit, config.defaultLimit, config.maxLimit),
      };
      return paginateSorted(sorted, perCall, cursor);
    },
    get size(): number {
      return sorted.length;
    },
  };
}
