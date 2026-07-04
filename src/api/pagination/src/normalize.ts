// normalize.ts - shared integer normalization for pagination inputs.
//
// Why this exists: the previous implementation fed raw numbers straight into
// Array.prototype.slice(). A fractional page (page=1.5, limit=2) produced
// slice(1, 3) — silently returning the WRONG rows with no error. NaN limit
// poisoned totalPages (NaN) and returned an empty page while claiming
// success. Every numeric pagination input is now coerced to a safe integer
// with a deterministic fallback.

/** Coerce to a finite integer, falling back when the input is unusable. */
export function toSafeInt(value: number | undefined, fallback: number): number {
  if (value === undefined || typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  return Math.trunc(value);
}

/** Normalize a limit: integer, clamped to [1, maxLimit], defaulting to defaultLimit. */
export function normalizeLimit(
  limit: number | undefined,
  defaultLimit: number,
  maxLimit: number
): number {
  // "Give me everything" clamps to the ceiling; garbage falls back to the default.
  const candidate =
    limit === Number.POSITIVE_INFINITY ? maxLimit : toSafeInt(limit, defaultLimit);
  return Math.min(Math.max(candidate, 1), maxLimit);
}

/** Normalize a 1-based page number: integer, at least 1. */
export function normalizePage(page: number | undefined): number {
  return Math.max(toSafeInt(page, 1), 1);
}

/** Normalize a 0-based offset: integer, at least 0. */
export function normalizeOffset(offset: number | undefined): number {
  return Math.max(toSafeInt(offset, 0), 0);
}
