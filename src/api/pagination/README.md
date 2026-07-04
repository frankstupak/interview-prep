# Pagination

Page-based and offset-based pagination with a Fastify REST API. Part of the
[API Patterns Sandbox](../../../README.md).

## Quick start

From repo root:

```bash
npm run pagination:dev    # Port 3001
npm run pagination:test
npm run pagination:build
```

## Strategies

### Page-based

- **What:** Request by `page` and `limit`; response includes `totalPages`,
  `hasNextPage`, etc.
- **Pros:** Intuitive for UIs; users think in “page 1, 2, 3.”
- **Cons:** Expensive with large offsets (OFFSET/LIMIT); result sets can shift
  during pagination.
- **When:** User-facing lists, dashboards, admin UIs.

### Offset-based

- **What:** Request by `offset` and `limit`; response includes `hasMore`.
- **Pros:** Stable performance; no total count needed; good for APIs and
  infinite scroll.
- **Cons:** No “page number” concept; less intuitive for some UIs. Rows
  inserted/deleted between requests shift every offset — clients see
  duplicated or silently skipped rows.
- **When:** Public APIs, mobile infinite scroll, data exports, large datasets.

### Cursor-based (keyset)

- **What:** Request by opaque `cursor` + `limit`; response includes
  `nextCursor`, `prevCursor`, `hasMore`. The pattern used by Stripe, Slack
  and GitHub.
- **How:** The cursor encodes the last item's `(sortBy value, id)` tuple;
  the next page seeks strictly past that anchor (binary search, O(log n))
  instead of counting rows. `id` is always the tiebreaker, so non-unique
  sort fields never skip or duplicate rows at page boundaries.
- **Pros:** Immune to insert/delete drift — no dup/skip rows while
  paginating live data. Cursors are scoped to their sort + filter; replaying
  one against a different scope returns a clear 400 instead of wrong rows.
  Works even if the anchor row was deleted.
- **Cons:** No random page access; forward/backward only.
- **When:** Live feeds, sync jobs, anything paginating data that changes.

Benchmark (`npm run bench`, 1M rows, 100/page): binary-search seek sweeps
all 10,000 pages in ~112ms vs ~17.9s for a naive linear-seek cursor
implementation (~160x); a single page at 90% depth is ~430x faster.

## Endpoints

| Endpoint                  | Method | Description                |
| ------------------------- | ------ | -------------------------- |
| `/health`                 | GET    | Health check               |
| `/employees/page-based`   | GET    | Page-based pagination      |
| `/employees/offset-based` | GET    | Offset-based pagination    |
| `/employees/cursor-based` | GET    | Cursor (keyset) pagination |
| `/employees/paginate`     | GET    | Generic (type in query)    |
| `/employees/stats`        | GET    | Dataset statistics         |

Query params: `page`, `limit`, `offset`, `cursor`, `sortBy`, `sortDirection`,
`department` (filter). Config: `defaultLimit`, `maxLimit`. Numeric params are
strictly validated — `page=5abc` or `page=1.5` return 400 instead of being
silently coerced.

## Project structure

```text
src/
├── pagination-types.ts
├── pagination-methods.ts
├── pagination.ts
├── server.ts
├── pagination.test.ts
└── fake-data.json
```
