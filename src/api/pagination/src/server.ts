// server.ts
import Fastify, { FastifyInstance } from "fastify";
import swagger from "@fastify/swagger";
import { readFileSync } from "fs";
import { join } from "path";
import { z } from "zod";
import {
  paginate,
  PaginationType,
  createPageBasedRequest,
  createOffsetBasedRequest,
  paginateWithCursor,
  InvalidCursorError,
  type Employee,
  type PaginationRequest,
  type PaginationResult,
  type CursorBasedResult,
} from "./pagination";
import { HttpStatus } from "./constants";

// Load fake data
const dataPath = join(__dirname, "fake-data.json");
const employees: Employee[] = JSON.parse(readFileSync(dataPath, "utf-8"));

// ----- Zod schemas for query validation -----
// Strict integer query param: the previous parseInt-based transforms silently
// accepted garbage ("5abc" -> 5) and truncated fractions ("1.5" -> 1), so a
// client typo returned the wrong rows with a 200 instead of a 400.
const intParam = (field: string): z.ZodOptional<z.ZodEffects<z.ZodString, number, string>> =>
  z
    .string()
    .regex(/^-?\d+$/, `${field} must be an integer`)
    .transform((s) => parseInt(s, 10))
    .optional();

const pageBasedQuerySchema = z.object({
  page: intParam("Page").transform((n) => n ?? 1),
  limit: intParam("Limit"),
  department: z.string().optional(),
});

const offsetBasedQuerySchema = z.object({
  offset: intParam("Offset").transform((n) => n ?? 0),
  limit: intParam("Limit"),
  department: z.string().optional(),
});

const paginateQuerySchema = z.object({
  type: z.nativeEnum(PaginationType),
  page: intParam("Page").transform((n) => n ?? 1),
  offset: intParam("Offset").transform((n) => n ?? 0),
  limit: intParam("Limit"),
  cursor: z.string().optional(),
  sortBy: z.string().optional(),
  sortDirection: z.enum(["asc", "desc"]).optional(),
  department: z.string().optional(),
});

const SORTABLE_FIELDS = [
  "id",
  "name",
  "email",
  "age",
  "department",
  "position",
  "salary",
  "joinDate",
] as const;

const cursorBasedQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: intParam("Limit"),
  sortBy: z.enum(SORTABLE_FIELDS).optional(),
  sortDirection: z.enum(["asc", "desc"]).optional(),
  department: z.string().optional(),
});

// Query parameter interfaces for Fastify (kept for typing)
interface PageBasedQuery {
  page?: string;
  limit?: string;
  department?: string;
}

interface OffsetBasedQuery {
  offset?: string;
  limit?: string;
  department?: string;
}

// Helper function to filter employees by department
function filterEmployeesByDepartment(employees: Employee[], department?: string): Employee[] {
  if (!department) return employees;
  return employees.filter((emp) => emp.department.toLowerCase().includes(department.toLowerCase()));
}

// Helper to send validation error from Zod result
function sendValidationError(
  reply: import("fastify").FastifyReply,
  result: z.SafeParseError<unknown>
): void {
  const message = result.error.errors.map((e) => e.message).join("; ") || "Validation failed";
  reply.code(HttpStatus.BAD_REQUEST).send({ error: "invalid_request", message });
}

/** Create and configure the Fastify app with swagger and routes (no listen). */
export async function createApp(opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? true });

  await app.register(swagger as unknown as Parameters<typeof app.register>[0], {
    openapi: {
      info: { title: "Pagination API", description: "Page-based and offset-based pagination", version: "1.0.0" },
      servers: [{ url: "http://localhost:3001", description: "Development" }],
    },
  });

  // Health check endpoint
  // Why: This provides a simple health check endpoint to verify the server is running.
  app.get("/health", async (req, reply) => {
    return reply.code(HttpStatus.OK).send({ status: "ok", message: "Pagination API is running" });
  });

  // Get all employees (no pagination)
  // Why: This provides access to the complete dataset for comparison.
  app.get<{ Querystring: PageBasedQuery }>("/employees", async (req, reply) => {
    const parsed = pageBasedQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(reply, parsed);
      return;
    }
    const { department } = parsed.data;
    const filteredEmployees = filterEmployeesByDepartment(employees, department);

    return reply.code(HttpStatus.OK).send({
      data: filteredEmployees,
      total: filteredEmployees.length,
      message: "All employees retrieved successfully",
    });
  });

  // Page-based pagination endpoint
  // Why: This demonstrates page-based pagination with page number and limit.
  app.get<{ Querystring: PageBasedQuery }>("/employees/page-based", async (req, reply) => {
    const parsed = pageBasedQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(reply, parsed);
      return;
    }
    const { page, limit, department } = parsed.data;
    const pageValid = page >= 1;
    const limitValid = limit === undefined || (Number.isInteger(limit) && limit >= 1);
    if (!pageValid) {
      return reply.code(HttpStatus.BAD_REQUEST).send({
        error: "invalid_request",
        message: "Page must be a positive integer",
      });
    }
    if (!limitValid) {
      return reply.code(HttpStatus.BAD_REQUEST).send({
        error: "invalid_request",
        message: "Limit must be a positive integer",
      });
    }

    const filteredEmployees = filterEmployeesByDepartment(employees, department);
    const paginationRequest = createPageBasedRequest(page, limit);
    const result: PaginationResult<Employee> = paginate(filteredEmployees, paginationRequest);

    return reply.code(HttpStatus.OK).send({
      ...result,
      message: "Page-based pagination successful",
    });
  });

  // Offset-based pagination endpoint
  // Why: This demonstrates offset-based pagination with offset and limit.
  app.get<{ Querystring: OffsetBasedQuery }>("/employees/offset-based", async (req, reply) => {
    const parsed = offsetBasedQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(reply, parsed);
      return;
    }
    const { offset, limit, department } = parsed.data;
    if (offset < 0 || !Number.isInteger(offset)) {
      return reply.code(HttpStatus.BAD_REQUEST).send({
        error: "invalid_request",
        message: "Offset must be a non-negative integer",
      });
    }
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) {
      return reply.code(HttpStatus.BAD_REQUEST).send({
        error: "invalid_request",
        message: "Limit must be a positive integer",
      });
    }

    const filteredEmployees = filterEmployeesByDepartment(employees, department);
    const paginationRequest = createOffsetBasedRequest(offset, limit);
    const result: PaginationResult<Employee> = paginate(filteredEmployees, paginationRequest);

    return reply.code(HttpStatus.OK).send({
      ...result,
      message: "Offset-based pagination successful",
    });
  });

  // Cursor-based (keyset) pagination endpoint
  // Why: Offset pagination duplicates/skips rows when the dataset changes
  // between requests; opaque cursors (the Stripe/Slack/GitHub pattern) seek
  // past a stable (sortKey, id) anchor instead. Cursors are scoped to the
  // active sort and department filter - replaying one against a different
  // scope returns 400 rather than silently wrong rows.
  app.get<{
    Querystring: {
      cursor?: string;
      limit?: string;
      sortBy?: string;
      sortDirection?: string;
      department?: string;
    };
  }>("/employees/cursor-based", async (req, reply) => {
    const parsed = cursorBasedQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      sendValidationError(reply, parsed);
      return;
    }
    const { cursor, limit, sortBy, sortDirection, department } = parsed.data;
    if (limit !== undefined && limit < 1) {
      return reply.code(HttpStatus.BAD_REQUEST).send({
        error: "invalid_request",
        message: "Limit must be a positive integer",
      });
    }

    const filteredEmployees = filterEmployeesByDepartment(employees, department);
    // Bake the active filter into issued cursors so a cursor from one filter
    // cannot be replayed against another.
    const scope = `department:${(department ?? "").toLowerCase()}`;

    try {
      const result: CursorBasedResult<Employee> = paginateWithCursor(filteredEmployees, {
        type: PaginationType.CURSOR_BASED,
        cursor,
        limit,
        sortBy,
        sortDirection,
        scope,
      });
      return reply.code(HttpStatus.OK).send({
        ...result,
        message: "Cursor-based pagination successful",
      });
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        return reply.code(HttpStatus.BAD_REQUEST).send({
          error: "invalid_cursor",
          message: err.message,
        });
      }
      throw err;
    }
  });

  // Generic pagination endpoint that accepts type parameter
  // Why: This provides a unified endpoint that can handle both pagination types.
  app.get<{ Querystring: PageBasedQuery & OffsetBasedQuery & { type?: string } }>(
    "/employees/paginate",
    async (req, reply) => {
      const parsed = paginateQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        const firstIssue = parsed.error.errors[0];
        const isTypeError =
          firstIssue?.path?.includes("type") ||
          (firstIssue?.message && String(firstIssue.message).includes("type"));
        if (isTypeError) {
          return reply.code(HttpStatus.BAD_REQUEST).send({
            error: "invalid_request",
            message: `Type must be one of: ${Object.values(PaginationType).join(", ")}`,
          });
        }
        sendValidationError(reply, parsed);
        return;
      }
      const { type, page, offset, limit, cursor, sortBy, sortDirection, department } = parsed.data;

      const filteredForCursor = filterEmployeesByDepartment(employees, department);

      let paginationRequest: PaginationRequest;
      if (type === PaginationType.CURSOR_BASED) {
        if (sortBy !== undefined && !(SORTABLE_FIELDS as readonly string[]).includes(sortBy)) {
          return reply.code(HttpStatus.BAD_REQUEST).send({
            error: "invalid_request",
            message: `sortBy must be one of: ${SORTABLE_FIELDS.join(", ")}`,
          });
        }
        try {
          const result: CursorBasedResult<Employee> = paginateWithCursor(filteredForCursor, {
            type: PaginationType.CURSOR_BASED,
            cursor,
            limit,
            sortBy,
            sortDirection,
            scope: `department:${(department ?? "").toLowerCase()}`,
          });
          return reply.code(HttpStatus.OK).send({
            ...result,
            message: `${type} pagination successful`,
          });
        } catch (err) {
          if (err instanceof InvalidCursorError) {
            return reply.code(HttpStatus.BAD_REQUEST).send({
              error: "invalid_cursor",
              message: err.message,
            });
          }
          throw err;
        }
      } else if (type === PaginationType.PAGE_BASED) {
        if (!Number.isInteger(page) || page < 1) {
          return reply.code(HttpStatus.BAD_REQUEST).send({
            error: "invalid_request",
            message: "Page must be a positive integer",
          });
        }
        paginationRequest = createPageBasedRequest(page, limit);
      } else {
        if (!Number.isInteger(offset) || offset < 0) {
          return reply.code(HttpStatus.BAD_REQUEST).send({
            error: "invalid_request",
            message: "Offset must be a non-negative integer",
          });
        }
        paginationRequest = createOffsetBasedRequest(offset, limit);
      }

      const result: PaginationResult<Employee> = paginate(filteredForCursor, paginationRequest);

      return reply.code(HttpStatus.OK).send({
        ...result,
        message: `${type} pagination successful`,
      });
    }
  );

  // Get employee statistics
  // Why: This provides useful statistics about the dataset for testing pagination.
  app.get("/employees/stats", async (req, reply) => {
    // Single pass: the previous departments.reduce + inner .filter rescanned
    // the whole dataset once per department (O(departments x employees)).
    const departmentCounts: Record<string, number> = {};
    for (const emp of employees) {
      departmentCounts[emp.department] = (departmentCounts[emp.department] ?? 0) + 1;
    }
    const departments = Object.keys(departmentCounts).sort();

    return reply.code(HttpStatus.OK).send({
      total: employees.length,
      departments,
      departmentCounts,
      message: "Employee statistics retrieved successfully",
    });
  });

  return app;
}

async function startServer(): Promise<void> {
  const app = await createApp();
  await app.listen({ port: 3001, host: "0.0.0.0" });
}

// Start the server only when run directly. Why: unguarded startServer() at
// module load meant merely importing createApp (e.g. from a test) bound port
// 3001 as a side effect, which blocked HTTP-level testing via app.inject().
if (require.main === module) {
  startServer().catch(console.error);
}
