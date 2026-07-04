/**
 * User Controller - Comprehensive CRUD operations for User management
 *
 * This controller demonstrates advanced API patterns including:
 * - Full CRUD operations with validation
 * - Advanced querying and filtering
 * - File upload handling (profile pictures)
 * - Authentication and authorization
 * - Rate limiting and security
 * - Audit logging and activity tracking
 * - Bulk operations and data export
 */

import { FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import { CrudService } from "../services/crud-service";
import { User, UserProfile, UserPreferences } from "../types/entities";
import { PaginationQuery, AdvancedQuery, CreateEntityInput } from "../types/common";
import {
  HttpStatus,
  CrudErrorCode,
  UserErrorCode,
  UserField,
  USER_DEFAULTS,
  UserRole,
  UserRoleList,
  UserStatusList,
  UserRoleType,
  UserStatusType,
  QueryOperator,
  UserValidation,
  BaseEntityField,
} from "../constants";
import bcrypt from "bcrypt";

// Request/Response interfaces
interface CreateUserRequest {
  username: string;
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  role?: UserRoleType;
}

interface UpdateUserRequest {
  username?: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  role?: UserRoleType;
  status?: UserStatusType;
  profile?: Partial<UserProfile>;
  preferences?: Partial<UserPreferences>;
}

interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

interface UserQuery extends PaginationQuery {
  search?: string;
  role?: UserRoleType;
  status?: UserStatusType;
  createdAfter?: string;
  createdBefore?: string;
}

const idParamsSchema = z.object({
  id: z.string().min(1, "ID is required"),
});

const createUserSchema = z
  .object({
    username: z.string().min(UserValidation.USERNAME_MIN_LENGTH),
    email: z.string().email(),
    password: z.string().min(UserValidation.PASSWORD_MIN_LENGTH),
    firstName: z.string().min(UserValidation.NAME_MIN_LENGTH),
    lastName: z.string().min(UserValidation.NAME_MIN_LENGTH),
    role: z.enum(UserRoleList).optional(),
  })
  .strict();

const updateUserSchema = z
  .object({
    username: z.string().min(UserValidation.USERNAME_MIN_LENGTH).optional(),
    email: z.string().email().optional(),
    firstName: z.string().min(UserValidation.NAME_MIN_LENGTH).optional(),
    lastName: z.string().min(UserValidation.NAME_MIN_LENGTH).optional(),
    role: z.enum(UserRoleList).optional(),
    status: z.enum(UserStatusList).optional(),
    profile: z.custom<Partial<UserProfile>>().optional(),
    preferences: z.custom<Partial<UserPreferences>>().optional(),
  })
  .strict();

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(UserValidation.PASSWORD_MIN_LENGTH),
    confirmPassword: z.string().min(1),
  })
  .strict();

const userQuerySchema = z
  .object({
    page: z.coerce.number().optional(),
    limit: z.coerce.number().optional(),
    sortBy: z.string().optional(),
    sortOrder: z.string().optional(),
    search: z.string().optional(),
    role: z.enum(UserRoleList).optional(),
    status: z.enum(UserStatusList).optional(),
    createdAfter: z.string().optional(),
    createdBefore: z.string().optional(),
  })
  .passthrough();

const bulkOperationSchema = z.object({
  operation: z.enum(["create", "update", "delete"]),
  data: z.array(z.unknown()).min(1),
});

const bulkUpdateItemSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive().optional(),
    username: z.string().min(UserValidation.USERNAME_MIN_LENGTH).optional(),
    email: z.string().email().optional(),
    firstName: z.string().min(UserValidation.NAME_MIN_LENGTH).optional(),
    lastName: z.string().min(UserValidation.NAME_MIN_LENGTH).optional(),
    role: z.enum(UserRoleList).optional(),
    status: z.enum(UserStatusList).optional(),
  })
  .strict();

const defaultUserPreferences: UserPreferences = {
  notifications: {
    email: USER_DEFAULTS.PREFERENCES.NOTIFICATIONS.EMAIL,
    push: USER_DEFAULTS.PREFERENCES.NOTIFICATIONS.PUSH,
    sms: USER_DEFAULTS.PREFERENCES.NOTIFICATIONS.SMS,
  },
  privacy: {
    profileVisible: USER_DEFAULTS.PREFERENCES.PRIVACY.PROFILE_VISIBLE,
    showEmail: USER_DEFAULTS.PREFERENCES.PRIVACY.SHOW_EMAIL,
    showPhone: USER_DEFAULTS.PREFERENCES.PRIVACY.SHOW_PHONE,
  },
  theme: USER_DEFAULTS.PREFERENCES.THEME,
};

export class UserController {
  private userService: CrudService<User>;

  constructor(userService: CrudService<User>) {
    this.userService = userService;
  }

  /**
   * Create a new user
   * POST /users
   *
   * Why: Demonstrates input validation, password hashing, and audit logging
   * When: Use for user registration and admin user creation
   */
  async createUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const parsedBody = createUserSchema.safeParse(request.body);
      if (!parsedBody.success) {
        this.sendValidationError(reply, parsedBody.error);
        return;
      }
      const body: CreateUserRequest = parsedBody.data;
      const userId = request.requestContext?.userId;

      console.warn(`Creating new user: ${body.email}`);

      // Validate required fields
      const validationErrors = this.validateCreateUserRequest(body);
      if (validationErrors.length > 0) {
        reply.code(HttpStatus.BAD_REQUEST).send({
          success: false,
          error: {
            code: CrudErrorCode.VALIDATION_ERROR,
            message: "Validation failed",
            details: validationErrors,
            statusCode: HttpStatus.BAD_REQUEST,
          },
        });
        return;
      }

      // Check if user already exists. Email OR username taken must conflict —
      // a single filters array is AND semantics, so run one targeted (indexed)
      // query per unique field.
      const isTaken = await this.isEmailOrUsernameTaken(
        body.email.toLowerCase(),
        body.username,
        undefined,
        userId
      );
      if (isTaken) {
        reply.code(HttpStatus.CONFLICT).send({
          success: false,
          error: {
            code: UserErrorCode.USER_EXISTS,
            message: "User with this email or username already exists",
            statusCode: HttpStatus.CONFLICT,
          },
        });
        return;
      }

      // Hash password
      const passwordHash = await bcrypt.hash(body.password, 12);

      // Create user data
      const userData: CreateEntityInput<User> = {
        username: body.username,
        email: body.email.toLowerCase(),
        passwordHash,
        firstName: body.firstName,
        lastName: body.lastName,
        role: body.role || USER_DEFAULTS.ROLE,
        status: USER_DEFAULTS.STATUS, // Require email verification
        twoFactorEnabled: USER_DEFAULTS.TWO_FACTOR_ENABLED,
        profile: {
          timezone: USER_DEFAULTS.PROFILE.TIMEZONE,
          language: USER_DEFAULTS.PROFILE.LANGUAGE,
        },
        preferences: {
          notifications: {
            email: USER_DEFAULTS.PREFERENCES.NOTIFICATIONS.EMAIL,
            push: USER_DEFAULTS.PREFERENCES.NOTIFICATIONS.PUSH,
            sms: USER_DEFAULTS.PREFERENCES.NOTIFICATIONS.SMS,
          },
          privacy: {
            profileVisible: USER_DEFAULTS.PREFERENCES.PRIVACY.PROFILE_VISIBLE,
            showEmail: USER_DEFAULTS.PREFERENCES.PRIVACY.SHOW_EMAIL,
            showPhone: USER_DEFAULTS.PREFERENCES.PRIVACY.SHOW_PHONE,
          },
          theme: USER_DEFAULTS.PREFERENCES.THEME,
        },
      };

      const result = await this.userService.create(userData, userId);

      if (result.success) {
        // Remove password hash from response
        const { passwordHash: _pw, ...userResponse } = result.data!;
        void _pw;

        reply.code(HttpStatus.CREATED).send({
          success: true,
          data: userResponse,
          meta: {
            timestamp: new Date().toISOString(),
            requestId: request.requestContext?.requestId,
          },
        });

        console.warn(`User created successfully: ${result.data!.id}`);
      } else {
        reply.code(result.error!.statusCode).send(result);
      }
    } catch (error) {
      console.error("❌ Failed to create user:", error);
      this.sendInternalError(reply, UserErrorCode.CREATE_USER_FAILED, "Failed to create user");
    }
  }

  /**
   * Get user by ID
   * GET /users/:id
   *
   * Why: Demonstrates parameter validation and data filtering
   * When: Use for user profile views and admin user management
   */
  async getUserById(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const parsedParams = idParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        this.sendValidationError(reply, parsedParams.error);
        return;
      }
      const { id } = parsedParams.data;
      const userId = request.requestContext?.userId;
      const contextRole = this.getContextRole(request);

      console.warn(`Fetching user: ${id}`);

      const result = await this.userService.getById(id, userId);

      if (result.success) {
        // Remove sensitive data based on permissions
        const userResponse = this.filterUserData(result.data!, contextRole, userId === id);

        reply.send({
          success: true,
          data: userResponse,
          meta: {
            timestamp: new Date().toISOString(),
            requestId: request.requestContext?.requestId,
          },
        });
      } else {
        reply.code(result.error!.statusCode).send(result);
      }
    } catch (error) {
      console.error("❌ Failed to fetch user:", error);
      this.sendInternalError(reply, UserErrorCode.FETCH_USER_FAILED, "Failed to fetch user");
    }
  }

  /**
   * Get users with advanced filtering
   * GET /users?search=john&role=admin&page=1&limit=10
   *
   * Why: Demonstrates advanced querying, pagination, and search functionality
   * When: Use for user lists, admin panels, and search interfaces
   */
  async getUsers(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const parsedQuery = userQuerySchema.safeParse(request.query);
      if (!parsedQuery.success) {
        this.sendValidationError(reply, parsedQuery.error);
        return;
      }
      const query = parsedQuery.data;
      const normalizedQuery: UserQuery = {
        ...query,
        sortOrder:
          query.sortOrder === "asc" || query.sortOrder === "desc" ? query.sortOrder : undefined,
      };
      const userId = request.requestContext?.userId;
      const contextRole = this.getContextRole(request);

      console.warn(`Fetching users with query:`, query);

      // Build advanced query from request parameters
      const advancedQuery: AdvancedQuery = {
        pagination: {
          page: normalizedQuery.page || 1,
          limit: Math.min(normalizedQuery.limit || 10, 100), // Cap at 100
          sortBy: normalizedQuery.sortBy || "createdAt",
          sortOrder: normalizedQuery.sortOrder || "desc",
        },
        filters: [],
      };

      // Add search filter
      if (normalizedQuery.search) {
        advancedQuery.search = {
          q: normalizedQuery.search,
          fields: [UserField.FIRST_NAME, UserField.LAST_NAME, UserField.USERNAME, UserField.EMAIL],
        };
      }

      // Add role filter
      if (normalizedQuery.role) {
        advancedQuery.filters!.push({
          field: UserField.ROLE,
          operator: QueryOperator.EQ,
          value: normalizedQuery.role,
        });
      }

      // Add status filter
      if (normalizedQuery.status) {
        advancedQuery.filters!.push({
          field: UserField.STATUS,
          operator: QueryOperator.EQ,
          value: normalizedQuery.status,
        });
      }

      // Add date range filters
      if (normalizedQuery.createdAfter) {
        advancedQuery.filters!.push({
          field: BaseEntityField.CREATED_AT,
          operator: QueryOperator.GTE,
          value: new Date(normalizedQuery.createdAfter),
        });
      }

      if (normalizedQuery.createdBefore) {
        advancedQuery.filters!.push({
          field: BaseEntityField.CREATED_AT,
          operator: QueryOperator.LTE,
          value: new Date(normalizedQuery.createdBefore),
        });
      }

      const result = await this.userService.getMany(advancedQuery, userId);

      if (result.success) {
        // Filter sensitive data from all users
        const filteredUsers = result.data!.data.map((user) =>
          this.filterUserData(user, contextRole, false)
        );

        reply.send({
          success: true,
          data: {
            ...result.data!,
            data: filteredUsers,
          },
          meta: {
            timestamp: new Date().toISOString(),
            requestId: request.requestContext?.requestId,
          },
        });

        console.warn(`Found ${filteredUsers.length} users`);
      } else {
        reply.code(result.error!.statusCode).send(result);
      }
    } catch (error) {
      console.error("❌ Failed to fetch users:", error);
      this.sendInternalError(reply, UserErrorCode.FETCH_USERS_FAILED, "Failed to fetch users");
    }
  }

  /**
   * Update user
   * PUT /users/:id
   *
   * Why: Demonstrates partial updates, validation, and authorization
   * When: Use for profile updates and admin user management
   */
  async updateUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const parsedParams = idParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        this.sendValidationError(reply, parsedParams.error);
        return;
      }
      const parsedBody = updateUserSchema.safeParse(request.body);
      if (!parsedBody.success) {
        this.sendValidationError(reply, parsedBody.error);
        return;
      }
      const { id } = parsedParams.data;
      const body: UpdateUserRequest = parsedBody.data;
      const userId = request.requestContext?.userId;
      const userRole = this.getContextRole(request);

      console.warn(`Updating user: ${id}`);

      // Check permissions - users can only update themselves unless admin
      if (userId !== id && userRole !== UserRole.ADMIN) {
        reply.code(HttpStatus.FORBIDDEN).send({
          success: false,
          error: {
            code: UserErrorCode.INSUFFICIENT_PERMISSIONS,
            message: "You can only update your own profile",
            statusCode: HttpStatus.FORBIDDEN,
          },
        });
        return;
      }

      // Validate update data
      const validationErrors = this.validateUpdateUserRequest(body);
      if (validationErrors.length > 0) {
        reply.code(HttpStatus.BAD_REQUEST).send({
          success: false,
          error: {
            code: CrudErrorCode.VALIDATION_ERROR,
            message: "Validation failed",
            details: validationErrors,
            statusCode: HttpStatus.BAD_REQUEST,
          },
        });
        return;
      }

      // Check if email/username is already taken (if being updated).
      // Filters are AND semantics: email-conflict and username-conflict must
      // be checked independently, each excluding the user being updated.
      if (body.email || body.username) {
        const conflict = await this.isEmailOrUsernameTaken(
          body.email?.toLowerCase(),
          body.username,
          id,
          userId
        );
        if (conflict) {
          reply.code(HttpStatus.CONFLICT).send({
            success: false,
            error: {
              code: UserErrorCode.USER_EXISTS,
              message: "Email or username already taken",
              statusCode: HttpStatus.CONFLICT,
            },
          });
          return;
        }
      }

      // Prepare update data
      const updateData: Partial<User> = {};

      if (body.username) updateData.username = body.username;
      if (body.email) updateData.email = body.email.toLowerCase();
      if (body.firstName) updateData.firstName = body.firstName;
      if (body.lastName) updateData.lastName = body.lastName;

      // Only admins can change role and status
      if (userRole === UserRole.ADMIN) {
        if (body.role) updateData.role = body.role;
        if (body.status) updateData.status = body.status;
      }

      // Partial profile/preferences updates merge against the user's CURRENT
      // nested objects (not defaults, not wholesale replacement) — otherwise a
      // partial update silently wipes sibling fields (e.g. sending only
      // { notifications } used to reset a user's chosen theme back to default).
      if (body.profile || body.preferences) {
        const currentResult = await this.userService.getById(id, userId);
        if (!currentResult.success) {
          reply.code(currentResult.error!.statusCode).send(currentResult);
          return;
        }
        const current = currentResult.data!;

        if (body.profile) {
          updateData.profile = { ...current.profile, ...body.profile };
        }
        if (body.preferences) {
          const base = current.preferences ?? defaultUserPreferences;
          updateData.preferences = {
            ...base,
            ...body.preferences,
            notifications: {
              ...base.notifications,
              ...body.preferences.notifications,
            },
            privacy: {
              ...base.privacy,
              ...body.preferences.privacy,
            },
          };
        }
      }

      const result = await this.userService.update(id, updateData, userId);

      if (result.success) {
        const userResponse = this.filterUserData(result.data!, userRole, userId === id);

        reply.send({
          success: true,
          data: userResponse,
          meta: {
            timestamp: new Date().toISOString(),
            requestId: request.requestContext?.requestId,
          },
        });

        console.warn(`User updated successfully: ${id}`);
      } else {
        reply.code(result.error!.statusCode).send(result);
      }
    } catch (error) {
      console.error("❌ Failed to update user:", error);
      this.sendInternalError(reply, UserErrorCode.UPDATE_USER_FAILED, "Failed to update user");
    }
  }

  /**
   * Delete user (soft delete)
   * DELETE /users/:id
   *
   * Why: Demonstrates soft delete and authorization
   * When: Use for user account deactivation and admin user management
   */
  async deleteUser(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const parsedParams = idParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        this.sendValidationError(reply, parsedParams.error);
        return;
      }
      const { id } = parsedParams.data;
      const userId = request.requestContext?.userId;
      const userRole = this.getContextRole(request);

      console.warn(`Deleting user: ${id}`);

      // Only admins can delete users, or users can delete themselves
      if (userId !== id && userRole !== UserRole.ADMIN) {
        reply.code(HttpStatus.FORBIDDEN).send({
          success: false,
          error: {
            code: UserErrorCode.INSUFFICIENT_PERMISSIONS,
            message: "Insufficient permissions to delete user",
            statusCode: HttpStatus.FORBIDDEN,
          },
        });
        return;
      }

      const result = await this.userService.delete(id, userId);

      if (result.success) {
        reply.code(HttpStatus.NO_CONTENT).send();
        console.warn(`User deleted successfully: ${id}`);
      } else {
        reply.code(result.error!.statusCode).send(result);
      }
    } catch (error) {
      console.error("❌ Failed to delete user:", error);
      this.sendInternalError(reply, UserErrorCode.DELETE_USER_FAILED, "Failed to delete user");
    }
  }

  /**
   * Change user password
   * POST /users/:id/change-password
   *
   * Why: Demonstrates secure password handling and validation
   * When: Use for password changes with current password verification
   */
  async changePassword(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const parsedParams = idParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        this.sendValidationError(reply, parsedParams.error);
        return;
      }
      const parsedBody = changePasswordSchema.safeParse(request.body);
      if (!parsedBody.success) {
        this.sendValidationError(reply, parsedBody.error);
        return;
      }
      const { id } = parsedParams.data;
      const body: ChangePasswordRequest = parsedBody.data;
      const userId = request.requestContext?.userId;

      console.warn(`Changing password for user: ${id}`);

      // Users can only change their own password
      if (userId !== id) {
        reply.code(HttpStatus.FORBIDDEN).send({
          success: false,
          error: {
            code: UserErrorCode.INSUFFICIENT_PERMISSIONS,
            message: "You can only change your own password",
            statusCode: HttpStatus.FORBIDDEN,
          },
        });
        return;
      }

      // Validate password change request
      const validationErrors = this.validatePasswordChangeRequest(body);
      if (validationErrors.length > 0) {
        reply.code(HttpStatus.BAD_REQUEST).send({
          success: false,
          error: {
            code: CrudErrorCode.VALIDATION_ERROR,
            message: "Validation failed",
            details: validationErrors,
            statusCode: HttpStatus.BAD_REQUEST,
          },
        });
        return;
      }

      // Get current user to verify password
      const userResult = await this.userService.getById(id, userId);
      if (!userResult.success) {
        reply.code(userResult.error!.statusCode).send(userResult);
        return;
      }

      const user = userResult.data!;

      // Verify current password
      const isCurrentPasswordValid = await bcrypt.compare(body.currentPassword, user.passwordHash);
      if (!isCurrentPasswordValid) {
        reply.code(HttpStatus.BAD_REQUEST).send({
          success: false,
          error: {
            code: UserErrorCode.INVALID_CURRENT_PASSWORD,
            message: "Current password is incorrect",
            statusCode: HttpStatus.BAD_REQUEST,
          },
        });
        return;
      }

      // Hash new password
      const newPasswordHash = await bcrypt.hash(body.newPassword, 12);

      // Update password
      const updateResult = await this.userService.update(
        id,
        {
          passwordHash: newPasswordHash,
        },
        userId
      );

      if (updateResult.success) {
        reply.send({
          success: true,
          message: "Password changed successfully",
          meta: {
            timestamp: new Date().toISOString(),
            requestId: request.requestContext?.requestId,
          },
        });

        console.warn(`Password changed successfully for user: ${id}`);
      } else {
        reply.code(updateResult.error!.statusCode).send(updateResult);
      }
    } catch (error) {
      console.error("❌ Failed to change password:", error);
      this.sendInternalError(
        reply,
        UserErrorCode.CHANGE_PASSWORD_FAILED,
        "Failed to change password"
      );
    }
  }

  /**
   * Upload user profile picture
   * POST /users/:id/avatar
   *
   * Why: Demonstrates file upload handling with validation
   * When: Use for profile picture uploads with size and type validation
   */
  async uploadAvatar(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const parsedParams = idParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        this.sendValidationError(reply, parsedParams.error);
        return;
      }
      const { id } = parsedParams.data;
      const userId = request.requestContext?.userId;

      console.warn(`Uploading avatar for user: ${id}`);

      // Users can only upload their own avatar
      if (userId !== id) {
        reply.code(HttpStatus.FORBIDDEN).send({
          success: false,
          error: {
            code: UserErrorCode.INSUFFICIENT_PERMISSIONS,
            message: "You can only upload your own avatar",
            statusCode: HttpStatus.FORBIDDEN,
          },
        });
        return;
      }

      // Handle multipart file upload
      const data = await request.file();
      if (!data) {
        reply.code(HttpStatus.BAD_REQUEST).send({
          success: false,
          error: {
            code: UserErrorCode.NO_FILE_UPLOADED,
            message: "No file was uploaded",
            statusCode: HttpStatus.BAD_REQUEST,
          },
        });
        return;
      }

      // Validate file type
      const allowedTypes = ["image/jpeg", "image/png", "image/gif", "image/webp"];
      if (!allowedTypes.includes(data.mimetype)) {
        reply.code(HttpStatus.BAD_REQUEST).send({
          success: false,
          error: {
            code: UserErrorCode.INVALID_FILE_TYPE,
            message: "Only JPEG, PNG, GIF, and WebP images are allowed",
            statusCode: HttpStatus.BAD_REQUEST,
          },
        });
        return;
      }

      // Validate file size (5MB max)
      const maxSize = 5 * 1024 * 1024; // 5MB
      const buffer = await data.toBuffer();
      if (buffer.length > maxSize) {
        reply.code(HttpStatus.BAD_REQUEST).send({
          success: false,
          error: {
            code: UserErrorCode.FILE_TOO_LARGE,
            message: "File size must be less than 5MB",
            statusCode: HttpStatus.BAD_REQUEST,
          },
        });
        return;
      }

      // In a real implementation, you would:
      // 1. Save the file to a storage service (AWS S3, etc.)
      // 2. Generate thumbnails
      // 3. Update the user's profile with the new avatar URL

      const avatarUrl = `/uploads/avatars/${id}-${Date.now()}.${data.mimetype.split("/")[1]}`;

      // Merge into the CURRENT profile — replacing the whole profile object
      // used to wipe timezone/language/phoneNumber on every avatar upload.
      const currentResult = await this.userService.getById(id, userId);
      if (!currentResult.success) {
        reply.code(currentResult.error!.statusCode).send(currentResult);
        return;
      }

      // Update user profile with avatar URL
      const updateResult = await this.userService.update(
        id,
        {
          profile: {
            ...currentResult.data!.profile,
            avatar: avatarUrl,
          },
        },
        userId
      );

      if (updateResult.success) {
        reply.send({
          success: true,
          data: {
            avatarUrl,
            message: "Avatar uploaded successfully",
          },
          meta: {
            timestamp: new Date().toISOString(),
            requestId: request.requestContext?.requestId,
          },
        });

        console.warn(`Avatar uploaded successfully for user: ${id}`);
      } else {
        reply.code(updateResult.error!.statusCode).send(updateResult);
      }
    } catch (error) {
      console.error("❌ Failed to upload avatar:", error);
      this.sendInternalError(
        reply,
        UserErrorCode.UPLOAD_AVATAR_FAILED,
        "Failed to upload avatar"
      );
    }
  }

  /**
   * Bulk user operations (create / update / delete)
   * POST /users/bulk  (admin only — enforced by route preHandler)
   *
   * Why: The shipped endpoint replied "Bulk operation completed ... This is a
   * mock implementation" and persisted nothing. This executes the operation.
   * When: Use for admin imports, batch edits, and batch removal
   */
  async bulkOperation(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    try {
      const parsed = bulkOperationSchema.safeParse(request.body);
      if (!parsed.success) {
        this.sendValidationError(reply, parsed.error);
        return;
      }
      const { operation, data } = parsed.data;
      const userId = request.requestContext?.userId;

      if (operation === "create") {
        // Validate every item up-front (schema + uniqueness incl. within batch).
        const items: CreateEntityInput<User>[] = [];
        const seenEmails = new Set<string>();
        const seenUsernames = new Set<string>();

        for (let i = 0; i < data.length; i++) {
          const item = createUserSchema.safeParse(data[i]);
          if (!item.success) {
            reply.code(HttpStatus.BAD_REQUEST).send({
              success: false,
              error: {
                code: CrudErrorCode.VALIDATION_ERROR,
                message: `Validation failed for item ${i}`,
                details: item.error.issues.map((issue) => issue.message),
                statusCode: HttpStatus.BAD_REQUEST,
              },
            });
            return;
          }
          const body = item.data;
          const email = body.email.toLowerCase();
          const taken =
            seenEmails.has(email) ||
            seenUsernames.has(body.username) ||
            (await this.isEmailOrUsernameTaken(email, body.username, undefined, userId));
          if (taken) {
            reply.code(HttpStatus.CONFLICT).send({
              success: false,
              error: {
                code: UserErrorCode.USER_EXISTS,
                message: `Item ${i}: email or username already taken`,
                statusCode: HttpStatus.CONFLICT,
              },
            });
            return;
          }
          seenEmails.add(email);
          seenUsernames.add(body.username);

          const passwordHash = await bcrypt.hash(body.password, 12);
          items.push({
            username: body.username,
            email,
            passwordHash,
            firstName: body.firstName,
            lastName: body.lastName,
            role: body.role || USER_DEFAULTS.ROLE,
            status: USER_DEFAULTS.STATUS,
            twoFactorEnabled: USER_DEFAULTS.TWO_FACTOR_ENABLED,
            profile: {
              timezone: USER_DEFAULTS.PROFILE.TIMEZONE,
              language: USER_DEFAULTS.PROFILE.LANGUAGE,
            },
            preferences: { ...defaultUserPreferences },
          });
        }

        const result = await this.userService.bulkCreate(items, userId);
        if (!result.success) {
          reply.code(result.error!.statusCode).send(result);
          return;
        }
        reply.send({
          success: result.data!.success,
          data: {
            operation,
            processed: result.data!.processed,
            failed: result.data!.failed,
            results: result.data!.results.map((r) =>
              r.success && r.data
                ? { success: true, data: this.filterUserData(r.data, UserRole.ADMIN, false) }
                : { success: r.success, error: r.error }
            ),
          },
          meta: {
            timestamp: new Date().toISOString(),
            requestId: request.requestContext?.requestId,
          },
        });
        return;
      }

      if (operation === "update") {
        const updates: Array<{ id: string; data: Partial<User>; version?: number }> = [];
        for (let i = 0; i < data.length; i++) {
          const item = bulkUpdateItemSchema.safeParse(data[i]);
          if (!item.success) {
            reply.code(HttpStatus.BAD_REQUEST).send({
              success: false,
              error: {
                code: CrudErrorCode.VALIDATION_ERROR,
                message: `Validation failed for item ${i}`,
                details: item.error.issues.map((issue) => issue.message),
                statusCode: HttpStatus.BAD_REQUEST,
              },
            });
            return;
          }
          const { id, version, ...fields } = item.data;
          const updateData: Partial<User> = {};
          if (fields.username) updateData.username = fields.username;
          if (fields.email) updateData.email = fields.email.toLowerCase();
          if (fields.firstName) updateData.firstName = fields.firstName;
          if (fields.lastName) updateData.lastName = fields.lastName;
          if (fields.role) updateData.role = fields.role;
          if (fields.status) updateData.status = fields.status;
          updates.push({ id, data: updateData, version });
        }

        const result = await this.userService.bulkUpdate(updates, userId);
        if (!result.success) {
          reply.code(result.error!.statusCode).send(result);
          return;
        }
        reply.send({
          success: result.data!.success,
          data: {
            operation,
            processed: result.data!.processed,
            failed: result.data!.failed,
            results: result.data!.results.map((r) =>
              r.success && r.data
                ? { success: true, data: this.filterUserData(r.data, UserRole.ADMIN, false) }
                : { success: r.success, error: r.error }
            ),
          },
          meta: {
            timestamp: new Date().toISOString(),
            requestId: request.requestContext?.requestId,
          },
        });
        return;
      }

      // operation === "delete": data must be an array of user id strings
      const ids: string[] = [];
      for (let i = 0; i < data.length; i++) {
        const value = data[i];
        if (typeof value !== "string" || value.length === 0) {
          reply.code(HttpStatus.BAD_REQUEST).send({
            success: false,
            error: {
              code: CrudErrorCode.VALIDATION_ERROR,
              message: `Item ${i} must be a non-empty user id string`,
              statusCode: HttpStatus.BAD_REQUEST,
            },
          });
          return;
        }
        ids.push(value);
      }

      const result = await this.userService.bulkDelete(ids, userId);
      if (!result.success) {
        reply.code(result.error!.statusCode).send(result);
        return;
      }
      reply.send({
        success: result.data!.success,
        data: {
          operation,
          processed: result.data!.processed,
          failed: result.data!.failed,
          results: result.data!.results,
        },
        meta: {
          timestamp: new Date().toISOString(),
          requestId: request.requestContext?.requestId,
        },
      });
    } catch (error) {
      console.error("Failed bulk operation:", error);
      this.sendInternalError(reply, CrudErrorCode.INVALID_INPUT, "Bulk operation failed");
    }
  }

  /**
   * Private helper methods
   */

  /**
   * True if the email or the username is taken by a user OTHER than excludeId.
   * One targeted (index-served) eq query per unique field — OR semantics.
   */
  private async isEmailOrUsernameTaken(
    email?: string,
    username?: string,
    excludeId?: string,
    requesterId?: string
  ): Promise<boolean> {
    const checks: AdvancedQuery[] = [];
    if (email) {
      checks.push({
        filters: [{ field: UserField.EMAIL, operator: QueryOperator.EQ, value: email }],
      });
    }
    if (username) {
      checks.push({
        filters: [{ field: UserField.USERNAME, operator: QueryOperator.EQ, value: username }],
      });
    }

    for (const query of checks) {
      if (excludeId) {
        query.filters!.push({
          field: BaseEntityField.ID,
          operator: QueryOperator.NE,
          value: excludeId,
        });
      }
      const result = await this.userService.getMany(query, requesterId);
      if (result.success && result.data!.data.length > 0) {
        return true;
      }
    }
    return false;
  }

  private validateCreateUserRequest(body: CreateUserRequest): string[] {
    const errors: string[] = [];

    if (!body.username || body.username.length < UserValidation.USERNAME_MIN_LENGTH) {
      errors.push(
        `Username must be at least ${UserValidation.USERNAME_MIN_LENGTH} characters long`
      );
    }

    if (!body.email || !this.isValidEmail(body.email)) {
      errors.push("Valid email address is required");
    }

    if (!body.password || body.password.length < UserValidation.PASSWORD_MIN_LENGTH) {
      errors.push(
        `Password must be at least ${UserValidation.PASSWORD_MIN_LENGTH} characters long`
      );
    }

    if (!body.firstName || body.firstName.length < UserValidation.NAME_MIN_LENGTH) {
      errors.push("First name is required");
    }

    if (!body.lastName || body.lastName.length < UserValidation.NAME_MIN_LENGTH) {
      errors.push("Last name is required");
    }

    if (body.role && !UserRoleList.includes(body.role)) {
      errors.push("Invalid role specified");
    }

    return errors;
  }

  private validateUpdateUserRequest(body: UpdateUserRequest): string[] {
    const errors: string[] = [];

    if (body.username !== undefined && body.username.length < UserValidation.USERNAME_MIN_LENGTH) {
      errors.push(
        `Username must be at least ${UserValidation.USERNAME_MIN_LENGTH} characters long`
      );
    }

    if (body.email !== undefined && !this.isValidEmail(body.email)) {
      errors.push("Valid email address is required");
    }

    if (body.firstName !== undefined && body.firstName.length < UserValidation.NAME_MIN_LENGTH) {
      errors.push("First name cannot be empty");
    }

    if (body.lastName !== undefined && body.lastName.length < UserValidation.NAME_MIN_LENGTH) {
      errors.push("Last name cannot be empty");
    }

    if (body.role && !UserRoleList.includes(body.role)) {
      errors.push("Invalid role specified");
    }

    if (body.status && !UserStatusList.includes(body.status)) {
      errors.push("Invalid status specified");
    }

    return errors;
  }

  private validatePasswordChangeRequest(body: ChangePasswordRequest): string[] {
    const errors: string[] = [];

    if (!body.currentPassword) {
      errors.push("Current password is required");
    }

    if (!body.newPassword || body.newPassword.length < UserValidation.PASSWORD_MIN_LENGTH) {
      errors.push(
        `New password must be at least ${UserValidation.PASSWORD_MIN_LENGTH} characters long`
      );
    }

    if (body.newPassword !== body.confirmPassword) {
      errors.push("New password and confirmation do not match");
    }

    if (body.currentPassword === body.newPassword) {
      errors.push("New password must be different from current password");
    }

    return errors;
  }

  private isValidEmail(email: string): boolean {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  private sendValidationError(reply: FastifyReply, error: z.ZodError): void {
    reply.code(HttpStatus.BAD_REQUEST).send({
      success: false,
      error: {
        code: CrudErrorCode.VALIDATION_ERROR,
        message: "Validation failed",
        details: error.issues.map((issue) => issue.message),
        statusCode: HttpStatus.BAD_REQUEST,
      },
    });
  }

  /** Centralized 5xx error response with error code; use in catch blocks. */
  private sendInternalError(
    reply: FastifyReply,
    code: string,
    message: string,
    statusCode: number = HttpStatus.INTERNAL_SERVER_ERROR
  ): void {
    reply.code(statusCode).send({
      success: false,
      error: { code, message, statusCode },
    });
  }

  private getContextRole(request: FastifyRequest): UserRoleType | undefined {
    const role = request.requestContext?.userRole;
    if (typeof role !== "string") return undefined;
    return this.isUserRole(role) ? role : undefined;
  }

  private isUserRole(value: string): value is UserRoleType {
    return UserRoleList.some((role) => role === value);
  }

  private filterUserData(
    user: User,
    userRole?: UserRoleType,
    isOwnProfile: boolean = false
  ): Partial<User> {
    // Copy nested objects we may delete from. A shallow { ...user } spread
    // shares profile/preferences by reference with the stored entity, so
    // `delete filtered.profile.phoneNumber` used to PERMANENTLY strip the
    // phone number from the store the first time a non-admin viewed the user.
    const filtered: Partial<User> = {
      ...user,
      profile: user.profile ? { ...user.profile } : user.profile,
      preferences: user.preferences ? { ...user.preferences } : user.preferences,
    };

    // Always remove password hash
    delete filtered.passwordHash;

    // Remove sensitive data based on permissions
    if (!isOwnProfile && userRole !== UserRole.ADMIN) {
      // Non-admin users viewing other profiles get limited data
      delete filtered.email;
      delete filtered.lastLoginAt;
      delete filtered.emailVerifiedAt;
      delete filtered.twoFactorEnabled;
      delete filtered.preferences;

      // Filter profile data based on privacy settings
      if (user.preferences?.privacy?.showPhone === false && filtered.profile) {
        delete filtered.profile.phoneNumber;
      }
    }

    return filtered;
  }
}
