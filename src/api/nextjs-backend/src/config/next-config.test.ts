/**
 * Regression guards for next.config.js:
 *  1. Secrets (JWT_SECRET / DATABASE_URL) are never placed in the `env` block,
 *     which Next inlines into the JavaScript bundle at build time.
 *  2. The static header block does not emit an Access-Control-Allow-Origin
 *     header — it cannot be varied per request and a comma/space list is an
 *     invalid ACAO value. (CORS lives in middleware.ts.)
 *  3. X-XSS-Protection is disabled ("0") per current OWASP guidance.
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- require a CommonJS config
const nextConfig = require("../../next.config.js");

describe("next.config.js hardening", () => {
  it("does not expose secrets through the inlined `env` block", () => {
    const env = (nextConfig.env ?? {}) as Record<string, unknown>;
    expect(Object.keys(env)).not.toContain("JWT_SECRET");
    expect(Object.keys(env)).not.toContain("DATABASE_URL");
  });

  it("does not emit a static Access-Control-Allow-Origin header", async () => {
    const groups = await nextConfig.headers();
    const allHeaders = groups.flatMap(
      (g: { headers: Array<{ key: string; value: string }> }) => g.headers
    );
    const acao = allHeaders.find(
      (h: { key: string }) => h.key.toLowerCase() === "access-control-allow-origin"
    );
    expect(acao).toBeUndefined();
    // And nothing sneaks a comma-list origin into any header value.
    for (const h of allHeaders) {
      if (h.key.toLowerCase().startsWith("access-control-allow-origin")) {
        expect(h.value).not.toContain(",");
      }
    }
  });

  it("sets modern security headers", async () => {
    const groups = await nextConfig.headers();
    const allHeaders = groups.flatMap(
      (g: { headers: Array<{ key: string; value: string }> }) => g.headers
    );
    const byKey = (k: string): string | undefined =>
      allHeaders.find((h: { key: string }) => h.key.toLowerCase() === k)?.value;

    expect(byKey("x-xss-protection")).toBe("0");
    expect(byKey("x-content-type-options")).toBe("nosniff");
    expect(byKey("x-frame-options")).toBe("DENY");
  });
});
