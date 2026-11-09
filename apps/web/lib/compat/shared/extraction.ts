import { sql, type SQL } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@openpims/db/client";
import type { Database } from "@openpims/db/client";
import { authenticateApiKey } from "@/lib/api-auth";
import { withTenant } from "@/lib/tenant-db";
import { assertActivePractice } from "./active-practice";
import { apiError, notFound, withErrorHandling } from "./errors";
import { DEFAULT_LIMIT, MAX_LIMIT } from "./pagination";
import { isUuid } from "./validation";

/**
 * Read-only extraction endpoints (notes, billing, catalogue, prescriptions,
 * dispensing, stock). Unlike the offset-paged list endpoints, these use a
 * keyset cursor over (changed_at, id), so paging through a changing table never
 * skips or repeats a record because of shifting offsets, and the same cursor
 * position supports incremental extraction with `updated_since`.
 *
 * `changed_at` is the latest time the record or anything that belongs to it
 * changed (for example a SOAP note's addenda, or an invoice's lines and
 * payments). Each resource defines it in its base query.
 */

export type ExtractionParams = {
  limit: number;
  cursor: { changedAt: string; id: string } | null;
  updatedSince: string | null;
  includeDeleted: boolean;
  filters: Record<string, string>;
};

const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const OFFSET_TIMESTAMP = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2}))?$/;

export function encodeCursor(changedAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ t: changedAt, i: id }), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): { changedAt: string; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { t?: unknown; i?: unknown };
    if (typeof parsed.t !== "string" || typeof parsed.i !== "string") return null;
    if (!CURSOR_TIMESTAMP.test(parsed.t) || !isUuid(parsed.i)) return null;
    return { changedAt: parsed.t, id: parsed.i };
  } catch {
    return null;
  }
}

/** Parse shared query parameters; returns an error message for bad input. */
export function parseExtractionParams(
  searchParams: URLSearchParams,
  allowedFilters: readonly string[],
): { ok: true; params: ExtractionParams } | { ok: false; message: string } {
  const rawLimit = searchParams.get("limit");
  let limit = DEFAULT_LIMIT;
  if (rawLimit !== null) {
    const value = Number(rawLimit);
    if (!Number.isInteger(value) || value < 1) return { ok: false, message: "limit must be a positive integer" };
    limit = Math.min(value, MAX_LIMIT);
  }

  const rawCursor = searchParams.get("cursor");
  const cursor = rawCursor ? decodeCursor(rawCursor) : null;
  if (rawCursor && !cursor) return { ok: false, message: "cursor is invalid; use next_cursor from a previous page" };

  if (searchParams.has("offset")) {
    return { ok: false, message: "offset is not supported on this endpoint; page with cursor" };
  }

  const rawSince = searchParams.get("updated_since");
  let updatedSince: string | null = null;
  if (rawSince !== null) {
    if (!OFFSET_TIMESTAMP.test(rawSince) || Number.isNaN(Date.parse(rawSince))) {
      return { ok: false, message: "updated_since must be an ISO date or timezone-qualified ISO timestamp" };
    }
    updatedSince = rawSince.length === 10 ? `${rawSince}T00:00:00Z` : rawSince;
  }

  const rawDeleted = searchParams.get("include_deleted");
  if (rawDeleted !== null && rawDeleted !== "true" && rawDeleted !== "false") {
    return { ok: false, message: "include_deleted must be true or false" };
  }

  const filters: Record<string, string> = {};
  for (const name of allowedFilters) {
    const value = searchParams.get(name);
    if (value === null) continue;
    if (!isUuid(value)) return { ok: false, message: `${name} must be a valid UUID` };
    filters[name] = value;
  }

  return { ok: true, params: { limit, cursor, updatedSince, includeDeleted: rawDeleted === "true", filters } };
}

/** ISO-8601 (millisecond, UTC) rendering used inside nested JSON. */
export function isoSql(column: SQL): SQL {
  return sql`to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
}

export type ExtractionResource<Row> = {
  /** Required API-key scope, e.g. "billing:read". */
  scope: string;
  /** Singular name for 404 messages. */
  name: string;
  /** Filters accepted as `?name=<uuid>`, matched against same-named base columns. */
  filters?: readonly string[];
  /**
   * Base query scoped to the practice. Must select `id`, `changed_at` and
   * `deleted_at` (timestamptz or null), plus the resource's columns.
   */
  base: (practiceId: string) => SQL;
  map: (row: Row) => unknown;
};

function whereClauses(params: ExtractionParams, withCursor: boolean): SQL {
  const parts: SQL[] = [sql`true`];
  if (!params.includeDeleted) parts.push(sql`q.deleted_at is null`);
  if (params.updatedSince) parts.push(sql`q.changed_at >= ${params.updatedSince}::timestamptz`);
  for (const [name, value] of Object.entries(params.filters)) {
    parts.push(sql`${sql.identifier("q")}.${sql.identifier(name)} = ${value}::uuid`);
  }
  if (withCursor && params.cursor) {
    parts.push(sql`(q.changed_at, q.id) > (${params.cursor.changedAt}::timestamptz, ${params.cursor.id}::uuid)`);
  }
  return sql.join(parts, sql` and `);
}

export async function listResource<Row>(
  tx: Database,
  practiceId: string,
  resource: ExtractionResource<Row>,
  params: ExtractionParams,
) {
  const base = resource.base(practiceId);
  const rows = (await tx.execute(sql`
    select q.*, to_char(q.changed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as cursor_changed_at
    from (${base}) q
    where ${whereClauses(params, true)}
    order by q.changed_at, q.id
    limit ${params.limit + 1}
  `)) as unknown as (Row & { id: string; cursor_changed_at: string })[];
  const [count] = (await tx.execute(sql`
    select count(*)::int as total from (${base}) q where ${whereClauses(params, false)}
  `)) as unknown as { total: number }[];

  const hasMore = rows.length > params.limit;
  const page = hasMore ? rows.slice(0, params.limit) : rows;
  const last = page.at(-1);
  return {
    data: page.map((row) => resource.map(row)),
    pagination: {
      limit: params.limit,
      next_cursor: hasMore && last ? encodeCursor(last.cursor_changed_at, last.id) : null,
      has_more: hasMore,
      total: count?.total ?? 0,
    },
  };
}

/** GET handler for a list endpoint. */
export function listRoute<Row>(resource: ExtractionResource<Row>) {
  return async function GET(req: Request) {
    const auth = await authenticateApiKey(req, resource.scope);
    if (!auth.ok) return auth.response;
    const parsed = parseExtractionParams(new URL(req.url).searchParams, resource.filters ?? []);
    if (!parsed.ok) return apiError(parsed.message, 400);

    return withErrorHandling(() =>
      withTenant(db, auth.ctx.practiceId, async (tx) => {
        const active = await assertActivePractice(tx, auth.ctx.practiceId);
        if (!active.ok) return active.response;
        return NextResponse.json(await listResource(tx, auth.ctx.practiceId, resource, parsed.params));
      }),
    );
  };
}

/** GET handler for a single record by id (soft-deleted records only with include_deleted=true). */
export function getRoute<Row>(resource: ExtractionResource<Row>) {
  return async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
    const { id } = await params;
    const auth = await authenticateApiKey(req, resource.scope);
    if (!auth.ok) return auth.response;
    if (!isUuid(id)) return apiError(`${resource.name} id must be a valid UUID`, 400);
    const includeDeleted = new URL(req.url).searchParams.get("include_deleted") === "true";

    return withErrorHandling(() =>
      withTenant(db, auth.ctx.practiceId, async (tx) => {
        const active = await assertActivePractice(tx, auth.ctx.practiceId);
        if (!active.ok) return active.response;
        const [row] = (await tx.execute(sql`
          select q.* from (${resource.base(auth.ctx.practiceId)}) q
          where q.id = ${id}::uuid ${includeDeleted ? sql`` : sql`and q.deleted_at is null`}
          limit 1
        `)) as unknown as Row[];
        if (!row) return notFound(resource.name);
        return NextResponse.json({ data: resource.map(row) });
      }),
    );
  };
}
