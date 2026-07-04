import { parseAllowedOrigins, resolveAllowOrigin, buildCorsHeaders } from "./cors";

describe("parseAllowedOrigins", () => {
  it("splits a comma list and trims whitespace", () => {
    expect(parseAllowedOrigins("http://a.com, http://b.com ,http://c.com")).toEqual([
      "http://a.com",
      "http://b.com",
      "http://c.com",
    ]);
  });

  it("returns [] for empty/undefined/null input", () => {
    expect(parseAllowedOrigins(undefined)).toEqual([]);
    expect(parseAllowedOrigins(null)).toEqual([]);
    expect(parseAllowedOrigins("")).toEqual([]);
    expect(parseAllowedOrigins("  ,  ")).toEqual([]);
  });

  it("collapses to ['*'] when the list contains a wildcard", () => {
    expect(parseAllowedOrigins("http://a.com, *")).toEqual(["*"]);
  });
});

describe("resolveAllowOrigin", () => {
  it("returns '*' for wildcard without credentials", () => {
    expect(resolveAllowOrigin("http://a.com", ["*"], false)).toBe("*");
  });

  it("reflects the request origin for wildcard WITH credentials (never '*')", () => {
    expect(resolveAllowOrigin("http://a.com", ["*"], true)).toBe("http://a.com");
    // '*' + credentials is illegal, and with no origin there is nothing to reflect.
    expect(resolveAllowOrigin(null, ["*"], true)).toBeNull();
  });

  it("reflects a listed origin and rejects an unlisted one", () => {
    const allowed = ["http://a.com", "http://b.com"];
    expect(resolveAllowOrigin("http://b.com", allowed)).toBe("http://b.com");
    expect(resolveAllowOrigin("http://evil.com", allowed)).toBeNull();
  });

  it("returns null when there is no request origin and no wildcard", () => {
    expect(resolveAllowOrigin(null, ["http://a.com"])).toBeNull();
    expect(resolveAllowOrigin(undefined, ["http://a.com"])).toBeNull();
  });

  it("never emits a comma-joined multi-origin value", () => {
    const value = resolveAllowOrigin("http://a.com", ["http://a.com", "http://b.com"]);
    expect(value).not.toContain(",");
    expect(value).toBe("http://a.com");
  });
});

describe("buildCorsHeaders", () => {
  it("sets a single reflected origin plus Vary: Origin for a listed origin", () => {
    const h = buildCorsHeaders("http://a.com", ["http://a.com", "http://b.com"]);
    expect(h["Access-Control-Allow-Origin"]).toBe("http://a.com");
    expect(h["Vary"]).toBe("Origin");
    expect(h["Access-Control-Allow-Methods"]).toContain("GET");
    expect(h["Access-Control-Max-Age"]).toBe("86400");
    expect(h["Access-Control-Allow-Credentials"]).toBeUndefined();
  });

  it("omits ACAO entirely for an unlisted origin (browser will block)", () => {
    const h = buildCorsHeaders("http://evil.com", ["http://a.com"]);
    expect(h["Access-Control-Allow-Origin"]).toBeUndefined();
    expect(h["Access-Control-Allow-Methods"]).toBeUndefined();
    // Still advertises Vary so caches key on Origin.
    expect(h["Vary"]).toBe("Origin");
  });

  it("emits '*' and no Vary for wildcard without credentials", () => {
    const h = buildCorsHeaders("http://a.com", ["*"]);
    expect(h["Access-Control-Allow-Origin"]).toBe("*");
    expect(h["Vary"]).toBeUndefined();
  });

  it("adds Allow-Credentials and reflects origin under credentialed wildcard", () => {
    const h = buildCorsHeaders("http://a.com", ["*"], { credentials: true });
    expect(h["Access-Control-Allow-Origin"]).toBe("http://a.com");
    expect(h["Access-Control-Allow-Credentials"]).toBe("true");
    expect(h["Vary"]).toBe("Origin");
  });

  it("respects custom methods/headers/maxAge", () => {
    const h = buildCorsHeaders("http://a.com", ["http://a.com"], {
      methods: "GET",
      headers: "Content-Type",
      maxAge: 60,
    });
    expect(h["Access-Control-Allow-Methods"]).toBe("GET");
    expect(h["Access-Control-Allow-Headers"]).toBe("Content-Type");
    expect(h["Access-Control-Max-Age"]).toBe("60");
  });
});
