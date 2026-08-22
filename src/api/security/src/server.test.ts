// server.test.ts — HTTP integration tests via fastify.inject().
// These were previously impossible: importing server.ts bound port 3000 as an
// import side effect. The require.main guard added in this PR makes createApp
// importable, so the wiring (auth routing, oauth grants, profile updates) is
// now covered end-to-end.
process.env.JWT_SECRET = process.env.JWT_SECRET || "server-test-secret-with-plenty-of-entropy";

import jwt from "jsonwebtoken";
import type { FastifyInstance } from "fastify";
// require() after the env assignment above — server.ts exits at import time
// without JWT_SECRET, and ts-jest hoists `import` statements.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createApp } = require("./server") as typeof import("./server");

describe("Security API server integration", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  async function loginJWT(username: string, password: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { username, password, authType: "jwt" },
    });
    expect(res.statusCode).toBe(200);
    return res.json().token as string;
  }

  describe("OAuth token endpoint", () => {
    it("password grant returns a REAL refresh_token that the refresh grant accepts", async () => {
      const grant = await app.inject({
        method: "POST",
        url: "/oauth/token",
        payload: { grant_type: "password", username: "admin", password: "admin123" },
      });
      expect(grant.statusCode).toBe(200);
      const body = grant.json();
      expect(body.access_token).toBeDefined();
      expect(body.refresh_token).toBeDefined();
      expect(body.refresh_token).not.toBe("hidden_for_security"); // the old literal

      const refresh = await app.inject({
        method: "POST",
        url: "/oauth/token",
        payload: { grant_type: "refresh_token", refresh_token: body.refresh_token },
      });
      expect(refresh.statusCode).toBe(200);
      const refreshed = refresh.json();
      expect(refreshed.accessToken).toBeDefined();
      expect(refreshed.accessToken).not.toBe(body.access_token);
    });
  });

  describe("Profile update (mass assignment)", () => {
    it("ignores role escalation in the body, persists allow-listed fields", async () => {
      const reg = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: {
          username: "massassign",
          password: "pw-mass-1234",
          email: "mass@example.com",
        },
      });
      expect(reg.statusCode).toBe(201);

      const token = await loginJWT("massassign", "pw-mass-1234");

      const update = await app.inject({
        method: "PUT",
        url: "/auth/profile",
        headers: { authorization: `Bearer ${token}` },
        payload: { email: "mass-new@example.com", roles: ["admin"], passwordHash: "owned" },
      });
      expect(update.statusCode).toBe(200);
      const updatedUser = update.json().user;
      expect(updatedUser.roles).toEqual(["user"]); // NOT escalated
      expect(updatedUser.email).toBe("mass-new@example.com");
      expect(updatedUser.passwordHash).toBe("");

      // The old handler also never persisted anything — verify it sticks now
      const profile = await app.inject({
        method: "GET",
        url: "/auth/profile",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(profile.statusCode).toBe(200);
      expect(profile.json().user.email).toBe("mass-new@example.com");
      expect(profile.json().user.roles).toEqual(["user"]);
    });
  });

  describe("Bearer token routing by shape", () => {
    it("reports an expired JWT as 'Token expired', not 'Invalid bearer token'", async () => {
      const expired = jwt.sign(
        { userId: "whatever", username: "x", roles: ["user"] },
        process.env.JWT_SECRET as string,
        { algorithm: "HS256", expiresIn: "-10s" }
      );
      const res = await app.inject({
        method: "GET",
        url: "/auth/profile",
        headers: { authorization: `Bearer ${expired}` },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().message).toBe("Token expired");
    });

    it("still authenticates opaque bearer tokens issued by bearer_token login", async () => {
      const login = await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { username: "admin", password: "admin123", authType: "bearer_token" },
      });
      expect(login.statusCode).toBe(200);
      const res = await app.inject({
        method: "GET",
        url: "/auth/profile",
        headers: { authorization: `Bearer ${login.json().token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().authType).toBe("bearer_token");
    });
  });

  describe("JWT logout revocation over HTTP", () => {
    it("a logged-out JWT can no longer authenticate", async () => {
      const token = await loginJWT("admin", "admin123");

      const before = await app.inject({
        method: "GET",
        url: "/auth/profile",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(before.statusCode).toBe(200);

      const logout = await app.inject({
        method: "POST",
        url: "/auth/logout",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(logout.statusCode).toBe(200);
      expect(logout.json().success).toBe(true);

      const after = await app.inject({
        method: "GET",
        url: "/auth/profile",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(after.statusCode).toBe(401);
      expect(after.json().message).toBe("Token revoked");
    });
  });

  describe("Basic auth over HTTP with UTF-8 credentials", () => {
    it("authenticates a registered user whose password contains non-ASCII characters", async () => {
      const password = "sécrète-☃-пароль";
      const reg = await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: { username: "utf8http", password, email: "utf8http@example.com" },
      });
      expect(reg.statusCode).toBe(201);

      const header =
        "Basic " + Buffer.from(`utf8http:${password}`, "utf8").toString("base64");
      const res = await app.inject({
        method: "GET",
        url: "/auth/profile",
        headers: { authorization: header },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.username).toBe("utf8http");
    });
  });
});
