/**
 * In-memory mock user repository for demonstration and testing.
 *
 * Implements the full Repository<User> contract that CrudService relies on:
 * - findMany honors filters (eq/ne/gt/gte/lt/lte/in/nin/like/regex/exists,
 *   with dot-path field access), search (case-insensitive substring over
 *   the requested fields), multi-key stable sorting, and real offset
 *   pagination with accurate hasNext/hasPrev/total metadata.
 * - update enforces optimistic locking: when a version is supplied and does
 *   not match the stored entity, a VersionConflictError is thrown; every
 *   successful update increments the entity version.
 * - count honors filters (so soft-delete exclusion works for counts too).
 * - email/username equality lookups are served from secondary hash indexes
 *   (O(1)) instead of scanning every user (O(n)).
 */

import { User } from "../types/entities";
import type { AdvancedQuery, PaginatedResponse, QueryFilter, SortOption } from "../types/common";
import type { Repository } from "../services/crud-service";

/** Thrown when an optimistic-lock version check fails. Message intentionally
 *  contains "version" so CrudService's conflict mapping catches it. */
export class VersionConflictError extends Error {
  constructor(entityId: string, expected: number | undefined, actual: number | undefined) {
    super(
      `version conflict on entity ${entityId}: expected version ${expected}, current version ${actual}`
    );
    this.name = "VersionConflictError";
  }
}

/** Resolve a dot-separated path ("profile.phoneNumber") against an object. */
function getPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const segment of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** Normalize Dates to epoch ms so gt/gte/lt/lte and eq compare correctly. */
function normalize(value: unknown): unknown {
  return value instanceof Date ? value.getTime() : value;
}

function compareOrdered(a: unknown, b: unknown): number | null {
  const na = normalize(a);
  const nb = normalize(b);
  if (typeof na === "number" && typeof nb === "number") return na - nb;
  if (typeof na === "string" && typeof nb === "string") return na.localeCompare(nb);
  if (typeof na === "boolean" && typeof nb === "boolean") return Number(na) - Number(nb);
  return null; // incomparable
}

/** Evaluate one QueryFilter against an entity. Unknown operators never match. */
export function matchesFilter(entity: unknown, filter: QueryFilter): boolean {
  const fieldValue = getPath(entity, filter.field);
  const { operator, value } = filter;

  switch (operator) {
    case "eq":
      return normalize(fieldValue) === normalize(value);
    case "ne":
      return normalize(fieldValue) !== normalize(value);
    case "gt": {
      const cmp = compareOrdered(fieldValue, value);
      return cmp !== null && cmp > 0;
    }
    case "gte": {
      const cmp = compareOrdered(fieldValue, value);
      return cmp !== null && cmp >= 0;
    }
    case "lt": {
      const cmp = compareOrdered(fieldValue, value);
      return cmp !== null && cmp < 0;
    }
    case "lte": {
      const cmp = compareOrdered(fieldValue, value);
      return cmp !== null && cmp <= 0;
    }
    case "in":
      return Array.isArray(value) && value.some((v) => normalize(v) === normalize(fieldValue));
    case "nin":
      return Array.isArray(value) && !value.some((v) => normalize(v) === normalize(fieldValue));
    case "like":
      return (
        typeof fieldValue === "string" &&
        typeof value === "string" &&
        fieldValue.toLowerCase().includes(value.toLowerCase())
      );
    case "regex": {
      if (typeof fieldValue !== "string" || typeof value !== "string") return false;
      try {
        return new RegExp(value).test(fieldValue);
      } catch {
        return false; // invalid pattern never matches
      }
    }
    case "exists": {
      const present = fieldValue !== undefined && fieldValue !== null;
      return value === false ? !present : present;
    }
    default:
      return false;
  }
}

/** Case-insensitive substring search of q over the listed fields. */
function matchesSearch(entity: unknown, q: string, fields: string[]): boolean {
  const needle = q.toLowerCase();
  return fields.some((field) => {
    const v = getPath(entity, field);
    return typeof v === "string" && v.toLowerCase().includes(needle);
  });
}

/** Stable multi-key sort (Array.prototype.sort is spec-stable since ES2019). */
function applySort<T>(rows: T[], sortKeys: SortOption[]): T[] {
  if (sortKeys.length === 0) return rows;
  return [...rows].sort((a, b) => {
    for (const { field, order } of sortKeys) {
      const cmp = compareOrdered(getPath(a, field), getPath(b, field));
      if (cmp !== null && cmp !== 0) return order === "desc" ? -cmp : cmp;
    }
    return 0;
  });
}

export class MockUserRepository implements Repository<User> {
  private users = new Map<string, User>();
  private emailIndex = new Map<string, Set<string>>();
  private usernameIndex = new Map<string, Set<string>>();
  private nextId = 1;

  private indexAdd(index: Map<string, Set<string>>, key: string | undefined, id: string): void {
    if (typeof key !== "string") return;
    const bucket = index.get(key);
    if (bucket) bucket.add(id);
    else index.set(key, new Set([id]));
  }

  private indexRemove(index: Map<string, Set<string>>, key: string | undefined, id: string): void {
    if (typeof key !== "string") return;
    const bucket = index.get(key);
    if (!bucket) return;
    bucket.delete(id);
    if (bucket.size === 0) index.delete(key);
  }

  /** Use email/username eq filters to shrink the candidate set from O(n) to O(1). */
  private candidatesFor(filters: QueryFilter[]): User[] {
    for (const f of filters) {
      if (f.operator !== "eq" || typeof f.value !== "string") continue;
      const index =
        f.field === "email" ? this.emailIndex : f.field === "username" ? this.usernameIndex : null;
      if (!index) continue;
      const ids = index.get(f.value);
      if (!ids) return [];
      const rows: User[] = [];
      for (const id of ids) {
        const u = this.users.get(id);
        if (u) rows.push(u);
      }
      return rows;
    }
    return Array.from(this.users.values());
  }

  async findById(id: string): Promise<User | null> {
    return this.users.get(id) || null;
  }

  async findMany(query: AdvancedQuery): Promise<PaginatedResponse<User>> {
    const filters = query.filters ?? [];

    // 1. Filter (AND semantics), starting from an index-narrowed candidate set.
    let rows = this.candidatesFor(filters).filter((user) =>
      filters.every((filter) => matchesFilter(user, filter))
    );

    // 2. Search
    const q = query.search?.q;
    if (q) {
      const fields =
        query.search?.fields && query.search.fields.length > 0
          ? query.search.fields
          : ["username", "email", "firstName", "lastName"];
      rows = rows.filter((user) => matchesSearch(user, q, fields));
    }

    // 3. Sort — explicit sort array wins; else pagination.sortBy/sortOrder.
    const sortKeys: SortOption[] =
      query.sort && query.sort.length > 0
        ? query.sort
        : query.pagination?.sortBy
          ? [{ field: query.pagination.sortBy, order: query.pagination.sortOrder ?? "asc" }]
          : [];
    rows = applySort(rows, sortKeys);

    // 4. Paginate with truthful metadata.
    const total = rows.length;
    const limit = Math.max(1, query.pagination?.limit ?? 10);
    const page = Math.max(1, query.pagination?.page ?? 1);
    const totalPages = Math.max(1, Math.ceil(total / limit));
    const start = (page - 1) * limit;

    return {
      data: rows.slice(start, start + limit),
      meta: {
        page,
        limit,
        total,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1 && total > 0,
      },
    };
  }

  async create(entity: Omit<User, "id" | "createdAt" | "updatedAt">): Promise<User> {
    const user: User = {
      ...entity,
      id: `user-${this.nextId++}`,
      createdAt: new Date(),
      updatedAt: new Date(),
      version: 1,
    };
    this.users.set(user.id, user);
    this.indexAdd(this.emailIndex, user.email, user.id);
    this.indexAdd(this.usernameIndex, user.username, user.id);
    return user;
  }

  async update(id: string, updates: Partial<User>, version?: number): Promise<User> {
    const user = this.users.get(id);
    if (!user) throw new Error("User not found");

    // Optimistic locking: reject stale writers.
    if (version !== undefined && user.version !== undefined && version !== user.version) {
      throw new VersionConflictError(id, version, user.version);
    }

    const updatedUser: User = {
      ...user,
      ...updates,
      id: user.id, // system fields are never overwritten by updates
      createdAt: user.createdAt,
      updatedAt: new Date(),
      version: (user.version ?? 0) + 1,
    };

    if (updates.email !== undefined && updates.email !== user.email) {
      this.indexRemove(this.emailIndex, user.email, id);
      this.indexAdd(this.emailIndex, updatedUser.email, id);
    }
    if (updates.username !== undefined && updates.username !== user.username) {
      this.indexRemove(this.usernameIndex, user.username, id);
      this.indexAdd(this.usernameIndex, updatedUser.username, id);
    }

    this.users.set(id, updatedUser);
    return updatedUser;
  }

  async delete(id: string): Promise<boolean> {
    const user = this.users.get(id);
    if (!user) return false;
    this.indexRemove(this.emailIndex, user.email, id);
    this.indexRemove(this.usernameIndex, user.username, id);
    return this.users.delete(id);
  }

  async bulkCreate(entities: Omit<User, "id" | "createdAt" | "updatedAt">[]): Promise<User[]> {
    return Promise.all(entities.map((entity) => this.create(entity)));
  }

  async bulkUpdate(
    updates: Array<{ id: string; data: Partial<User>; version?: number }>
  ): Promise<User[]> {
    return Promise.all(updates.map((u) => this.update(u.id, u.data, u.version)));
  }

  async bulkDelete(ids: string[]): Promise<number> {
    let deleted = 0;
    for (const id of ids) {
      if (await this.delete(id)) deleted++;
    }
    return deleted;
  }

  async count(filters?: QueryFilter[]): Promise<number> {
    const active = filters ?? [];
    if (active.length === 0) return this.users.size;
    return this.candidatesFor(active).filter((user) =>
      active.every((filter) => matchesFilter(user, filter))
    ).length;
  }
}
