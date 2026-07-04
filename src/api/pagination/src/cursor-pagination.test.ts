// cursor-pagination.test.ts - cursor (keyset) pagination + integer-safety regression tests
import { describe, it, expect } from "@jest/globals";
import {
  paginate,
  paginateWithCursor,
  paginateWithPageBased,
  paginateWithOffsetBased,
  createCursorPaginator,
  createCursorBasedRequest,
  createOffsetBasedRequest,
  decodeCursor,
  InvalidCursorError,
  PaginationType,
  type CursorBasedResult,
  type DataItem,
  type PageBasedResult,
  type OffsetBasedResult,
} from "./pagination";

interface Row extends DataItem {
  id: number;
  name: string;
  department: string;
  salary: number;
}

function makeRows(n: number): Row[] {
  const rows: Row[] = [];
  for (let i = 1; i <= n; i++) {
    rows.push({
      id: i,
      name: `Row ${i}`,
      department: `Dept ${(i % 3) + 1}`, // deliberately non-unique
      salary: 50000 + (i % 7) * 1000, // deliberately collides a lot
    });
  }
  return rows;
}

/** Walk every page forward via nextCursor and return all ids seen. */
function sweepForward(
  data: Row[],
  opts: { sortBy?: string; sortDirection?: "asc" | "desc"; limit: number }
): number[] {
  const ids: number[] = [];
  let cursor: string | undefined;
  let guard = 0;
  for (;;) {
    const result = paginateWithCursor(data, createCursorBasedRequest({ ...opts, cursor }));
    ids.push(...result.data.map((r) => r.id));
    if (result.nextCursor === null) break;
    cursor = result.nextCursor;
    if (++guard > data.length + 10) throw new Error("sweep did not terminate");
  }
  return ids;
}

describe("Cursor-based pagination: basics", () => {
  const rows = makeRows(25);

  it("returns the first page with a nextCursor and no prevCursor", () => {
    const result = paginateWithCursor(rows, createCursorBasedRequest({ limit: 10 }));

    expect(result.type).toBe(PaginationType.CURSOR_BASED);
    expect(result.data.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(result.total).toBe(25);
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).not.toBeNull();
    expect(result.prevCursor).toBeNull();
    expect(result.sortBy).toBe("id");
    expect(result.sortDirection).toBe("asc");
  });

  it("continues exactly where the cursor left off", () => {
    const page1 = paginateWithCursor(rows, createCursorBasedRequest({ limit: 10 }));
    const page2 = paginateWithCursor(
      rows,
      createCursorBasedRequest({ limit: 10, cursor: page1.nextCursor! })
    );

    expect(page2.data.map((r) => r.id)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(page2.prevCursor).not.toBeNull();
    expect(page2.hasMore).toBe(true);
  });

  it("signals the last page with nextCursor null and hasMore false", () => {
    const page1 = paginateWithCursor(rows, createCursorBasedRequest({ limit: 20 }));
    const page2 = paginateWithCursor(
      rows,
      createCursorBasedRequest({ limit: 20, cursor: page1.nextCursor! })
    );

    expect(page2.data.map((r) => r.id)).toEqual([21, 22, 23, 24, 25]);
    expect(page2.nextCursor).toBeNull();
    expect(page2.hasMore).toBe(false);
  });

  it("navigates backward via prevCursor", () => {
    const page1 = paginateWithCursor(rows, createCursorBasedRequest({ limit: 10 }));
    const page2 = paginateWithCursor(
      rows,
      createCursorBasedRequest({ limit: 10, cursor: page1.nextCursor! })
    );
    const back = paginateWithCursor(
      rows,
      createCursorBasedRequest({ limit: 10, cursor: page2.prevCursor! })
    );

    expect(back.data.map((r) => r.id)).toEqual(page1.data.map((r) => r.id));
    expect(back.prevCursor).toBeNull(); // nothing before the first page
    expect(back.nextCursor).not.toBeNull();
  });

  it("supports descending order", () => {
    const result = paginateWithCursor(
      rows,
      createCursorBasedRequest({ limit: 5, sortDirection: "desc" })
    );
    expect(result.data.map((r) => r.id)).toEqual([25, 24, 23, 22, 21]);

    const page2 = paginateWithCursor(
      rows,
      createCursorBasedRequest({ limit: 5, sortDirection: "desc", cursor: result.nextCursor! })
    );
    expect(page2.data.map((r) => r.id)).toEqual([20, 19, 18, 17, 16]);
  });

  it("dispatches through the generic paginate() entry point", () => {
    const result = paginate(rows, createCursorBasedRequest({ limit: 5 })) as CursorBasedResult<Row>;
    expect(result.type).toBe(PaginationType.CURSOR_BASED);
    expect(result.data).toHaveLength(5);
  });

  it("handles an empty dataset", () => {
    const result = paginateWithCursor([], createCursorBasedRequest({ limit: 10 }));
    expect(result.data).toHaveLength(0);
    expect(result.total).toBe(0);
    expect(result.nextCursor).toBeNull();
    expect(result.prevCursor).toBeNull();
    expect(result.hasMore).toBe(false);
  });

  it("clamps and defaults the limit like the other strategies", () => {
    const clamped = paginateWithCursor(
      rows,
      createCursorBasedRequest({ limit: 1000 }),
      { defaultLimit: 10, maxLimit: 15 }
    );
    expect(clamped.limit).toBe(15);
    expect(clamped.data).toHaveLength(15);

    const defaulted = paginateWithCursor(rows, createCursorBasedRequest({}));
    expect(defaulted.limit).toBe(10);
  });
});

describe("Cursor-based pagination: stable total order on non-unique sort keys", () => {
  const rows = makeRows(101); // department and salary collide heavily

  it("sweeps every row exactly once when sorting by a non-unique field (id tiebreaker)", () => {
    const ids = sweepForward(rows, { sortBy: "department", limit: 7 });
    expect(ids).toHaveLength(101);
    expect(new Set(ids).size).toBe(101); // no duplicates
  });

  it("sweeps every row exactly once on a heavily colliding numeric field, descending", () => {
    const ids = sweepForward(rows, { sortBy: "salary", sortDirection: "desc", limit: 9 });
    expect(ids).toHaveLength(101);
    expect(new Set(ids).size).toBe(101);
  });

  it("orders pages consistently with the requested sort", () => {
    const result = paginateWithCursor(
      rows,
      createCursorBasedRequest({ sortBy: "salary", sortDirection: "desc", limit: 101 })
    );
    const salaries = result.data.map((r) => r.salary);
    const sorted = [...salaries].sort((a, b) => b - a);
    expect(salaries).toEqual(sorted);
  });
});

describe("Cursor-based pagination: immunity to concurrent inserts/deletes", () => {
  it("DEMONSTRATES the offset failure: an insert between pages duplicates a row", () => {
    const rows = makeRows(10);
    const page1 = paginateWithOffsetBased(
      rows,
      createOffsetBasedRequest(0, 5)
    ) as OffsetBasedResult<Row>;
    expect(page1.data.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);

    // A new row lands at the head of the list between the two requests.
    const mutated: Row[] = [
      { id: 999, name: "New head row", department: "Dept 1", salary: 50000 },
      ...rows,
    ];
    const page2 = paginateWithOffsetBased(
      mutated,
      createOffsetBasedRequest(5, 5)
    ) as OffsetBasedResult<Row>;

    // Row 5 was already returned on page 1 and shows up AGAIN on page 2.
    expect(page2.data.map((r) => r.id)).toContain(5);
  });

  it("cursor pagination returns no duplicates and skips nothing across the same insert", () => {
    const rows = makeRows(10);
    const page1 = paginateWithCursor(rows, createCursorBasedRequest({ limit: 5 }));
    expect(page1.data.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);

    const mutated: Row[] = [
      { id: 999, name: "New head row", department: "Dept 1", salary: 50000 },
      ...rows,
    ];
    const page2 = paginateWithCursor(
      mutated,
      createCursorBasedRequest({ limit: 5, cursor: page1.nextCursor! })
    );

    // Continues strictly after id 5 in the (id) order - no dup, no skip.
    expect(page2.data.map((r) => r.id)).toEqual([6, 7, 8, 9, 10]);
  });

  it("cursor pagination skips nothing when rows already returned are deleted", () => {
    const rows = makeRows(10);
    const page1 = paginateWithCursor(rows, createCursorBasedRequest({ limit: 5 }));

    // Rows 1-3 are deleted between requests; an offset of 5 would now skip
    // rows 6-7 entirely. The cursor still resumes exactly after id 5.
    const mutated = rows.filter((r) => r.id > 3);
    const offsetPage2 = paginateWithOffsetBased(
      mutated,
      createOffsetBasedRequest(5, 5)
    ) as OffsetBasedResult<Row>;
    expect(offsetPage2.data.map((r) => r.id)).toEqual([9, 10]); // 6, 7, 8 silently skipped

    const cursorPage2 = paginateWithCursor(
      mutated,
      createCursorBasedRequest({ limit: 5, cursor: page1.nextCursor! })
    );
    expect(cursorPage2.data.map((r) => r.id)).toEqual([6, 7, 8, 9, 10]);
  });

  it("resumes correctly even when the anchor row itself was deleted", () => {
    const rows = makeRows(10);
    const page1 = paginateWithCursor(rows, createCursorBasedRequest({ limit: 5 }));

    const mutated = rows.filter((r) => r.id !== 5); // the anchor is gone
    const page2 = paginateWithCursor(
      mutated,
      createCursorBasedRequest({ limit: 5, cursor: page1.nextCursor! })
    );
    expect(page2.data.map((r) => r.id)).toEqual([6, 7, 8, 9, 10]);
  });
});

describe("Cursor-based pagination: cursor integrity", () => {
  const rows = makeRows(20);

  it("rejects a malformed cursor with InvalidCursorError", () => {
    expect(() =>
      paginateWithCursor(rows, createCursorBasedRequest({ cursor: "not-a-real-cursor!!" }))
    ).toThrow(InvalidCursorError);
  });

  it("rejects a structurally valid but wrong-shaped payload", () => {
    const bogus = Buffer.from(JSON.stringify({ hello: "world" }), "utf8").toString("base64url");
    expect(() => paginateWithCursor(rows, createCursorBasedRequest({ cursor: bogus }))).toThrow(
      InvalidCursorError
    );
  });

  it("rejects a cursor replayed against a different sort", () => {
    const page1 = paginateWithCursor(rows, createCursorBasedRequest({ limit: 5, sortBy: "name" }));
    expect(() =>
      paginateWithCursor(
        rows,
        createCursorBasedRequest({ limit: 5, sortBy: "salary", cursor: page1.nextCursor! })
      )
    ).toThrow(InvalidCursorError);
  });

  it("rejects a cursor replayed against a different direction", () => {
    const page1 = paginateWithCursor(rows, createCursorBasedRequest({ limit: 5 }));
    expect(() =>
      paginateWithCursor(
        rows,
        createCursorBasedRequest({ limit: 5, sortDirection: "desc", cursor: page1.nextCursor! })
      )
    ).toThrow(InvalidCursorError);
  });

  it("rejects a cursor replayed against a different filter scope", () => {
    const page1 = paginateWithCursor(
      rows,
      createCursorBasedRequest({ limit: 5, scope: "department:dept 1" })
    );
    expect(() =>
      paginateWithCursor(
        rows,
        createCursorBasedRequest({ limit: 5, scope: "department:dept 2", cursor: page1.nextCursor! })
      )
    ).toThrow(InvalidCursorError);
  });

  it("decodeCursor round-trips the anchor tuple", () => {
    const page1 = paginateWithCursor(rows, createCursorBasedRequest({ limit: 5 }));
    const payload = decodeCursor(page1.nextCursor!);
    expect(payload.id).toBe(5);
    expect(payload.s).toBe("id");
    expect(payload.d).toBe("asc");
    expect(payload.nav).toBe("next");
  });
});

describe("createCursorPaginator (sort-once)", () => {
  const rows = makeRows(50);

  it("returns pages identical to the one-shot API", () => {
    const paginator = createCursorPaginator(rows, { sortBy: "salary" });
    const oneShot = paginateWithCursor(
      rows,
      createCursorBasedRequest({ limit: 10, sortBy: "salary" })
    );
    const viaPaginator = paginator.page(undefined, 10);

    expect(viaPaginator.data.map((r) => r.id)).toEqual(oneShot.data.map((r) => r.id));
    expect(viaPaginator.nextCursor).toEqual(oneShot.nextCursor);
    expect(paginator.size).toBe(50);
  });

  it("cursors are interchangeable between the paginator and the one-shot API", () => {
    const paginator = createCursorPaginator(rows);
    const page1 = paginator.page(undefined, 10);
    const page2OneShot = paginateWithCursor(
      rows,
      createCursorBasedRequest({ limit: 10, cursor: page1.nextCursor! })
    );
    const page2Paginator = paginator.page(page1.nextCursor!, 10);
    expect(page2Paginator.data.map((r) => r.id)).toEqual(page2OneShot.data.map((r) => r.id));
  });
});

describe("Integer-safety regressions (page/offset/limit normalization)", () => {
  const rows = makeRows(10);

  it("fractional page no longer returns wrong rows (was slice(1, 3) for page=1.5)", () => {
    const result = paginateWithPageBased(rows, {
      type: PaginationType.PAGE_BASED,
      page: 1.5,
      limit: 2,
    }) as PageBasedResult<Row>;

    // Previously: startIndex = 0.5 * 2 = 1 -> rows 2 and 3. Now truncated to page 1.
    expect(result.page).toBe(1);
    expect(result.data.map((r) => r.id)).toEqual([1, 2]);
  });

  it("NaN limit no longer produces NaN totalPages and an empty page", () => {
    const result = paginateWithPageBased(rows, {
      type: PaginationType.PAGE_BASED,
      page: 1,
      limit: Number.NaN,
    }) as PageBasedResult<Row>;

    expect(result.limit).toBe(10); // falls back to defaultLimit
    expect(Number.isNaN(result.totalPages)).toBe(false);
    expect(result.data).toHaveLength(10);
  });

  it("Infinity limit clamps to maxLimit instead of leaking through", () => {
    const result = paginateWithOffsetBased(
      rows,
      { type: PaginationType.OFFSET_BASED, offset: 0, limit: Number.POSITIVE_INFINITY },
      { defaultLimit: 3, maxLimit: 4 }
    ) as OffsetBasedResult<Row>;
    expect(result.limit).toBe(4);
  });

  it("fractional offset truncates deterministically", () => {
    const result = paginateWithOffsetBased(rows, {
      type: PaginationType.OFFSET_BASED,
      offset: 2.7,
      limit: 3,
    }) as OffsetBasedResult<Row>;
    expect(result.offset).toBe(2);
    expect(result.data.map((r) => r.id)).toEqual([3, 4, 5]);
  });

  it("fractional limit truncates instead of producing fractional slice bounds", () => {
    const result = paginateWithPageBased(rows, {
      type: PaginationType.PAGE_BASED,
      page: 2,
      limit: 2.9,
    }) as PageBasedResult<Row>;
    expect(result.limit).toBe(2);
    expect(result.data.map((r) => r.id)).toEqual([3, 4]);
  });
});
