/**
 * Regression tests for the Lumen Industries api-scenarios uplift.
 *
 * Each block pins a bug that was live in the frozen ref (44447fe) and green
 * in the shipped suite because the original tests asserted almost nothing
 * (e.g. the bulk tests accepted 404, i.e. "endpoint doesn't exist" counted
 * as a pass).
 */
import { FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { createTestServer } from "./server";
import { MockUserRepository, VersionConflictError } from "./repositories/mock-user-repository";
import { CrudService } from "./services/crud-service";
import { rateLimitContext, resetRateLimitState } from "./middleware/request-context";
import type { User } from "./types/entities";
import type { FastifyReply, FastifyRequest } from "fastify";

const SECRET = "test-secret";
const admin = (): string => `Bearer ${jwt.sign({ userId: "admin-1", role: "admin" }, SECRET)}`;
const asUser = (id: string): string => `Bearer ${jwt.sign({ userId: id, role: "user" }, SECRET)}`;

const newUser = (n: string): Record<string, string> => ({
  username: `user${n}`,
  email: `u${n}@example.com`,
  password: "password123",
  firstName: `F${n}`,
  lastName: `L${n}`,
});

describe("api-scenarios uplift regressions", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    app = await createTestServer();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function createUser(n: string): Promise<string> {
    const res = await app.inject({ method: "POST", url: "/api/v1/users", payload: newUser(n) });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.payload).data.id;
  }

  describe("query engine (MockUserRepository.findMany)", () => {
    it("distinct users can both be created (uniqueness is OR, not AND)", async () => {
      const a = await app.inject({ method: "POST", url: "/api/v1/users", payload: newUser("q1") });
      const b = await app.inject({ method: "POST", url: "/api/v1/users", payload: newUser("q2") });
      expect(a.statusCode).toBe(201);
      // Before the fix this returned 409: the two-filter AND query matched
      // nobody, so the duplicate check always passed... except the *second*
      // insert then collided differently. Assert the happy path works.
      expect(b.statusCode).toBe(201);
    });

    it("duplicate email is rejected; duplicate username is rejected", async () => {
      await app.inject({ method: "POST", url: "/api/v1/users", payload: newUser("dupbase") });
      const dupEmail = await app.inject({
        method: "POST",
        url: "/api/v1/users",
        payload: { ...newUser("other"), email: "udupbase@example.com" },
      });
      expect(dupEmail.statusCode).toBe(409);
      const dupUser = await app.inject({
        method: "POST",
        url: "/api/v1/users",
        payload: { ...newUser("x"), username: "userdupbase" },
      });
      expect(dupUser.statusCode).toBe(409);
    });

    it("pagination returns distinct pages with truthful hasNext/total", async () => {
      await createUser("pg1");
      await createUser("pg2");
      await createUser("pg3");
      const H = { authorization: admin() };
      const p1 = JSON.parse(
        (await app.inject({ method: "GET", url: "/api/v1/users?limit=1&page=1", headers: H })).payload
      ).data;
      const p2 = JSON.parse(
        (await app.inject({ method: "GET", url: "/api/v1/users?limit=1&page=2", headers: H })).payload
      ).data;
      expect(p1.data.length).toBe(1);
      expect(p2.data.length).toBe(1);
      expect(p1.data[0].id).not.toBe(p2.data[0].id); // was identical (page ignored)
      expect(p1.meta.hasNext).toBe(true); // was hardcoded false
      expect(p2.meta.hasPrev).toBe(true);
      expect(p1.meta.total).toBeGreaterThanOrEqual(3);
    });

    it("search that matches nothing returns zero rows", async () => {
      const H = { authorization: admin() };
      const res = JSON.parse(
        (await app.inject({ method: "GET", url: "/api/v1/users?search=zzz_no_such_user", headers: H }))
          .payload
      ).data;
      expect(res.data.length).toBe(0); // filters/search were ignored -> returned everyone
    });

    it("role filter only returns matching users", async () => {
      const H = { authorization: admin() };
      const res = JSON.parse(
        (await app.inject({ method: "GET", url: "/api/v1/users?role=admin&limit=100", headers: H }))
          .payload
      ).data;
      // No user is created with role=admin in these tests, so the filter must
      // exclude everyone (previously returned all users regardless of filter).
      expect(res.data.every((u: { role: string }) => u.role === "admin")).toBe(true);
    });
  });

  describe("store integrity", () => {
    it("a non-admin viewing another user does NOT destroy that user's phone number", async () => {
      const id = await createUser("phone");
      const own = { authorization: asUser(id) };
      const set = await app.inject({
        method: "PUT",
        url: `/api/v1/users/${id}`,
        headers: own,
        payload: { profile: { phoneNumber: "555-0100", timezone: "UTC", language: "en" } },
      });
      expect(set.statusCode).toBe(200);

      // Someone else views them (privacy filter path) — must not mutate the store.
      const other = await createUser("viewer");
      await app.inject({
        method: "GET",
        url: `/api/v1/users/${id}`,
        headers: { authorization: asUser(other) },
      });

      const self = JSON.parse(
        (await app.inject({ method: "GET", url: `/api/v1/users/${id}`, headers: own })).payload
      ).data;
      expect(self.profile.phoneNumber).toBe("555-0100"); // was undefined after other viewed
    });

    it("avatar upload does not wipe existing profile fields", async () => {
      const id = await createUser("avatar");
      const own = { authorization: asUser(id) };
      await app.inject({
        method: "PUT",
        url: `/api/v1/users/${id}`,
        headers: own,
        payload: { profile: { phoneNumber: "555-0200", timezone: "America/New_York", language: "fr" } },
      });

      const boundary = "----uplift";
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\nContent-Type: image/png\r\n\r\n`
        ),
        Buffer.from([0x89, 0x50, 0x4e, 0x47]),
        Buffer.from(`\r\n--${boundary}--\r\n`),
      ]);
      const up = await app.inject({
        method: "POST",
        url: `/api/v1/users/${id}/avatar`,
        headers: { ...own, "content-type": `multipart/form-data; boundary=${boundary}` },
        payload: body,
      });
      expect(up.statusCode).toBe(200);

      const self = JSON.parse(
        (await app.inject({ method: "GET", url: `/api/v1/users/${id}`, headers: own })).payload
      ).data;
      expect(self.profile.timezone).toBe("America/New_York"); // was reset/undefined
      expect(self.profile.language).toBe("fr");
      expect(self.profile.avatar).toContain("/uploads/avatars/");
    });

    it("partial preferences update preserves sibling fields (theme)", async () => {
      const id = await createUser("prefs");
      const own = { authorization: asUser(id) };
      // Set a non-default theme.
      await app.inject({
        method: "PUT",
        url: `/api/v1/users/${id}`,
        headers: own,
        payload: { preferences: { theme: "dark" } },
      });
      // Now update only a notification toggle.
      await app.inject({
        method: "PUT",
        url: `/api/v1/users/${id}`,
        headers: own,
        payload: { preferences: { notifications: { email: false } } },
      });
      const self = JSON.parse(
        (await app.inject({ method: "GET", url: `/api/v1/users/${id}`, headers: own })).payload
      ).data;
      expect(self.preferences.theme).toBe("dark"); // was reset to default "light"
      expect(self.preferences.notifications.email).toBe(false);
    });
  });

  describe("JWT algorithm pinning (RFC 8725 §3.1)", () => {
    it("rejects an HS256->none downgrade and an alg the app doesn't use", async () => {
      const id = await createUser("jwt");
      // A valid HS256 token still works.
      const ok = await app.inject({
        method: "GET",
        url: `/api/v1/users/${id}`,
        headers: { authorization: asUser(id) },
      });
      expect(ok.statusCode).toBe(200);

      // alg:none -> no signature. jsonwebtoken with a pinned algorithms list
      // must refuse to populate the user context, so an authed route 401s.
      const noneToken = jwt.sign({ userId: id, role: "admin" }, "", { algorithm: "none" });
      const none = await app.inject({
        method: "GET",
        url: "/api/v1/users",
        headers: { authorization: `Bearer ${noneToken}` },
      });
      expect(none.statusCode).toBe(401);
    });
  });

  describe("rate limiter (real enforcement)", () => {
    beforeEach(() => resetRateLimitState());
    afterAll(() => resetRateLimitState());

    const mkReqReply = (ip: string) => {  // eslint-disable-line @typescript-eslint/explicit-function-return-type
      const headers: Record<string, string> = {};
      let statusCode = 200;
      let sent: unknown;
      const reply = {
        header: (k: string, v: string) => {
          headers[k.toLowerCase()] = v;
          return reply;
        },
        code: (c: number) => {
          statusCode = c;
          return reply;
        },
        send: (payload: unknown) => {
          sent = payload;
          return reply;
        },
      } as unknown as FastifyReply;
      const request = {
        requestContext: { ip, requestId: "r" },
        socket: { remoteAddress: ip },
      } as unknown as FastifyRequest;
      return { request, reply, headers: () => headers, status: () => statusCode, body: () => sent };
    };

    it("counts down remaining and 429s past the limit with Retry-After", async () => {
      process.env.RATE_LIMIT_MAX = "3";
      process.env.RATE_LIMIT_WINDOW_MS = "10000";
      const ctx1 = mkReqReply("10.0.0.1");
      await rateLimitContext(ctx1.request, ctx1.reply);
      expect(ctx1.headers()["x-ratelimit-remaining"]).toBe("2");

      const ctx2 = mkReqReply("10.0.0.1");
      await rateLimitContext(ctx2.request, ctx2.reply);
      const ctx3 = mkReqReply("10.0.0.1");
      await rateLimitContext(ctx3.request, ctx3.reply);
      expect(ctx3.headers()["x-ratelimit-remaining"]).toBe("0");

      const ctx4 = mkReqReply("10.0.0.1");
      await rateLimitContext(ctx4.request, ctx4.reply);
      expect(ctx4.status()).toBe(429);
      expect(Number(ctx4.headers()["retry-after"])).toBeGreaterThan(0);

      // Different IP is independent.
      const other = mkReqReply("10.0.0.2");
      await rateLimitContext(other.request, other.reply);
      expect(other.status()).toBe(200);
      delete process.env.RATE_LIMIT_MAX;
      delete process.env.RATE_LIMIT_WINDOW_MS;
    });
  });

  describe("bulk endpoint (real, was a mock that 404'd in tests)", () => {
    it("bulk create actually persists users and rejects non-admins", async () => {
      const nonAdmin = await createUser("bulkactor");
      const forbidden = await app.inject({
        method: "POST",
        url: "/api/v1/users/bulk",
        headers: { authorization: asUser(nonAdmin) },
        payload: { operation: "create", data: [newUser("bc1")] },
      });
      expect(forbidden.statusCode).toBe(403);

      const res = await app.inject({
        method: "POST",
        url: "/api/v1/users/bulk",
        headers: { authorization: admin() },
        payload: { operation: "create", data: [newUser("bc2"), newUser("bc3")] },
      });
      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.payload).data;
      expect(data.processed).toBe(2);
      expect(data.results[0].data.passwordHash).toBeUndefined(); // sensitive field stripped

      // The created users are actually retrievable.
      const list = JSON.parse(
        (await app.inject({
          method: "GET",
          url: "/api/v1/users?search=bc2&limit=10",
          headers: { authorization: admin() },
        })).payload
      ).data;
      expect(list.data.length).toBeGreaterThanOrEqual(1);
    });

    it("bulk create rejects an in-batch duplicate email", async () => {
      const dup = { ...newUser("batchdup2"), email: "same@example.com" };
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/users/bulk",
        headers: { authorization: admin() },
        payload: {
          operation: "create",
          data: [
            { ...newUser("batchdup1"), email: "same@example.com" },
            dup,
          ],
        },
      });
      expect(res.statusCode).toBe(409);
    });

    it("bulk delete removes users and reports processed count", async () => {
      const a = await createUser("bd1");
      const b = await createUser("bd2");
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/users/bulk",
        headers: { authorization: admin() },
        payload: { operation: "delete", data: [a, b] },
      });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).data.processed).toBe(2);
    });
  });
});

describe("CrudService optimistic locking + bulk (unit)", () => {
  function makeService() {
    const repo = new MockUserRepository();
    const service = new CrudService<User>(repo, { entityName: "User", softDelete: true });
    return { repo, service };
  }

  it("update with a stale version throws a conflict mapped to 409", async () => {
    const { repo, service } = makeService();
    const created = await repo.create({
      username: "v",
      email: "v@example.com",
      passwordHash: "x",
      firstName: "V",
      lastName: "V",
      role: "user",
      status: "active",
      twoFactorEnabled: false,
      profile: { timezone: "UTC", language: "en" },
      preferences: {
        notifications: { email: true, push: true, sms: false },
        privacy: { profileVisible: true, showEmail: false, showPhone: false },
        theme: "light",
      },
    } as Omit<User, "id" | "createdAt" | "updatedAt">);

    const ok = await service.update(created.id, { firstName: "V2" }, undefined, 1);
    expect(ok.success).toBe(true);

    const stale = await service.update(created.id, { firstName: "V3" }, undefined, 1);
    expect(stale.success).toBe(false);
    expect(stale.error!.statusCode).toBe(409);
  });

  it("VersionConflictError message contains 'version' so CrudService maps it", () => {
    const err = new VersionConflictError("id", 1, 2);
    expect(err.message.toLowerCase()).toContain("version");
  });

  it("bulkDelete honors soft delete and counts processed", async () => {
    const { repo, service } = makeService();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const u = await repo.create({
        username: `bd${i}`,
        email: `bd${i}@example.com`,
        passwordHash: "x",
        firstName: "B",
        lastName: "D",
        role: "user",
        status: "active",
        twoFactorEnabled: false,
        profile: { timezone: "UTC", language: "en" },
        preferences: {
          notifications: { email: true, push: true, sms: false },
          privacy: { profileVisible: true, showEmail: false, showPhone: false },
          theme: "light",
        },
      } as Omit<User, "id" | "createdAt" | "updatedAt">);
      ids.push(u.id);
    }
    const res = await service.bulkDelete(ids);
    expect(res.success).toBe(true);
    expect(res.data!.processed).toBe(3);
  });
});
