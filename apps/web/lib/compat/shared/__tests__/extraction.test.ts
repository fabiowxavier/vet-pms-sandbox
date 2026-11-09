import { afterEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const mocks = vi.hoisted(() => ({
  authenticateApiKey: vi.fn(),
  executed: [] as unknown[],
  results: [] as unknown[][],
}));

vi.mock("@/lib/api-auth", () => ({ authenticateApiKey: mocks.authenticateApiKey }));
vi.mock("@openpims/db/client", () => ({ db: {} }));
vi.mock("@/lib/tenant-db", () => ({
  withTenant: async (_db: unknown, _practiceId: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      execute: async (query: unknown) => {
        mocks.executed.push(query);
        return mocks.results.shift() ?? [];
      },
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: PRACTICE_ID }] }) }) }),
    }),
}));

const { decodeCursor, encodeCursor, parseExtractionParams, listRoute, getRoute } = await import("../extraction");
const { invoicesResource, soapNotesResource, prescriptionsResource, dispensingEventsResource } = await import(
  "../../openvpm/extraction-resources"
);

const PRACTICE_ID = "00000000-0000-0000-0000-000000000001";
const ID = "00000000-0000-4000-8000-000000000002";
const dialect = new PgDialect();
const render = (query: unknown) => dialect.sqlToQuery(query as SQL);

function request(path: string) {
  return new Request(`https://openvpm.test${path}`, { headers: { authorization: "Bearer ovpm_test" } });
}

function authorize(scopes: string[]) {
  mocks.authenticateApiKey.mockImplementation(async (_req: Request, scope: string) =>
    scopes.includes(scope) || scopes.includes("*")
      ? { ok: true, ctx: { practiceId: PRACTICE_ID, apiKeyId: "key", scopes } }
      : { ok: false, response: Response.json({ error: { message: `API key missing required scope: ${scope}` } }, { status: 403 }) },
  );
}

afterEach(() => {
  mocks.executed.length = 0;
  mocks.results.length = 0;
  mocks.authenticateApiKey.mockReset();
});

describe("extraction parameters", () => {
  it("round-trips cursors and rejects tampered ones", () => {
    const cursor = encodeCursor("2026-10-01T13:00:00.123456Z", ID);
    expect(decodeCursor(cursor)).toEqual({ changedAt: "2026-10-01T13:00:00.123456Z", id: ID });
    expect(decodeCursor("not-a-cursor")).toBeNull();
    const injected = Buffer.from(JSON.stringify({ t: "2026-10-01'; drop table invoices;--", i: ID })).toString("base64url");
    expect(decodeCursor(injected)).toBeNull();
  });

  it("validates limit, updated_since, include_deleted, filters and refuses offset", () => {
    const parse = (q: string) => parseExtractionParams(new URLSearchParams(q), ["patient_id"]);
    expect(parse("limit=500").ok && parse("limit=500")).toMatchObject({ params: { limit: 100 } });
    expect(parse("limit=0").ok).toBe(false);
    expect(parse("offset=10").ok).toBe(false);
    expect(parse("updated_since=yesterday").ok).toBe(false);
    expect(parse("updated_since=2026-10-01T09:00:00-04:00").ok).toBe(true);
    expect(parse("updated_since=2026-10-01")).toMatchObject({ params: { updatedSince: "2026-10-01T00:00:00Z" } });
    expect(parse("include_deleted=yes").ok).toBe(false);
    expect(parse("patient_id=nope").ok).toBe(false);
    expect(parse("unknown_filter=1").ok).toBe(true);
  });
});

describe("extraction routes", () => {
  it("refuses a key without the resource scope", async () => {
    authorize(["clients:read"]);
    const res = await listRoute(invoicesResource)(request("/api/v1/invoices"));
    expect(res.status).toBe(403);
    expect(mocks.executed).toHaveLength(0);
  });

  it("returns 400 for invalid parameters before touching the database", async () => {
    authorize(["billing:read"]);
    const res = await listRoute(invoicesResource)(request("/api/v1/invoices?cursor=garbage"));
    expect(res.status).toBe(400);
    expect(mocks.executed).toHaveLength(0);
  });

  it("pages by (changed_at, id), scopes to the practice, and emits a next cursor", async () => {
    authorize(["billing:read"]);
    const row = (n: number) => ({
      id: `00000000-0000-4000-8000-00000000000${n}`,
      cursor_changed_at: `2026-10-0${n}T10:00:00.000000Z`,
      changed_at: new Date(`2026-10-0${n}T10:00:00Z`),
      created_at: new Date("2026-10-01T10:00:00Z"),
      updated_at: new Date("2026-10-01T10:00:00Z"),
      deleted_at: null,
      lines: [],
    });
    mocks.results.push([row(1), row(2), row(3)], [{ total: 7 }]);
    const res = await listRoute(invoicesResource)(
      request(`/api/v1/invoices?limit=2&updated_since=2026-10-01T00:00:00Z&patient_id=${ID}`),
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(2);
    expect(body.pagination).toMatchObject({ limit: 2, has_more: true, total: 7 });
    expect(decodeCursor(body.pagination.next_cursor)).toEqual({ changedAt: "2026-10-02T10:00:00.000000Z", id: row(2).id });

    const { sql: text, params } = render(mocks.executed[0]);
    expect(text).toContain("order by q.changed_at, q.id");
    expect(text).toContain("q.deleted_at is null");
    expect(text).toContain('"q"."patient_id" = $');
    expect(params).toContain(PRACTICE_ID);
    expect(params).toContain(3); // limit + 1 probe row
  });

  it("applies the cursor as a strict keyset bound", async () => {
    authorize(["records:read"]);
    mocks.results.push([], [{ total: 0 }]);
    const cursor = encodeCursor("2026-10-02T10:00:00.000000Z", ID);
    await listRoute(soapNotesResource)(request(`/api/v1/soap-notes?cursor=${cursor}`));
    const { sql: text, params } = render(mocks.executed[0]);
    expect(text).toContain("(q.changed_at, q.id) > (");
    expect(params).toEqual(expect.arrayContaining(["2026-10-02T10:00:00.000000Z", ID]));
  });

  it("returns 404 for ids outside the practice and validates ids", async () => {
    authorize(["records:read"]);
    mocks.results.push([]);
    const route = getRoute(prescriptionsResource);
    expect((await route(request(`/api/v1/prescriptions/${ID}`), { params: Promise.resolve({ id: ID }) })).status).toBe(404);
    expect((await route(request("/api/v1/prescriptions/x"), { params: Promise.resolve({ id: "x" }) })).status).toBe(400);
  });
});

describe("resource contracts", () => {
  it("keeps prescriptions and dispensing distinct", () => {
    const rx = prescriptionsResource.map({ id: ID, product_id: null, quantity: "10.000", events: [], created_at: null, updated_at: null, deleted_at: null, changed_at: null }) as Record<string, unknown>;
    expect(rx.supply).toBe("written");
    expect(rx.quantity).toBe(10);
    expect(prescriptionsResource.scope).toBe("records:read");
    expect(dispensingEventsResource.scope).toBe("inventory:read");
    const rendered = render(dispensingEventsResource.base(PRACTICE_ID)).sql;
    expect(rendered).toContain("e.product_id is not null");
    expect(rendered).toContain("'refill_dispensed'");
  });

  it("derives note and invoice change times from their children", () => {
    const note = render(soapNotesResource.base(PRACTICE_ID)).sql;
    expect(note).toMatch(/greatest\(\s*n\.updated_at/);
    expect(note).toContain("soap_note_addenda");
    expect(note).toContain("n.status = 'finalized'");
    const invoice = render(invoicesResource.base(PRACTICE_ID)).sql;
    expect(invoice).toContain("max(i.updated_at) from invoice_items");
    expect(invoice).toContain("max(p.updated_at) from payments");
  });
});
