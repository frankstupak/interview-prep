import { webcrypto as nodeCrypto } from "crypto";
import type { NextRequest } from "next/server";

jest.setTimeout(10000);

if (!globalThis.crypto) {
  globalThis.crypto = nodeCrypto as unknown as Crypto;
}

type RouteModule = typeof import("./route");

const withFreshModule = async (callback: (module: RouteModule) => Promise<void>): Promise<void> => {
  await jest.isolateModulesAsync(async () => {
    const module = await import("./route");
    await callback(module);
  });
};

const createRequest = (payload: unknown): Request =>
  ({
    json: async () => payload,
  }) as unknown as Request;

const createGetRequest = (query: string): NextRequest =>
  ({
    nextUrl: new URL(`http://localhost/api/users?${query}`),
  }) as unknown as NextRequest;

describe("/api/users route handlers", () => {
  it("returns an empty user list by default", async () => {
    await withFreshModule(async ({ GET }) => {
      const response = await GET(createGetRequest(""));
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
    });
  });

  it("creates a new user with valid payload", async () => {
    await withFreshModule(async ({ POST, GET }) => {
      const request = createRequest({ email: "user@example.com", name: "Test User" });

      const createResponse = await POST(request as NextRequest);
      expect(createResponse.status).toBe(201);

      const createBody = await createResponse.json();
      expect(createBody.success).toBe(true);
      expect(createBody.data.email).toBe("user@example.com");
      expect(createBody.data.name).toBe("Test User");
      expect(typeof createBody.data.id).toBe("string");

      const listResponse = await GET(createGetRequest(""));
      const listBody = await listResponse.json();
      expect(listBody.total).toBe(1);
      expect(listBody.data[0].email).toBe("user@example.com");
    });
  });

  it("returns validation errors for invalid payloads", async () => {
    await withFreshModule(async ({ POST }) => {
      const response = await POST(createRequest({ email: "invalid", name: "" }) as NextRequest);
      expect(response.status).toBe(400);

      const body = await response.json();
      expect(body.success).toBe(false);
      expect(body.error).toBe("Validation error");
      expect(Array.isArray(body.details)).toBe(true);
    });
  });

  it("rejects a whitespace-only name (plain min(1) would accept it)", async () => {
    await withFreshModule(async ({ POST }) => {
      const response = await POST(
        createRequest({ email: "ws@example.com", name: "   " }) as NextRequest
      );
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Validation error");
    });
  });

  it("normalizes email (trim + lowercase) on create", async () => {
    await withFreshModule(async ({ POST, GET }) => {
      const response = await POST(
        createRequest({ email: "  MixedCase@Example.COM ", name: "Case User" }) as NextRequest
      );
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.data.email).toBe("mixedcase@example.com");

      const list = await (await GET(createGetRequest(""))).json();
      expect(list.data[0].email).toBe("mixedcase@example.com");
    });
  });

  it("rejects a duplicate email with 409 Conflict", async () => {
    await withFreshModule(async ({ POST, GET }) => {
      const first = await POST(
        createRequest({ email: "dupe@example.com", name: "First" }) as NextRequest
      );
      expect(first.status).toBe(201);

      const second = await POST(
        createRequest({ email: "dupe@example.com", name: "Second" }) as NextRequest
      );
      expect(second.status).toBe(409);
      const body = await second.json();
      expect(body.success).toBe(false);
      expect(body.error).toBe("Email already exists");

      // No duplicate was stored.
      const list = await (await GET(createGetRequest(""))).json();
      expect(list.total).toBe(1);
    });
  });

  it("treats differently-cased / padded emails as the same identity", async () => {
    await withFreshModule(async ({ POST, GET }) => {
      await POST(createRequest({ email: "person@example.com", name: "A" }) as NextRequest);
      const dup = await POST(
        createRequest({ email: " Person@Example.com ", name: "B" }) as NextRequest
      );
      expect(dup.status).toBe(409);

      const list = await (await GET(createGetRequest(""))).json();
      expect(list.total).toBe(1);
    });
  });

  it("paginates with limit/offset while keeping the full total (backward compatible)", async () => {
    await withFreshModule(async ({ POST, GET }) => {
      for (let i = 0; i < 5; i += 1) {
        // eslint-disable-next-line no-await-in-loop -- sequential inserts for deterministic order
        await POST(createRequest({ email: `u${i}@example.com`, name: `U${i}` }) as NextRequest);
      }

      const page = await GET(createGetRequest("limit=2&offset=1"));
      expect(page.status).toBe(200);
      const body = await page.json();
      expect(body.total).toBe(5);
      expect(body.data).toHaveLength(2);
      expect(body.data[0].email).toBe("u1@example.com");
      expect(body.data[1].email).toBe("u2@example.com");
    });
  });

  it("returns the full list unchanged when no pagination params are given", async () => {
    await withFreshModule(async ({ POST, GET }) => {
      await POST(createRequest({ email: "only@example.com", name: "Only" }) as NextRequest);
      const body = await (await GET(createGetRequest(""))).json();
      expect(body.data).toHaveLength(1);
      expect(body.total).toBe(1);
    });
  });

  it("rejects invalid pagination params with 400", async () => {
    await withFreshModule(async ({ GET }) => {
      const response = await GET(createGetRequest("limit=-3"));
      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toBe("Validation error");
    });
  });
});
