/* eslint-disable no-console */
// benchmark.ts — before/after numbers for the three hot paths changed in the
// Lumen Industries security uplift. "Before" variants replicate the exact
// lookup strategy of the previous implementation over identical data, so the
// comparison isolates precisely what changed.
//
// Run from src/api/security:  npx tsx scripts/benchmark.ts
import crypto from "crypto";
import { AuthenticationManager } from "../src/auth-methods";
import { RoleBasedAccessControl, Permission } from "../src/rbac";
import { AuthConfig, Role, User } from "../src/auth-types";

const config: AuthConfig = {
  jwtSecret: "bench-secret-with-plenty-of-entropy",
  jwtExpiresIn: "1h",
  sessionExpiresIn: 3_600_000,
  bcryptRounds: 4,
  bearerTokenExpiresIn: 3_600_000,
  refreshTokenExpiresIn: 7_200_000,
  apiKeyPrefix: "sk_live",
};

function report(label: string, iters: number, ms: number): number {
  const opsPerSec = (iters / ms) * 1000;
  console.log(
    `  ${label.padEnd(46)} ${ms.toFixed(1).padStart(9)} ms  ${Math.round(opsPerSec)
      .toLocaleString("en-US")
      .padStart(14)} ops/s`
  );
  return opsPerSec;
}

function timeSync(fn: () => void): number {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
}

async function timeAsync(fn: () => Promise<void>): Promise<number> {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

async function benchApiKeyAuth(): Promise<void> {
  const KEYS = 50_000;
  const LOOKUPS = 20_000;
  console.log(`\nAPI key authentication — ${KEYS.toLocaleString("en-US")} stored keys`);

  const manager = new AuthenticationManager(config);
  const admin = manager.getUserByUsername("admin")!;

  // Replica of the previous storage for the "before" scan: keyHash -> {keyHash, isActive}
  const replica = new Map<string, { keyHash: string; isActive: boolean }>();
  let lateKey = "";
  for (let i = 0; i < KEYS; i++) {
    const created = await manager.createApiKey(admin.id, { name: `key-${i}` });
    if (!created.success || !created.apiKey) throw new Error("key creation failed");
    const keyHash = crypto.createHash("sha256").update(created.apiKey).digest("hex");
    replica.set(keyHash, { keyHash, isActive: true });
    if (i === KEYS - 1) lateKey = created.apiKey;
  }
  const lateHash = crypto.createHash("sha256").update(lateKey).digest("hex");

  // BEFORE: linear scan over apiKeys.values() (frozen-ref auth-methods.ts)
  const beforeMs = timeSync(() => {
    for (let i = 0; i < LOOKUPS; i++) {
      let found: { keyHash: string } | undefined;
      for (const storedKey of replica.values()) {
        if (storedKey.keyHash === lateHash && storedKey.isActive) {
          found = storedKey;
          break;
        }
      }
      if (!found) throw new Error("scan miss");
    }
  });
  const before = report("before: O(n) scan per authentication", LOOKUPS, beforeMs);

  // AFTER: real authenticateApiKey() end-to-end (hash + Map.get + checks)
  const afterMs = await timeAsync(async () => {
    for (let i = 0; i < LOOKUPS; i++) {
      const result = await manager.authenticateApiKey(lateKey);
      if (!result.success) throw new Error("auth failed");
    }
  });
  const after = report("after:  authenticateApiKey (O(1) Map.get)", LOOKUPS, afterMs);
  console.log(`  speedup: ${(after / before).toFixed(1)}x`);
}

function benchUsernameLookup(): void {
  const USERS = 100_000;
  console.log(`\nUsername lookup — ${USERS.toLocaleString("en-US")} registered users`);

  // Identical data for both strategies (bcrypt cost is constant either way,
  // so only the lookup that changed is measured).
  const users = new Map<string, User>();
  const usersByUsername = new Map<string, string>();
  for (let i = 0; i < USERS; i++) {
    const user: User = {
      id: `id-${i}`,
      username: `user-${i}`,
      email: `user-${i}@example.com`,
      passwordHash: "$2b$04$fixedhashfixedhashfixedhashfixedhashfixedhashfixedha",
      roles: [Role.USER],
      createdAt: new Date(),
    };
    users.set(user.id, user);
    usersByUsername.set(user.username, user.id);
  }
  const target = `user-${USERS - 1}`; // worst case for the scan

  const BEFORE_ITERS = 2_000;
  const beforeMs = timeSync(() => {
    for (let i = 0; i < BEFORE_ITERS; i++) {
      const user = Array.from(users.values()).find((u) => u.username === target);
      if (!user) throw new Error("miss");
    }
  });
  const before = report("before: Array.from(users).find per login", BEFORE_ITERS, beforeMs);

  const AFTER_ITERS = 2_000_000;
  const afterMs = timeSync(() => {
    for (let i = 0; i < AFTER_ITERS; i++) {
      const id = usersByUsername.get(target);
      const user = id ? users.get(id) : undefined;
      if (!user) throw new Error("miss");
    }
  });
  const after = report("after:  username index (two Map.get)", AFTER_ITERS, afterMs);
  console.log(`  speedup: ${(after / before).toFixed(0)}x`);
}

function benchRbac(): void {
  const ITERS = 2_000_000;
  console.log(`\nRBAC permission check — worst case (miss on every role)`);

  const rbac = new RoleBasedAccessControl();
  const guest: User = {
    id: "bench-guest",
    username: "bench-guest",
    email: "bench@example.com",
    passwordHash: "",
    roles: [Role.GUEST],
    createdAt: new Date(),
  };

  // BEFORE: array-includes strategy over the same permission arrays
  const arrays = new Map<Role, Permission[]>();
  for (const role of rbac.getAllRoles()) {
    arrays.set(role, rbac.getRolePermissions(role));
  }
  const beforeMs = timeSync(() => {
    for (let i = 0; i < ITERS; i++) {
      const allowed = guest.roles.some(
        (role) => arrays.get(role)?.includes(Permission.ADMIN_ACCESS) ?? false
      );
      if (allowed) throw new Error("unexpected grant");
    }
  });
  const before = report("before: Array.includes per role", ITERS, beforeMs);

  const afterMs = timeSync(() => {
    for (let i = 0; i < ITERS; i++) {
      if (rbac.hasPermission(guest, Permission.ADMIN_ACCESS)) throw new Error("unexpected grant");
    }
  });
  const after = report("after:  Set.has per role", ITERS, afterMs);
  console.log(`  speedup: ${(after / before).toFixed(1)}x`);
}

async function main(): Promise<void> {
  console.log("security uplift benchmarks — node", process.version);
  await benchApiKeyAuth();
  benchUsernameLookup();
  benchRbac();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
