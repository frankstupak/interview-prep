// rbac.ts - Role-Based Access Control
import { Role, User, AuthContext } from "./auth-types";

/** Result when access is allowed */
export interface AuthCheckAllowed {
  allowed: true;
}

/** Result when access is denied; error message is required */
export interface AuthCheckDenied {
  allowed: false;
  error: string;
}

/** Discriminated union for type-safe auth check results */
export type AuthCheckResult = AuthCheckAllowed | AuthCheckDenied;

export enum Permission {
  // User management
  CREATE_USER = "create_user",
  READ_USER = "read_user",
  UPDATE_USER = "update_user",
  DELETE_USER = "delete_user",

  // Content management
  CREATE_CONTENT = "create_content",
  READ_CONTENT = "read_content",
  UPDATE_CONTENT = "update_content",
  DELETE_CONTENT = "delete_content",

  // System administration
  ADMIN_ACCESS = "admin_access",
  VIEW_LOGS = "view_logs",
  MANAGE_ROLES = "manage_roles",

  // API access
  API_READ = "api_read",
  API_WRITE = "api_write",
  API_DELETE = "api_delete",
}

export interface RolePermissions {
  role: Role;
  permissions: Permission[];
}

export class RoleBasedAccessControl {
  private rolePermissions: Map<Role, Permission[]> = new Map();
  // Set-based index kept in sync with rolePermissions. Permission checks run
  // on EVERY authorized request, and Array.includes made each check
  // O(roles x permissions); Set.has makes it O(roles).
  private rolePermissionSets: Map<Role, Set<Permission>> = new Map();

  constructor() {
    this.initializeDefaultPermissions();
    this.rebuildPermissionSets();
  }

  private rebuildPermissionSets(): void {
    this.rolePermissionSets.clear();
    for (const [role, permissions] of this.rolePermissions.entries()) {
      this.rolePermissionSets.set(role, new Set(permissions));
    }
  }

  private initializeDefaultPermissions(): void {
    // Admin has all permissions
    this.rolePermissions.set(Role.ADMIN, [
      Permission.CREATE_USER,
      Permission.READ_USER,
      Permission.UPDATE_USER,
      Permission.DELETE_USER,
      Permission.CREATE_CONTENT,
      Permission.READ_CONTENT,
      Permission.UPDATE_CONTENT,
      Permission.DELETE_CONTENT,
      Permission.ADMIN_ACCESS,
      Permission.VIEW_LOGS,
      Permission.MANAGE_ROLES,
      Permission.API_READ,
      Permission.API_WRITE,
      Permission.API_DELETE,
    ]);

    // User has standard permissions
    this.rolePermissions.set(Role.USER, [
      Permission.READ_USER,
      Permission.UPDATE_USER, // Can update own profile
      Permission.CREATE_CONTENT,
      Permission.READ_CONTENT,
      Permission.UPDATE_CONTENT, // Can update own content
      Permission.API_READ,
      Permission.API_WRITE,
    ]);

    // Guest has minimal permissions
    this.rolePermissions.set(Role.GUEST, [Permission.READ_CONTENT, Permission.API_READ]);
  }

  /**
   * Check if a user has a specific permission
   */
  hasPermission(user: User, permission: Permission): boolean {
    return user.roles.some((role) => this.rolePermissionSets.get(role)?.has(permission) ?? false);
  }

  /**
   * Check if a user has any of the specified permissions
   */
  hasAnyPermission(user: User, permissions: Permission[]): boolean {
    return permissions.some((permission) => this.hasPermission(user, permission));
  }

  /**
   * Check if a user has all of the specified permissions
   */
  hasAllPermissions(user: User, permissions: Permission[]): boolean {
    return permissions.every((permission) => this.hasPermission(user, permission));
  }

  /**
   * Get all permissions for a user
   */
  getUserPermissions(user: User): Permission[] {
    const allPermissions = new Set<Permission>();

    user.roles.forEach((role) => {
      const permissions = this.rolePermissions.get(role);
      if (permissions) {
        permissions.forEach((permission) => allPermissions.add(permission));
      }
    });

    return Array.from(allPermissions);
  }

  /**
   * Get permissions for a specific role
   */
  getRolePermissions(role: Role): Permission[] {
    // Return a copy: the old code handed out the live internal array, so any
    // caller could mutate a role's permissions without going through
    // add/removePermissionFromRole (and without the Set index noticing).
    return [...(this.rolePermissions.get(role) || [])];
  }

  /**
   * Add permission to a role
   */
  addPermissionToRole(role: Role, permission: Permission): void {
    const permissions = this.rolePermissions.get(role) || [];
    if (!permissions.includes(permission)) {
      permissions.push(permission);
      this.rolePermissions.set(role, permissions);
      const set = this.rolePermissionSets.get(role) ?? new Set<Permission>();
      set.add(permission);
      this.rolePermissionSets.set(role, set);
    }
  }

  /**
   * Remove permission from a role
   */
  removePermissionFromRole(role: Role, permission: Permission): void {
    const permissions = this.rolePermissions.get(role) || [];
    const index = permissions.indexOf(permission);
    if (index > -1) {
      permissions.splice(index, 1);
      this.rolePermissions.set(role, permissions);
      this.rolePermissionSets.get(role)?.delete(permission);
    }
  }

  /**
   * Check if user can access a resource based on ownership
   */
  canAccessResource(user: User, resourceOwnerId: string, permission: Permission): boolean {
    // Admin can access everything
    if (this.hasPermission(user, Permission.ADMIN_ACCESS)) {
      return true;
    }

    // Check if user has the permission
    if (!this.hasPermission(user, permission)) {
      return false;
    }

    // For update/delete operations, check ownership
    if (
      permission === Permission.UPDATE_CONTENT ||
      permission === Permission.DELETE_CONTENT ||
      permission === Permission.UPDATE_USER ||
      permission === Permission.DELETE_USER
    ) {
      return user.id === resourceOwnerId;
    }

    return true;
  }

  /**
   * Create middleware function for permission checking
   */
  requirePermission(permission: Permission) {
    return (authContext: AuthContext): AuthCheckResult => {
      if (!this.hasPermission(authContext.user, permission)) {
        return {
          allowed: false,
          error: `Insufficient permissions. Required: ${permission}`,
        };
      }
      return { allowed: true };
    };
  }

  /**
   * Create middleware function for role checking
   */
  requireRole(role: Role) {
    return (authContext: AuthContext): AuthCheckResult => {
      if (!authContext.user.roles.includes(role)) {
        return {
          allowed: false,
          error: `Insufficient role. Required: ${role}`,
        };
      }
      return { allowed: true };
    };
  }

  /**
   * Create middleware function for multiple permission checking
   */
  requireAnyPermission(permissions: Permission[]) {
    return (authContext: AuthContext): AuthCheckResult => {
      if (!this.hasAnyPermission(authContext.user, permissions)) {
        return {
          allowed: false,
          error: `Insufficient permissions. Required any of: ${permissions.join(", ")}`,
        };
      }
      return { allowed: true };
    };
  }

  /**
   * Create middleware function for multiple permission checking (all required)
   */
  requireAllPermissions(permissions: Permission[]) {
    return (authContext: AuthContext): AuthCheckResult => {
      if (!this.hasAllPermissions(authContext.user, permissions)) {
        return {
          allowed: false,
          error: `Insufficient permissions. Required all of: ${permissions.join(", ")}`,
        };
      }
      return { allowed: true };
    };
  }

  /**
   * Get all roles
   */
  getAllRoles(): Role[] {
    return Object.values(Role);
  }

  /**
   * Get all permissions
   */
  getAllPermissions(): Permission[] {
    return Object.values(Permission);
  }

  /**
   * Get role hierarchy (for future extension)
   */
  getRoleHierarchy(): Map<Role, Role[]> {
    // Simple hierarchy: Admin > User > Guest
    const hierarchy = new Map<Role, Role[]>();
    hierarchy.set(Role.ADMIN, [Role.USER, Role.GUEST]);
    hierarchy.set(Role.USER, [Role.GUEST]);
    hierarchy.set(Role.GUEST, []);
    return hierarchy;
  }

  /**
   * Check if role A inherits from role B
   */
  roleInheritsFrom(roleA: Role, roleB: Role): boolean {
    const hierarchy = this.getRoleHierarchy();
    const inheritedRoles = hierarchy.get(roleA) || [];
    return inheritedRoles.includes(roleB);
  }
}
