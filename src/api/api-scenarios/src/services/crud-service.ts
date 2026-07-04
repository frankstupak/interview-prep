/**
 * Generic CRUD Service Implementation
 *
 * This service provides a complete CRUD (Create, Read, Update, Delete)
 * implementation with advanced features like pagination, filtering,
 * sorting, validation, and audit logging.
 *
 * Key Features:
 * - Generic implementation for any entity type
 * - Advanced querying with filters and sorting
 * - Pagination with metadata
 * - Optimistic locking for concurrent updates
 * - Audit trail logging
 * - Soft delete support
 * - Bulk operations
 * - Field-level permissions
 * - Data validation and transformation
 */

import {
  BaseEntity,
  BaseEntitySystemFields,
  CreateEntityInput,
  PaginatedResponse,
  ApiResponse,
  AuditLog,
  BulkResult,
  AdvancedQuery,
  QueryFilter,
} from "../types/common";
import {
  HttpStatus,
  CrudErrorCode,
  AuditAction,
  AuditActionType,
  BaseEntityField,
  SoftDeleteFilter,
} from "../constants";
import { v4 as uuidv4 } from "uuid";

export interface CrudServiceOptions<T> {
  entityName: string;
  validator?: (entity: Partial<T>) => Promise<string[]>; // Returns validation errors
  transformer?: (entity: T) => T; // Transform entity before saving
  auditEnabled?: boolean;
  softDelete?: boolean;
  permissions?: {
    create?: string[];
    read?: string[];
    update?: string[];
    delete?: string[];
  };
}

export interface Repository<T extends BaseEntity> {
  findById(id: string): Promise<T | null>;
  findMany(query: AdvancedQuery): Promise<PaginatedResponse<T>>;
  create(entity: CreateEntityInput<T>): Promise<T>;
  update(id: string, updates: Partial<T>, version?: number): Promise<T>;
  delete(id: string): Promise<boolean>;
  bulkCreate(entities: CreateEntityInput<T>[]): Promise<T[]>;
  bulkUpdate(updates: Array<{ id: string; data: Partial<T>; version?: number }>): Promise<T[]>;
  bulkDelete(ids: string[]): Promise<number>;
  count(filters?: QueryFilter[]): Promise<number>;
}

export class CrudService<T extends BaseEntity> {
  private repository: Repository<T>;
  private options: CrudServiceOptions<T>;
  private auditRepository?: Repository<AuditLog>;

  constructor(
    repository: Repository<T>,
    options: CrudServiceOptions<T>,
    auditRepository?: Repository<AuditLog>
  ) {
    this.repository = repository;
    this.options = options;
    this.auditRepository = auditRepository;
  }

  /**
   * Create a new entity
   *
   * Why: Standardized creation with validation, transformation, and audit logging
   * When: Use for creating new records with full validation pipeline
   */
  async create(data: CreateEntityInput<T>, _userId?: string): Promise<ApiResponse<T>> {
    try {
      console.error(`🆕 Creating new ${this.options.entityName}`);

      // Validate input data
      if (this.options.validator) {
        const validationErrors = await this.options.validator(data as Partial<T>);
        if (validationErrors.length > 0) {
          return this.createErrorResponse(
            CrudErrorCode.VALIDATION_ERROR,
            "Validation failed",
            {
              errors: validationErrors,
            },
            HttpStatus.BAD_REQUEST
          );
        }
      }

      // Transform data if transformer is provided
      let entityData: CreateEntityInput<T> = data;
      if (this.options.transformer) {
        entityData = this.options.transformer(entityData as T) as CreateEntityInput<T>;
      }

      // Create the entity
      const entity = await this.repository.create(entityData);

      // Log audit trail
      if (this.options.auditEnabled && this.auditRepository) {
        await this.logAudit(AuditAction.CREATE, entity.id, _userId, { after: entity });
      }

      console.error(`✅ Created ${this.options.entityName} with ID: ${entity.id}`);

      return this.createSuccessResponse(entity);
    } catch (error) {
      console.error(`❌ Failed to create ${this.options.entityName}:`, error);
      return this.createErrorResponse(
        CrudErrorCode.CREATE_FAILED,
        "Failed to create entity",
        error
      );
    }
  }

  /**
   * Get entity by ID
   *
   * Why: Standardized retrieval with error handling and audit logging
   * When: Use for fetching single records by primary key
   */
  async getById(id: string, _userId?: string): Promise<ApiResponse<T>> {
    try {
      console.error(`🔍 Fetching ${this.options.entityName} with ID: ${id}`);

      if (!id || typeof id !== "string") {
        return this.createErrorResponse(
          CrudErrorCode.INVALID_ID,
          "Invalid entity ID provided",
          null,
          HttpStatus.BAD_REQUEST
        );
      }

      const entity = await this.repository.findById(id);

      if (!entity) {
        return this.createErrorResponse(
          CrudErrorCode.NOT_FOUND,
          `${this.options.entityName} not found`,
          null,
          HttpStatus.NOT_FOUND
        );
      }

      // Check if entity is soft deleted
      if (this.options.softDelete && (entity as T & { deletedAt?: Date }).deletedAt) {
        return this.createErrorResponse(
          CrudErrorCode.NOT_FOUND,
          `${this.options.entityName} not found`,
          null,
          HttpStatus.NOT_FOUND
        );
      }

      // Log audit trail for read operations (optional)
      if (this.options.auditEnabled && this.auditRepository) {
        await this.logAudit(AuditAction.READ, entity.id, _userId);
      }

      console.error(`✅ Found ${this.options.entityName} with ID: ${id}`);

      return this.createSuccessResponse(entity);
    } catch (error) {
      console.error(`❌ Failed to fetch ${this.options.entityName}:`, error);
      return this.createErrorResponse(CrudErrorCode.FETCH_FAILED, "Failed to fetch entity", error);
    }
  }

  /**
   * Get multiple entities with advanced querying
   *
   * Why: Flexible querying with pagination, filtering, and sorting
   * When: Use for list views, search results, and filtered data sets
   */
  async getMany(
    query: AdvancedQuery,
    _userId?: string
  ): Promise<ApiResponse<PaginatedResponse<T>>> {
    try {
      console.error(`📋 Fetching ${this.options.entityName} list with query:`, query);

      // Validate and sanitize query
      const sanitizedQuery = this.sanitizeQuery(query);

      // Add soft delete filter if enabled
      if (this.options.softDelete) {
        sanitizedQuery.filters = sanitizedQuery.filters || [];
        sanitizedQuery.filters.push({ ...SoftDeleteFilter });
      }

      const result = await this.repository.findMany(sanitizedQuery);

      console.error(`✅ Found ${result.data.length} ${this.options.entityName} records`);

      return this.createSuccessResponse(result);
    } catch (error) {
      console.error(`❌ Failed to fetch ${this.options.entityName} list:`, error);
      return this.createErrorResponse(
        CrudErrorCode.FETCH_FAILED,
        "Failed to fetch entities",
        error
      );
    }
  }

  /**
   * Update an existing entity
   *
   * Why: Standardized updates with optimistic locking and audit logging
   * When: Use for modifying existing records with conflict detection
   */
  async update(
    id: string,
    updates: Partial<T>,
    _userId?: string,
    version?: number
  ): Promise<ApiResponse<T>> {
    try {
      console.error(`✏️ Updating ${this.options.entityName} with ID: ${id}`);

      if (!id || typeof id !== "string") {
        return this.createErrorResponse(
          CrudErrorCode.INVALID_ID,
          "Invalid entity ID provided",
          null,
          HttpStatus.BAD_REQUEST
        );
      }

      // Get current entity for audit logging
      const currentEntity = await this.repository.findById(id);
      if (!currentEntity) {
        return this.createErrorResponse(
          CrudErrorCode.NOT_FOUND,
          `${this.options.entityName} not found`,
          null,
          HttpStatus.NOT_FOUND
        );
      }

      // Check if entity is soft deleted
      if (this.options.softDelete && (currentEntity as T & { deletedAt?: Date }).deletedAt) {
        return this.createErrorResponse(
          CrudErrorCode.NOT_FOUND,
          `${this.options.entityName} not found`,
          null,
          HttpStatus.NOT_FOUND
        );
      }

      // Validate updates
      if (this.options.validator) {
        const validationErrors = await this.options.validator(updates as Partial<T>);
        if (validationErrors.length > 0) {
          return this.createErrorResponse(
            CrudErrorCode.VALIDATION_ERROR,
            "Validation failed",
            {
              errors: validationErrors,
            },
            HttpStatus.BAD_REQUEST
          );
        }
      }

      // Transform updates if transformer is provided
      let updateData = updates;
      if (this.options.transformer) {
        updateData = this.options.transformer({ ...currentEntity, ...updates } as T);
        // Extract only the updated fields
        updateData = Object.keys(updates).reduce((acc, key) => {
          (acc as Record<string, unknown>)[key] = (updateData as Record<string, unknown>)[key];
          return acc;
        }, {} as Partial<T>);
      }

      // Perform update with optimistic locking
      const updatedEntity = await this.repository.update(id, updateData as Partial<T>, version);

      // Log audit trail
      if (this.options.auditEnabled && this.auditRepository) {
        await this.logAudit(AuditAction.UPDATE, id, _userId, {
          before: currentEntity,
          after: updatedEntity,
        });
      }

      console.error(`✅ Updated ${this.options.entityName} with ID: ${id}`);

      return this.createSuccessResponse(updatedEntity);
    } catch (error) {
      console.error(`❌ Failed to update ${this.options.entityName}:`, error);

      // Handle optimistic locking conflicts
      const err = error as Error;
      if (err.message?.includes("version") || err.message?.includes("conflict")) {
        return this.createErrorResponse(
          CrudErrorCode.CONFLICT,
          "Entity was modified by another user",
          error,
          HttpStatus.CONFLICT
        );
      }

      return this.createErrorResponse(
        CrudErrorCode.UPDATE_FAILED,
        "Failed to update entity",
        error
      );
    }
  }

  /**
   * Delete an entity (soft or hard delete)
   *
   * Why: Standardized deletion with audit logging and soft delete support
   * When: Use for removing records with proper cleanup and logging
   */
  async delete(
    id: string,
    _userId?: string,
    force: boolean = false
  ): Promise<ApiResponse<boolean>> {
    try {
      console.error(`🗑️ Deleting ${this.options.entityName} with ID: ${id} (force: ${force})`);

      if (!id || typeof id !== "string") {
        return this.createErrorResponse(
          CrudErrorCode.INVALID_ID,
          "Invalid entity ID provided",
          null,
          HttpStatus.BAD_REQUEST
        );
      }

      // Get current entity for audit logging
      const currentEntity = await this.repository.findById(id);
      if (!currentEntity) {
        return this.createErrorResponse(
          CrudErrorCode.NOT_FOUND,
          `${this.options.entityName} not found`,
          null,
          HttpStatus.NOT_FOUND
        );
      }

      let success: boolean;

      if (this.options.softDelete && !force) {
        // Soft delete - mark as deleted
        const deletedEntity = await this.repository.update(id, {
          [BaseEntityField.DELETED_AT]: new Date(),
        } as unknown as Partial<T>);
        success = !!deletedEntity;
      } else {
        // Hard delete - permanently remove
        success = await this.repository.delete(id);
      }

      // Log audit trail
      if (this.options.auditEnabled && this.auditRepository) {
        await this.logAudit(AuditAction.DELETE, id, _userId, { before: currentEntity });
      }

      console.error(`✅ Deleted ${this.options.entityName} with ID: ${id}`);

      return this.createSuccessResponse(success);
    } catch (error) {
      console.error(`❌ Failed to delete ${this.options.entityName}:`, error);
      return this.createErrorResponse(
        CrudErrorCode.DELETE_FAILED,
        "Failed to delete entity",
        error
      );
    }
  }

  /**
   * Bulk create multiple entities
   *
   * Why: Efficient batch creation with transaction support
   * When: Use for importing data or creating multiple related records
   */
  async bulkCreate(
    entities: CreateEntityInput<T>[],
    _userId?: string
  ): Promise<ApiResponse<BulkResult<T>>> {
    try {
      console.error(`📦 Bulk creating ${entities.length} ${this.options.entityName} records`);

      if (!entities || entities.length === 0) {
        return this.createErrorResponse(
          CrudErrorCode.INVALID_INPUT,
          "No entities provided for bulk creation",
          null,
          HttpStatus.BAD_REQUEST
        );
      }

      const results: BulkResult<T> = {
        success: true,
        processed: 0,
        failed: 0,
        results: [],
      };

      // Validate all entities first
      const validationPromises = entities.map(async (entity, index) => {
        if (this.options.validator) {
          const errors = await this.options.validator(entity as Partial<T>);
          return { index, errors };
        }
        return { index, errors: [] };
      });

      const validationResults = await Promise.all(validationPromises);
      const hasValidationErrors = validationResults.some((result) => result.errors.length > 0);

      if (hasValidationErrors) {
        // Return validation errors for all entities. Nothing is persisted
        // (all-or-nothing), so processed stays 0.
        validationResults.forEach((result) => {
          results.results.push({
            success: result.errors.length === 0,
            error:
              result.errors.length > 0
                ? {
                    code: CrudErrorCode.VALIDATION_ERROR,
                    message: "Validation failed",
                    details: result.errors,
                    statusCode: HttpStatus.BAD_REQUEST,
                  }
                : undefined,
          });

          if (result.errors.length > 0) {
            results.failed++;
          }
        });

        results.success = false;
        return this.createSuccessResponse(results);
      }

      // Transform entities if transformer is provided
      let processedEntities = entities;
      if (this.options.transformer) {
        processedEntities = entities
          .map((entity) => this.options.transformer!(entity as T))
          .map((transformed) => {
            // Remove id, createdAt, updatedAt from transformed entity
            const t = transformed as T & { id: string; createdAt: Date; updatedAt: Date };
            const {
              [BaseEntityField.ID]: _id,
              [BaseEntityField.CREATED_AT]: _c,
              [BaseEntityField.UPDATED_AT]: _u,
              ...rest
            } = t;
            void _id;
            void _c;
            void _u;
            return rest as CreateEntityInput<T>;
          });
      }

      // Perform bulk creation
      const createdEntities = await this.repository.bulkCreate(processedEntities);

      // Update results
      results.processed = createdEntities.length;
      results.results = createdEntities.map((entity) => ({
        success: true,
        data: entity,
      }));

      // Log audit trail for bulk operations
      if (this.options.auditEnabled && this.auditRepository) {
        const auditPromises = createdEntities.map((entity) =>
          this.logAudit(AuditAction.CREATE, entity.id, _userId, { after: entity })
        );
        await Promise.all(auditPromises);
      }

      console.error(`✅ Bulk created ${createdEntities.length} ${this.options.entityName} records`);

      return this.createSuccessResponse(results);
    } catch (error) {
      console.error(`❌ Failed to bulk create ${this.options.entityName}:`, error);
      return this.createErrorResponse(
        CrudErrorCode.BULK_CREATE_FAILED,
        "Failed to bulk create entities",
        error
      );
    }
  }

  /**
   * Bulk update multiple entities
   *
   * Why: The Repository contract always had bulkUpdate, but no service method
   * exposed it — the HTTP bulk endpoint was a mock. Per-item isolation: one
   * failed update does not abort the rest.
   * When: Use for batch edits (e.g. admin bulk status changes)
   */
  async bulkUpdate(
    updates: Array<{ id: string; data: Partial<T>; version?: number }>,
    _userId?: string
  ): Promise<ApiResponse<BulkResult<T>>> {
    try {
      console.error(`Bulk updating ${updates?.length ?? 0} ${this.options.entityName} records`);

      if (!updates || updates.length === 0) {
        return this.createErrorResponse(
          CrudErrorCode.INVALID_INPUT,
          "No updates provided for bulk update",
          null,
          HttpStatus.BAD_REQUEST
        );
      }

      const results: BulkResult<T> = { success: true, processed: 0, failed: 0, results: [] };

      for (const update of updates) {
        const result = await this.update(update.id, update.data, _userId, update.version);
        if (result.success) {
          results.processed++;
          results.results.push({ success: true, data: result.data });
        } else {
          results.failed++;
          results.results.push({ success: false, error: result.error });
        }
      }

      results.success = results.failed === 0;
      return this.createSuccessResponse(results);
    } catch (error) {
      console.error(`Failed to bulk update ${this.options.entityName}:`, error);
      return this.createErrorResponse(
        CrudErrorCode.UPDATE_FAILED,
        "Failed to bulk update entities",
        error
      );
    }
  }

  /**
   * Bulk delete multiple entities (per-item, honors softDelete)
   *
   * Why: Completes the bulk API surface; delete() already implements soft
   * delete + audit, so route each id through it for consistent behavior.
   * When: Use for batch removal (e.g. admin cleanup)
   */
  async bulkDelete(
    ids: string[],
    _userId?: string,
    force: boolean = false
  ): Promise<ApiResponse<BulkResult<boolean>>> {
    try {
      console.error(`Bulk deleting ${ids?.length ?? 0} ${this.options.entityName} records`);

      if (!ids || ids.length === 0) {
        return this.createErrorResponse(
          CrudErrorCode.INVALID_INPUT,
          "No ids provided for bulk delete",
          null,
          HttpStatus.BAD_REQUEST
        );
      }

      const results: BulkResult<boolean> = { success: true, processed: 0, failed: 0, results: [] };

      for (const id of ids) {
        const result = await this.delete(id, _userId, force);
        if (result.success) {
          results.processed++;
          results.results.push({ success: true, data: result.data });
        } else {
          results.failed++;
          results.results.push({ success: false, error: result.error });
        }
      }

      results.success = results.failed === 0;
      return this.createSuccessResponse(results);
    } catch (error) {
      console.error(`Failed to bulk delete ${this.options.entityName}:`, error);
      return this.createErrorResponse(
        CrudErrorCode.DELETE_FAILED,
        "Failed to bulk delete entities",
        error
      );
    }
  }

  /**
   * Get entity count with optional filters
   *
   * Why: Efficient counting for pagination and statistics
   * When: Use for dashboard metrics and pagination metadata
   */
  async count(filters?: QueryFilter[], _userId?: string): Promise<ApiResponse<number>> {
    try {
      console.error(`🔢 Counting ${this.options.entityName} records`);

      // Add soft delete filter if enabled
      let countFilters = filters || [];
      if (this.options.softDelete) {
        countFilters = [...countFilters, { ...SoftDeleteFilter }];
      }

      const count = await this.repository.count(countFilters);

      console.error(`✅ Found ${count} ${this.options.entityName} records`);

      return this.createSuccessResponse(count);
    } catch (error) {
      console.error(`❌ Failed to count ${this.options.entityName}:`, error);
      return this.createErrorResponse(
        CrudErrorCode.COUNT_FAILED,
        "Failed to count entities",
        error
      );
    }
  }

  /**
   * Restore a soft-deleted entity
   *
   * Why: Allows recovery of accidentally deleted records
   * When: Use for undo functionality and data recovery
   */
  async restore(id: string, _userId?: string): Promise<ApiResponse<T>> {
    if (!this.options.softDelete) {
      return this.createErrorResponse(
        CrudErrorCode.NOT_SUPPORTED,
        "Restore operation not supported",
        null,
        HttpStatus.BAD_REQUEST
      );
    }

    try {
      console.error(`🔄 Restoring ${this.options.entityName} with ID: ${id}`);

      const entity = await this.repository.findById(id);
      if (!entity) {
        return this.createErrorResponse(
          CrudErrorCode.NOT_FOUND,
          `${this.options.entityName} not found`,
          null,
          HttpStatus.NOT_FOUND
        );
      }

      if (!(entity as T & { deletedAt?: Date }).deletedAt) {
        return this.createErrorResponse(
          CrudErrorCode.NOT_DELETED,
          `${this.options.entityName} is not deleted`,
          null,
          HttpStatus.BAD_REQUEST
        );
      }

      const restoredEntity = await this.repository.update(id, {
        [BaseEntityField.DELETED_AT]: null,
      } as unknown as Partial<T>);

      // Log audit trail
      if (this.options.auditEnabled && this.auditRepository) {
        await this.logAudit(AuditAction.UPDATE, id, _userId, {
          before: entity,
          after: restoredEntity,
        });
      }

      console.error(`✅ Restored ${this.options.entityName} with ID: ${id}`);

      return this.createSuccessResponse(restoredEntity);
    } catch (error) {
      console.error(`❌ Failed to restore ${this.options.entityName}:`, error);
      return this.createErrorResponse(
        CrudErrorCode.RESTORE_FAILED,
        "Failed to restore entity",
        error
      );
    }
  }

  /**
   * Private helper methods
   */

  private sanitizeQuery(query: AdvancedQuery): AdvancedQuery {
    const sanitized: AdvancedQuery = {};

    // Sanitize pagination
    if (query.pagination) {
      sanitized.pagination = {
        page: Math.max(1, query.pagination.page || 1),
        limit: Math.min(100, Math.max(1, query.pagination.limit || 10)),
        sortBy: query.pagination.sortBy,
        sortOrder: query.pagination.sortOrder === "desc" ? "desc" : "asc",
      };
    }

    // Sanitize filters
    if (query.filters) {
      sanitized.filters = query.filters.filter(
        (filter) => filter.field && filter.operator && filter.value !== undefined
      );
    }

    // Sanitize sort options
    if (query.sort) {
      sanitized.sort = query.sort.filter(
        (sort) => sort.field && ["asc", "desc"].includes(sort.order)
      );
    }

    // Preserve search — previously dropped here, so every controller that set
    // query.search (e.g. GET /users?search=) had its search term silently
    // discarded before reaching the repository and matched all rows.
    if (query.search && typeof query.search.q === "string" && query.search.q.length > 0) {
      sanitized.search = {
        q: query.search.q,
        fields: query.search.fields?.filter(
          (field) => typeof field === "string" && field.length > 0
        ),
        filters: query.search.filters,
      };
    }

    // Sanitize field selection
    if (query.fields) {
      sanitized.fields = query.fields.filter(
        (field) => typeof field === "string" && field.length > 0
      );
    }

    // Sanitize includes
    if (query.include) {
      sanitized.include = query.include.filter(
        (include) => typeof include === "string" && include.length > 0
      );
    }

    return sanitized;
  }

  private async logAudit(
    action: AuditActionType,
    entityId: string,
    userId?: string,
    changes?: { before?: unknown; after?: unknown }
  ): Promise<void> {
    if (!this.auditRepository) return;

    try {
      const auditLog: Omit<AuditLog, BaseEntitySystemFields> = {
        entityType: this.options.entityName,
        entityId,
        action,
        userId,
        changes,
        metadata: {
          ip: "unknown", // Would be extracted from request context
          userAgent: "unknown",
          source: "crud-service",
        },
      };

      await this.auditRepository.create(auditLog);
    } catch (error) {
      console.error("Failed to log audit trail:", error);
      // Don't throw - audit logging failure shouldn't break the main operation
    }
  }

  private createSuccessResponse<TData>(data: TData): ApiResponse<TData> {
    return {
      success: true,
      data,
      meta: {
        timestamp: new Date().toISOString(),
        requestId: uuidv4(),
        executionTime: 0, // Would be calculated by middleware
      },
    };
  }

  private createErrorResponse(
    code: string,
    message: string,
    details?: unknown,
    statusCode: number = 500
  ): ApiResponse<never> {
    return {
      success: false,
      error: {
        code,
        message,
        details,
        statusCode,
      },
      meta: {
        timestamp: new Date().toISOString(),
        requestId: uuidv4(),
        executionTime: 0,
      },
    };
  }
}
