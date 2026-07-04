import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { User } from "@/types";
import { HttpStatus } from "@/constants";

// In-memory storage for demo.
// `users` preserves insertion order for listing; `usersByEmail` is an O(1)
// uniqueness index keyed by the normalized email. Keeping both avoids the
// O(n) `Array.find` scan a naive dedupe would run on every insert (which is
// O(n^2) across n creates).
const users: User[] = [];
const usersByEmail = new Map<string, User>();

// Zod normalizes before validating: trim + lowercase the email so that
// "  User@Example.com " and "user@example.com" collide as the same identity,
// and reject whitespace-only names (plain .min(1) accepts "   ").
const createUserSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1),
});

const MAX_PAGE_LIMIT = 1000;

const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// Next.js's route-handler type checker (next build) requires the exported
// GET signature to be assignable to (request: NextRequest) => ... — even a
// default-valued (structurally optional) param fails that check. Keep the
// param required; callers (incl. direct unit-test invocation) must pass a
// request. See route.test.ts's createGetRequest("") for the no-params case.
export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl?.searchParams;
  const rawLimit = params?.get("limit") ?? undefined;
  const rawOffset = params?.get("offset") ?? undefined;

  // Backward compatible: with no pagination params, return the full list.
  if (rawLimit === undefined && rawOffset === undefined) {
    return NextResponse.json({
      success: true,
      data: users,
      total: users.length,
    });
  }

  const parsed = paginationSchema.safeParse({ limit: rawLimit, offset: rawOffset });
  if (!parsed.success) {
    return NextResponse.json(
      {
        success: false,
        error: "Validation error",
        details: parsed.error.errors,
      },
      { status: HttpStatus.BAD_REQUEST }
    );
  }

  const offset = parsed.data.offset ?? 0;
  const limit = parsed.data.limit ?? users.length;
  const page = users.slice(offset, offset + limit);

  return NextResponse.json({
    success: true,
    data: page,
    total: users.length,
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const validatedData = createUserSchema.safeParse(body);

    if (!validatedData.success) {
      return NextResponse.json(
        {
          success: false,
          error: "Validation error",
          details: validatedData.error.errors,
        },
        { status: HttpStatus.BAD_REQUEST }
      );
    }

    // email is already trimmed + lowercased by the schema.
    const { email, name } = validatedData.data;

    if (usersByEmail.has(email)) {
      return NextResponse.json(
        {
          success: false,
          error: "Email already exists",
        },
        { status: HttpStatus.CONFLICT }
      );
    }

    const now = new Date();
    const newUser: User = {
      id: crypto.randomUUID(),
      email,
      name,
      createdAt: now,
      updatedAt: now,
    };

    users.push(newUser);
    usersByEmail.set(email, newUser);

    return NextResponse.json(
      {
        success: true,
        data: newUser,
      },
      { status: HttpStatus.CREATED }
    );
  } catch (error) {
    if (error instanceof SyntaxError) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid JSON body",
        },
        { status: HttpStatus.BAD_REQUEST }
      );
    }

    return NextResponse.json(
      {
        success: false,
        error: "Internal server error",
      },
      { status: HttpStatus.INTERNAL_SERVER_ERROR }
    );
  }
}
