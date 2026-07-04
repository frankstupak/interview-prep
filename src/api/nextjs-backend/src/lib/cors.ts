/**
 * CORS helpers.
 *
 * The `Access-Control-Allow-Origin` (ACAO) header is NOT list-valued: per the
 * Fetch/CORS spec it must be exactly one origin, the literal `*`, or `null`.
 * Emitting a comma- or space-separated list (e.g. the raw value of an
 * `ALLOWED_ORIGINS="a,b"` env var) produces a header every browser rejects.
 *
 * The correct pattern for a multi-origin allow-list is to match the incoming
 * `Origin` against the list and reflect back the single matching origin, plus
 * `Vary: Origin` so shared caches don't serve one origin's response to another.
 */

export interface BuildCorsOptions {
  /** Whether responses may carry credentials. With credentials, `*` is illegal. */
  credentials?: boolean;
  /** Value for Access-Control-Allow-Methods. */
  methods?: string;
  /** Value for Access-Control-Allow-Headers. */
  headers?: string;
  /** Access-Control-Max-Age (seconds) for preflight caching. */
  maxAge?: number;
}

const WILDCARD = "*";

/**
 * Parse a raw allow-list string ("a, b ,c") into a clean array of origins.
 * A list containing "*" collapses to ["*"].
 */
export function parseAllowedOrigins(raw?: string | null): string[] {
  if (!raw) {
    return [];
  }
  const parts = raw
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o.length > 0);
  return parts.includes(WILDCARD) ? [WILDCARD] : parts;
}

/**
 * Decide the single value for Access-Control-Allow-Origin.
 *
 * - Wildcard + no credentials  -> "*"
 * - Wildcard + credentials     -> reflect the request origin (never "*"),
 *                                 because "*" with credentials is rejected.
 * - Explicit list              -> reflect the request origin iff it is listed.
 * - Otherwise                  -> null (omit the header; browser blocks it).
 */
export function resolveAllowOrigin(
  requestOrigin: string | null | undefined,
  allowed: string[],
  credentials = false
): string | null {
  const isWildcard = allowed.includes(WILDCARD);

  if (isWildcard && !credentials) {
    return WILDCARD;
  }
  if (isWildcard && credentials) {
    return requestOrigin ?? null;
  }
  if (requestOrigin && allowed.includes(requestOrigin)) {
    return requestOrigin;
  }
  return null;
}

/**
 * Build the full set of CORS response headers for a request. Returns only the
 * headers that should actually be set (no invalid/empty values).
 */
export function buildCorsHeaders(
  requestOrigin: string | null | undefined,
  allowed: string[],
  options: BuildCorsOptions = {}
): Record<string, string> {
  const {
    credentials = false,
    methods = "GET, POST, PUT, DELETE, PATCH, OPTIONS",
    headers = "Content-Type, Authorization, X-Requested-With",
    maxAge = 86400,
  } = options;

  const allowOrigin = resolveAllowOrigin(requestOrigin, allowed, credentials);
  const result: Record<string, string> = {};

  if (allowOrigin) {
    result["Access-Control-Allow-Origin"] = allowOrigin;
    result["Access-Control-Allow-Methods"] = methods;
    result["Access-Control-Allow-Headers"] = headers;
    result["Access-Control-Max-Age"] = String(maxAge);
    if (credentials) {
      result["Access-Control-Allow-Credentials"] = "true";
    }
  }

  // Always advertise that the response varies by Origin whenever the decision
  // depends on it (i.e. anything other than a static "*").
  if (allowOrigin !== WILDCARD) {
    result["Vary"] = "Origin";
  }

  return result;
}
