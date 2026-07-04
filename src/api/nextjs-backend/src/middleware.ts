import { NextRequest, NextResponse } from "next/server";
import { buildCorsHeaders, parseAllowedOrigins } from "@/lib/cors";

/**
 * Dynamic CORS for /api routes.
 *
 * Replaces the previous static `Access-Control-Allow-Origin` header in
 * next.config.js, which set the raw (comma-separated) ALLOWED_ORIGINS value —
 * an invalid ACAO header that browsers reject. Here we match the request
 * Origin against the allow-list and reflect a single valid origin, add
 * `Vary: Origin`, and answer preflight (OPTIONS) with 204.
 */
export function middleware(request: NextRequest): NextResponse {
  const requestOrigin = request.headers.get("origin");
  const isProduction = process.env.NODE_ENV === "production";

  // Dev: allow any origin. Prod: only the configured allow-list.
  const allowed = isProduction
    ? parseAllowedOrigins(process.env.ALLOWED_ORIGINS)
    : ["*"];

  const credentials = process.env.CORS_ALLOW_CREDENTIALS === "true";
  const corsHeaders = buildCorsHeaders(requestOrigin, allowed, { credentials });

  if (request.method === "OPTIONS") {
    return new NextResponse(null, { status: 204, headers: corsHeaders });
  }

  const response = NextResponse.next();
  for (const [key, value] of Object.entries(corsHeaders)) {
    response.headers.set(key, value);
  }
  return response;
}

export const config = {
  matcher: "/api/:path*",
};
