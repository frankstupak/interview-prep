// server.test.ts - HTTP-level tests via Fastify inject (no port binding).
// These were previously impossible: importing server.ts started a live
// listener on :3001 as a module side effect.
import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import type { FastifyInstance } from "fastify";
import { createApp } from "./server";

let app: FastifyInstance;

beforeAll(async () => {
  app = await createApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("GET /employees/cursor-based", () => {
  it("returns a first page with cursors and stable metadata", async () => {
    const res = await app.inject({ url: "/employees/cursor-based?limit=5" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(5);
    expect(body.type).toBe("cursor_based");
    expect(body.nextCursor).toEqual(expect.any(String));
    expect(body.prevCursor).toBeNull();
    expect(body.sortBy).toBe("id");
    expect(body.sortDirection).toBe("asc");
  });

  it("walks the full dataset via nextCursor with no duplicates or gaps", async () => {
    const first = await app.inject({ url: "/employees/cursor-based?limit=1" });
    const total: number = first.json().total;

    const seen = new Set<number>();
    let cursor: string | null = null;
    let guard = 0;
    for (;;) {
      const url: string =
        "/employees/cursor-based?limit=50" +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const res = await app.inject({ url });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        data: Array<{ id: number }>;
        nextCursor: string | null;
      };
      for (const item of body.data) {
        expect(seen.has(item.id)).toBe(false);
        seen.add(item.id);
      }
      cursor = body.nextCursor;
      if (cursor === null) break;
      if (++guard > 1000) throw new Error("cursor sweep did not terminate");
    }
    expect(seen.size).toBe(total);
  });

  it("supports sorting by a non-unique field without dropping rows", async () => {
    const first = await app.inject({ url: "/employees/cursor-based?limit=1" });
    const total: number = first.json().total;

    const seen = new Set<number>();
    let cursor: string | null = null;
    for (let i = 0; i < 1000; i++) {
      const url: string =
        "/employees/cursor-based?limit=37&sortBy=department&sortDirection=desc" +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
      const body = (await app.inject({ url })).json() as {
        data: Array<{ id: number }>;
        nextCursor: string | null;
      };
      for (const item of body.data) seen.add(item.id);
      cursor = body.nextCursor;
      if (cursor === null) break;
    }
    expect(seen.size).toBe(total);
  });

  it("rejects a malformed cursor with 400 invalid_cursor", async () => {
    const res = await app.inject({ url: "/employees/cursor-based?cursor=garbage" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_cursor");
  });

  it("rejects a cursor replayed against a different department filter", async () => {
    const page1 = await app.inject({
      url: "/employees/cursor-based?limit=2&department=engineering",
    });
    const cursor = page1.json().nextCursor;
    if (cursor === null) return; // dataset too small for this filter; nothing to replay
    const res = await app.inject({
      url: `/employees/cursor-based?limit=2&department=sales&cursor=${encodeURIComponent(cursor)}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_cursor");
  });

  it("rejects a cursor replayed against a different sort", async () => {
    const page1 = await app.inject({ url: "/employees/cursor-based?limit=2" });
    const cursor = page1.json().nextCursor;
    const res = await app.inject({
      url: `/employees/cursor-based?limit=2&sortBy=salary&cursor=${encodeURIComponent(cursor)}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_cursor");
  });

  it("rejects an unknown sortBy field", async () => {
    const res = await app.inject({ url: "/employees/cursor-based?sortBy=passwordHash" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects limit=0", async () => {
    const res = await app.inject({ url: "/employees/cursor-based?limit=0" });
    expect(res.statusCode).toBe(400);
  });
});

describe("Strict integer query parsing (regression)", () => {
  it("rejects page=5abc instead of silently treating it as 5", async () => {
    const res = await app.inject({ url: "/employees/page-based?page=5abc&limit=2" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects page=1.5 instead of silently truncating to 1", async () => {
    const res = await app.inject({ url: "/employees/page-based?page=1.5&limit=2" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects offset=2.5 on the offset endpoint", async () => {
    const res = await app.inject({ url: "/employees/offset-based?offset=2.5&limit=2" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects limit=10x on the offset endpoint", async () => {
    const res = await app.inject({ url: "/employees/offset-based?limit=10x" });
    expect(res.statusCode).toBe(400);
  });

  it("still accepts plain integers", async () => {
    const res = await app.inject({ url: "/employees/page-based?page=2&limit=3" });
    expect(res.statusCode).toBe(200);
    expect(res.json().page).toBe(2);
    expect(res.json().data).toHaveLength(3);
  });
});

describe("GET /employees/paginate with type=cursor_based", () => {
  it("serves cursor pagination through the unified endpoint", async () => {
    const res = await app.inject({ url: "/employees/paginate?type=cursor_based&limit=4" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.type).toBe("cursor_based");
    expect(body.data).toHaveLength(4);
    expect(body.nextCursor).toEqual(expect.any(String));

    const res2 = await app.inject({
      url: `/employees/paginate?type=cursor_based&limit=4&cursor=${encodeURIComponent(body.nextCursor)}`,
    });
    expect(res2.statusCode).toBe(200);
    expect(res2.json().data[0].id).not.toBe(body.data[0].id);
  });

  it("rejects an invalid sortBy through the unified endpoint", async () => {
    const res = await app.inject({
      url: "/employees/paginate?type=cursor_based&sortBy=notAField",
    });
    expect(res.statusCode).toBe(400);
  });

  it("keeps existing page-based behavior intact", async () => {
    const res = await app.inject({ url: "/employees/paginate?type=page_based&page=1&limit=5" });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(5);
  });
});

describe("GET /employees/stats", () => {
  it("still returns per-department counts after the single-pass rewrite", async () => {
    const res = await app.inject({ url: "/employees/stats" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBeGreaterThan(0);
    const counted = Object.values(body.departmentCounts as Record<string, number>).reduce(
      (a, b) => a + b,
      0
    );
    expect(counted).toBe(body.total);
    expect(body.departments).toEqual([...body.departments].sort());
  });
});
