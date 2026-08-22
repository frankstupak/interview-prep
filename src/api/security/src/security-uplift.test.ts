// security-uplift.test.ts — regression tests for the Lumen Industries uplift.
// Every test here pins a specific bug fixed in this PR; each would fail
// against the previous implementation.
import jwt from "jsonwebtoken";
import { AuthenticationManager } from "./auth-methods";
import { RoleBasedAccessControl, Permission } from "./rbac";
import { AuthConfig, AuthType, Role } from "./auth-types";
import { AuthErrorMessage } from "./constants";

const baseConfig: AuthConfig = {
  jwtSecret: "uplift-test-secret-with-plenty-of-entropy",
  jwtExpiresIn: "1h",
  sessionExpiresIn: 60 * 60 * 1000,
  bcryptRounds: 4, // fast for tests — and exercises the dummy-hash cost parity fix
  bearerTokenExpiresIn: 60 * 60 * 1000,
  refreshTokenExpiresIn: 2 * 60 * 60 * 1000,
  apiKeyPrefix: "sk_live",
};

function makeManager(overrides: Partial<AuthConfig> = {}): AuthenticationManager {
  return new AuthenticationManager({ ...baseConfig, ...overrides });
}

function basicHeader(username: string, password: string): string {
  return "Basic " + Buffer.from(`${username}:${password}`, "utf8").toString("base64");
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("Security uplift regressions", () => {
  describe("Basic auth credential decoding (RFC 7617)", () => {
    it("authenticates a password containing non-ASCII (UTF-8) characters", async () => {
      const manager = makeManager();
      const password = "pässwörd-☃-мир";
      const reg = await manager.registerUser({
        username: "unicodeuser",
        password,
        email: "unicode@example.com",
      });
      expect(reg.success).toBe(true);

      // The old "ascii" decode masked every byte to 7 bits, so this user
      // could never log in via Basic auth.
      const result = await manager.authenticateBasic(basicHeader("unicodeuser", password));
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.user.username).toBe("unicodeuser");
      }
    });

    it("rejects non-base64 garbage in the Basic header", async () => {
      const manager = makeManager();
      const result = await manager.authenticateBasic("Basic !!!not-base64!!!");
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe(AuthErrorMessage.INVALID_BASIC_AUTH_HEADER);
      }
    });
  });

  describe("bcrypt 72-byte password limit (OWASP)", () => {
    it("rejects passwords longer than 72 bytes instead of silently truncating", async () => {
      const manager = makeManager();
      const result = await manager.registerUser({
        username: "longpw",
        password: "a".repeat(73),
        email: "longpw@example.com",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe(AuthErrorMessage.PASSWORD_TOO_LONG);
      }
    });

    it("accepts a password of exactly 72 bytes", async () => {
      const manager = makeManager();
      const result = await manager.registerUser({
        username: "exact72",
        password: "a".repeat(72),
        email: "exact72@example.com",
      });
      expect(result.success).toBe(true);
    });

    it("measures the limit in BYTES, not characters (multibyte input)", async () => {
      const manager = makeManager();
      // 25 snowmen = 25 chars but 75 UTF-8 bytes
      const result = await manager.registerUser({
        username: "snowman",
        password: "☃".repeat(25),
        email: "snowman@example.com",
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe(AuthErrorMessage.PASSWORD_TOO_LONG);
      }
    });
  });

  describe("JWT algorithm pinning (RFC 8725)", () => {
    it("rejects a token signed with a different HMAC algorithm (HS512) under the same secret", async () => {
      const manager = makeManager();
      const admin = manager.getUserByUsername("admin")!;
      // Attacker-style token: valid secret, valid claims, but the header
      // names HS512. The old verify accepted any HMAC alg the header chose.
      const forged = jwt.sign(
        { userId: admin.id, username: admin.username, roles: admin.roles },
        baseConfig.jwtSecret,
        { algorithm: "HS512", expiresIn: "1h" }
      );
      const result = await manager.authenticateJWT(forged);
      expect(result.success).toBe(false);
    });

    it("still accepts legitimate HS256 tokens issued by login()", async () => {
      const manager = makeManager();
      const login = await manager.login({ username: "admin", password: "admin123" }, AuthType.JWT);
      expect(login.success).toBe(true);
      const result = await manager.authenticateJWT(login.token!);
      expect(result.success).toBe(true);
    });

    it("embeds a unique jti claim in issued tokens", async () => {
      const manager = makeManager();
      const a = await manager.login({ username: "admin", password: "admin123" }, AuthType.JWT);
      const b = await manager.login({ username: "admin", password: "admin123" }, AuthType.JWT);
      const payloadA = jwt.decode(a.token!) as { jti?: string };
      const payloadB = jwt.decode(b.token!) as { jti?: string };
      expect(payloadA.jti).toBeDefined();
      expect(payloadB.jti).toBeDefined();
      expect(payloadA.jti).not.toBe(payloadB.jti);
    });
  });

  describe("JWT revocation on logout", () => {
    it("rejects a revoked token until its natural expiry", async () => {
      const manager = makeManager();
      const login = await manager.login({ username: "admin", password: "admin123" }, AuthType.JWT);
      expect(login.success).toBe(true);
      const token = login.token!;

      // Valid before logout
      expect((await manager.authenticateJWT(token)).success).toBe(true);

      // Logout revokes — the old implementation was a silent no-op
      const logout = await manager.logout(token, AuthType.JWT);
      expect(logout.success).toBe(true);

      const after = await manager.authenticateJWT(token);
      expect(after.success).toBe(false);
      if (!after.success) {
        expect(after.error).toBe(AuthErrorMessage.TOKEN_REVOKED);
      }
    });

    it("only revokes the logged-out token, not other sessions", async () => {
      const manager = makeManager();
      const a = await manager.login({ username: "admin", password: "admin123" }, AuthType.JWT);
      const b = await manager.login({ username: "admin", password: "admin123" }, AuthType.JWT);
      await manager.logout(a.token!, AuthType.JWT);
      expect((await manager.authenticateJWT(a.token!)).success).toBe(false);
      expect((await manager.authenticateJWT(b.token!)).success).toBe(true);
    });

    it("prunes revocation entries once the underlying token has expired", async () => {
      const manager = makeManager({ jwtExpiresIn: "1s" });
      const login = await manager.login({ username: "admin", password: "admin123" }, AuthType.JWT);
      await manager.logout(login.token!, AuthType.JWT);

      // Revoked while still unexpired
      expect((await manager.authenticateJWT(login.token!)).success).toBe(false);

      await sleep(1200); // let the token pass its natural expiry
      expect(manager.clearExpiredRevokedJtis()).toBe(1);
      expect(manager.clearExpiredRevokedJtis()).toBe(0);

      // The token itself is now simply expired
      const result = await manager.authenticateJWT(login.token!);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe(AuthErrorMessage.TOKEN_EXPIRED);
      }
    });
  });

  describe("Refresh token exposure through login()", () => {
    it("returns the refresh token for BEARER_TOKEN logins and it actually refreshes", async () => {
      const manager = makeManager();
      const login = await manager.login(
        { username: "admin", password: "admin123" },
        AuthType.BEARER_TOKEN
      );
      expect(login.success).toBe(true);
      expect(login.refreshToken).toBeDefined();

      const refreshed = await manager.refreshBearerToken(login.refreshToken!);
      expect("accessToken" in refreshed).toBe(true);
      if ("accessToken" in refreshed) {
        expect(refreshed.accessToken).not.toBe(login.token);
        const auth = await manager.authenticateBearerToken(refreshed.accessToken);
        expect(auth.success).toBe(true);
      }
    });
  });

  describe("updateUser allow-list (mass-assignment protection)", () => {
    it("updates email and username, and maintains the lookup indices", async () => {
      const manager = makeManager();
      const reg = await manager.registerUser({
        username: "renameme",
        password: "pw123456",
        email: "old@example.com",
      });
      expect(reg.success).toBe(true);
      const userId = reg.success ? reg.user.id : "";

      const updated = manager.updateUser(userId, {
        username: "renamed",
        email: "new@example.com",
      });
      expect(updated.success).toBe(true);

      // Old username no longer resolves; new one does (index integrity)
      expect(manager.getUserByUsername("renameme")).toBeUndefined();
      expect(manager.getUserByUsername("renamed")?.id).toBe(userId);

      // Login works under the new username, and old email is freed
      const login = await manager.login({ username: "renamed", password: "pw123456" }, AuthType.JWT);
      expect(login.success).toBe(true);
      const reuse = await manager.registerUser({
        username: "someoneelse",
        password: "pw123456",
        email: "old@example.com",
      });
      expect(reuse.success).toBe(true);
    });

    it("rejects updates that collide with an existing username or email", () => {
      const manager = makeManager();
      const user = manager.getUserByUsername("user")!;
      expect(manager.updateUser(user.id, { username: "admin" }).success).toBe(false);
      expect(manager.updateUser(user.id, { email: "admin@example.com" }).success).toBe(false);
    });

    it("fails for a non-existent user", () => {
      const manager = makeManager();
      const result = manager.updateUser("no-such-id", { email: "x@example.com" });
      expect(result.success).toBe(false);
    });
  });

  describe("API key lookup after the O(1) refactor", () => {
    it("keeps active/revoked semantics intact across multiple keys", async () => {
      const manager = makeManager();
      const admin = manager.getUserByUsername("admin")!;
      const k1 = await manager.createApiKey(admin.id, { name: "key-one" });
      const k2 = await manager.createApiKey(admin.id, { name: "key-two" });
      expect(k1.success && k2.success).toBe(true);

      await manager.revokeApiKey(admin.id, k1.keyInfo!.id);
      expect((await manager.authenticateApiKey(k1.apiKey!)).success).toBe(false);
      expect((await manager.authenticateApiKey(k2.apiKey!)).success).toBe(true);
    });
  });

  describe("RBAC internal-state protection and Set index coherence", () => {
    it("getRolePermissions returns a copy — mutating it cannot alter role permissions", () => {
      const rbac = new RoleBasedAccessControl();
      const guestUser = {
        id: "g1",
        username: "g",
        email: "g@example.com",
        passwordHash: "",
        roles: [Role.GUEST],
        createdAt: new Date(),
      };

      const leaked = rbac.getRolePermissions(Role.GUEST);
      leaked.push(Permission.ADMIN_ACCESS); // old code: this mutated live state

      expect(rbac.hasPermission(guestUser, Permission.ADMIN_ACCESS)).toBe(false);
      expect(rbac.getRolePermissions(Role.GUEST)).not.toContain(Permission.ADMIN_ACCESS);
    });

    it("add/removePermissionFromRole stay coherent with permission checks", () => {
      const rbac = new RoleBasedAccessControl();
      const guestUser = {
        id: "g2",
        username: "g2",
        email: "g2@example.com",
        passwordHash: "",
        roles: [Role.GUEST],
        createdAt: new Date(),
      };

      expect(rbac.hasPermission(guestUser, Permission.VIEW_LOGS)).toBe(false);
      rbac.addPermissionToRole(Role.GUEST, Permission.VIEW_LOGS);
      expect(rbac.hasPermission(guestUser, Permission.VIEW_LOGS)).toBe(true);
      rbac.removePermissionFromRole(Role.GUEST, Permission.VIEW_LOGS);
      expect(rbac.hasPermission(guestUser, Permission.VIEW_LOGS)).toBe(false);
    });
  });

  describe("Dummy-hash timing parity", () => {
    it("unknown users still fail with the standard invalid-credentials error", async () => {
      // Behavioral guard for the constructor-computed dummy hash: the
      // user-not-found path must be indistinguishable in RESPONSE from the
      // wrong-password path (the timing parity itself now holds at any
      // configured cost, not just cost 12).
      const manager = makeManager({ bcryptRounds: 6 });
      const missing = await manager.login({ username: "ghost", password: "nope" }, AuthType.JWT);
      const wrongPw = await manager.login({ username: "admin", password: "nope" }, AuthType.JWT);
      expect(missing.success).toBe(false);
      expect(wrongPw.success).toBe(false);
      if (!missing.success && !wrongPw.success) {
        expect(missing.error).toBe(wrongPw.error);
      }
    });
  });
});
