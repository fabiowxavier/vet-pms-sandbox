/**
 * Verifies the read-only extraction API against a generated synthetic dataset
 * over HTTP, using the running app (pnpm dev or a production build).
 *
 *   pnpm synthetic:verify-api --preset sample-1m [--base-url http://localhost:3000] [--amend] [--concurrency]
 *
 * 1. Pages every extraction endpoint and checks for gaps and duplicates.
 * 2. Reconciles counts and financial totals with the dataset's answer key
 *    (read locally from synthetic-output/; the API never serves it).
 * 3. Checks that missing, invalid and under-scoped keys are refused.
 * 4. Checks that the key cannot read another practice's records.
 * 5. With --amend: through the application's own services (not SQL), creates
 *    a draft invoice and reads it back, then adds a note addendum, records a
 *    payment and edits the draft's lines, and checks that incremental
 *    extraction returns exactly those changes with the service's totals.
 * 6. With --concurrency: changes records during a paged extraction (an
 *    already-read invoice, a not-yet-read invoice, a change committed after
 *    the pass, a new draft) and shows what a single pass returns, what a naive
 *    watermark misses, and that an overlap window with de-duplication
 *    recovers the source state.
 * --amend and --concurrency modify the dataset: regenerate it afterwards with
 * `pnpm synthetic:generate --preset <name> --replace`.
 *
 * Temporary API keys are created for the synthetic practice only and are
 * deleted when the run ends.
 */
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import bcrypt from "bcryptjs";
import { sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import { assertSafeDatabaseTarget, parseSyntheticArgs } from "./config";
import type { ExpectedResults } from "./metrics";
import { findSyntheticPractices } from "./reset";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");
const EXTRACTION_SCOPES = ["records:read", "billing:read", "catalog:read", "inventory:read"];

type Json = Record<string, unknown>;
type Check = { name: string; ok: boolean; detail: string };

const ENDPOINTS = [
  { path: "soap-notes", scope: "records:read" },
  { path: "prescriptions", scope: "records:read" },
  { path: "invoices", scope: "billing:read" },
  { path: "invoice-lines", scope: "billing:read" },
  { path: "payments", scope: "billing:read" },
  { path: "invoice-adjustments", scope: "billing:read" },
  { path: "products", scope: "catalog:read" },
  { path: "services", scope: "catalog:read" },
  { path: "dispensing-events", scope: "inventory:read" },
  { path: "stock-movements", scope: "inventory:read" },
] as const;

function cents(value: unknown): number {
  return Math.round(Number(value ?? 0) * 100);
}
function money(c: number): string {
  return (c / 100).toFixed(2);
}

async function mintKey(db: Database, practiceId: string, scopes: string[]): Promise<{ id: string; raw: string }> {
  const raw = `ovpm_${randomUUID().replace(/-/g, "")}${randomUUID().replace(/-/g, "").slice(0, 8)}`;
  const hash = await bcrypt.hash(raw, 10);
  const [row] = (await db.execute(sql`
    insert into api_keys (practice_id, key_prefix, key_hash, name, scopes)
    values (${practiceId}::uuid, ${raw.slice(0, 12)}, ${hash}, 'synthetic verify-api (temporary)', ${JSON.stringify(scopes)}::jsonb)
    returning id::text as id
  `)) as unknown as { id: string }[];
  return { id: row!.id, raw };
}

export async function verifyApi(argv: string[]) {
  const today = new Date().toISOString().slice(0, 10);
  // Strip this command's own flags before the shared parser sees the rest.
  const rest: string[] = [];
  let baseUrl = "http://localhost:3000";
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--amend" || argv[i] === "--concurrency") continue;
    if (argv[i] === "--base-url") {
      baseUrl = argv[++i] ?? baseUrl;
      continue;
    }
    rest.push(argv[i]!);
  }
  baseUrl = baseUrl.replace(/\/$/, "");
  const args = parseSyntheticArgs(["validate", ...rest], today);
  const amend = argv.includes("--amend");
  const concurrency = argv.includes("--concurrency");

  const expectedPath = resolve(REPO_ROOT, args.outDir, "expected-results.json");
  if (!existsSync(expectedPath)) throw new Error(`No answer key at ${expectedPath}; generate the dataset first.`);
  const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as ExpectedResults;

  assertSafeDatabaseTarget(process.env.DATABASE_URL, process.env, args.allowRemoteDatabase);
  const { db } = await import("@openpims/db/client");
  const [practice] = await findSyntheticPractices(db, args.config.datasetId);
  if (!practice || practice.id !== expected.meta.practiceId) {
    throw new Error(`Synthetic dataset "${args.config.datasetId}" is not in this database (or does not match its answer key).`);
  }
  const others = (await findSyntheticPractices(db)).filter((p) => p.id !== practice.id);
  const otherPracticeIds = (
    (await db.execute(sql`select id::text as id from practices where id <> ${practice.id}::uuid and deleted_at is null`)) as unknown as { id: string }[]
  ).map((r) => r.id);

  const keys: { id: string }[] = [];
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  };

  try {
    const full = await mintKey(db, practice.id, EXTRACTION_SCOPES);
    const limited = await mintKey(db, practice.id, ["clients:read"]);
    keys.push(full, limited);

    const call = async (path: string, key: string | null): Promise<{ status: number; body: Json | null }> => {
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(`${baseUrl}/api/v1/${path}`, { headers: key ? { authorization: `Bearer ${key}` } : {} });
        if (res.status === 429 && attempt < 5) {
          // Respect the per-key rate limit rather than failing a long extraction.
          await new Promise((r) => setTimeout(r, Number(res.headers.get("retry-after") ?? "5") * 1000));
          continue;
        }
        return { status: res.status, body: (await res.json().catch(() => null)) as Json | null };
      }
    };
    const extractAll = async (path: string, query = "", limit = 100) => {
      const records: Json[] = [];
      let cursor: string | null = null;
      let total = -1;
      let pages = 0;
      do {
        const sep = query ? "&" : "";
        const { status, body } = await call(`${path}?${query}${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, full.raw);
        if (status !== 200 || !body) throw new Error(`${path} returned ${status}: ${JSON.stringify(body)}`);
        const pagination = body.pagination as { next_cursor: string | null; total: number };
        records.push(...(body.data as Json[]));
        total = pagination.total;
        cursor = pagination.next_cursor;
        pages++;
        if (pages > 100_000) throw new Error("Pagination did not terminate");
      } while (cursor);
      return { records, total, pages };
    };

    // 1. Complete, duplicate-free paging (two page sizes for the larger sets).
    const extracted: Record<string, Json[]> = {};
    for (const { path } of ENDPOINTS) {
      const run = await extractAll(path, "include_deleted=true");
      const ids = run.records.map((r) => r.id as string);
      const unique = new Set(ids);
      extracted[path] = run.records;
      const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
      const badTimestamps = run.records.filter((r) => !["created_at", "updated_at", "changed_at"].every((k) => ISO.test(String(r[k]))));
      if (badTimestamps.length) check(`format:${path}`, false, `${badTimestamps.length} records with non-ISO timestamps, e.g. ${String(badTimestamps[0]!.changed_at)}`);
      check(
        `paging:${path}`,
        unique.size === ids.length && ids.length === run.total,
        `${ids.length} records over ${run.pages} page(s); ${ids.length - unique.size} duplicate(s); total reported ${run.total}`,
      );
    }
    const odd = await extractAll("invoices", "include_deleted=true", 37);
    check(
      "paging:invoices@37",
      odd.records.length === extracted.invoices!.length &&
        new Set(odd.records.map((r) => r.id)).size === odd.records.length &&
        odd.records.every((r, i) => r.id === extracted.invoices![i]!.id),
      `${odd.records.length} records over ${odd.pages} pages of 37, same order as pages of 100`,
    );

    // 2. Reconcile with the answer key.
    const m = expected.metrics;
    const live = <T extends Json>(rows: T[]) => rows.filter((r) => r.deleted_at === null);
    const invoices = live(extracted.invoices!);
    const sumC = (rows: Json[], key: string) => rows.reduce((s, r) => s + cents(r[key]), 0);
    const reconcile: [string, unknown, unknown][] = [
      ["soap notes", extracted["soap-notes"]!.length, m.counts.soapNotes],
      ["prescriptions", extracted.prescriptions!.length, m.counts.prescriptions],
      ["written prescriptions", extracted.prescriptions!.filter((r) => r.supply === "written").length, m.counts["prescriptions.writtenScript"] ?? 0],
      ["invoices", invoices.length, m.counts.invoices],
      ["invoice lines (active)", live(extracted["invoice-lines"]!).length, m.counts.invoiceItems],
      ["lines embedded in invoices", invoices.reduce((s, r) => s + (r.lines as unknown[]).length, 0), m.counts.invoiceItems],
      ["payments", live(extracted.payments!).length, m.counts.payments],
      ["products", live(extracted.products!).length, Object.keys(m.inventory).length],
      ["dispensing events", extracted["dispensing-events"]!.length, (m.counts["prescriptionEvents.created"] ?? 0) - extracted.prescriptions!.filter((r) => r.supply === "written").length + (m.counts["prescriptionEvents.refill_dispensed"] ?? 0)],
      ["unbilled dispensing (pending)", extracted["dispensing-events"]!.filter((r) => (r.billing as Json).status === "pending").length, m.counts["dispenseCharges.pending"] ?? 0],
      ["invoice subtotal", money(sumC(invoices, "subtotal")), m.financial.invoices.subtotal],
      ["invoice tax", money(sumC(invoices, "tax")), m.financial.invoices.tax],
      ["invoice total", money(sumC(invoices, "total")), m.financial.invoices.total],
      ["invoice paid", money(sumC(invoices, "paid_amount")), m.financial.invoices.paid],
      ["payments total", money(sumC(live(extracted.payments!), "amount")), money(Object.values(m.financial.collectedByPaymentMonth).reduce((s, v) => s + cents(v), 0))],
    ];
    for (const status of Object.keys(m.financial.invoicesByStatus)) {
      reconcile.push([`invoices ${status} total`, money(sumC(invoices.filter((i) => i.status === status), "total")), m.financial.invoicesByStatus[status]!.total]);
    }
    for (const [method, v] of Object.entries(m.financial.paymentsByMethod)) {
      reconcile.push([`payments ${method}`, money(sumC(live(extracted.payments!).filter((p) => p.method === method), "amount")), v.amount]);
    }
    const bySku = new Map(live(extracted.products!).map((p) => [p.id as string, p.sku as string]));
    for (const [sku, inv] of Object.entries(m.inventory)) {
      const product = live(extracted.products!).find((p) => p.sku === sku);
      const moves = extracted["stock-movements"]!.filter((mv) => bySku.get(mv.product_id as string) === sku && mv.deleted_at === null && !mv.reversed);
      const qty = (type: string) => moves.filter((mv) => mv.movement_type === type).reduce((s, mv) => s + Number(mv.quantity_change), 0);
      reconcile.push([`${sku} closing stock`, product?.stock_quantity, inv.closing]);
      reconcile.push([`${sku} receipts`, qty("stock_adjustment"), inv.receipts]);
      reconcile.push([`${sku} dispensed`, -qty("dispensing"), inv.dispensed]);
      reconcile.push([`${sku} retail`, -qty("invoice_sale"), inv.retailSold]);
    }
    const mismatches = reconcile.filter(([, got, want]) => String(got) !== String(want));
    check(
      "reconcile:answer-key",
      mismatches.length === 0,
      mismatches.length ? mismatches.slice(0, 8).map(([k, g, w]) => `${k}: got ${g}, expected ${w}`).join("; ") : `${reconcile.length} counts and totals match`,
    );

    // 3. Authentication and scope enforcement.
    const authProblems: string[] = [];
    for (const { path } of ENDPOINTS) {
      const anon = await call(path, null);
      const bogus = await call(path, "ovpm_notarealkey000000000000000000000");
      const underScoped = await call(path, limited.raw);
      if (anon.status !== 401) authProblems.push(`${path} without key -> ${anon.status}`);
      if (bogus.status !== 401) authProblems.push(`${path} invalid key -> ${bogus.status}`);
      if (underScoped.status !== 403) authProblems.push(`${path} clients:read-only key -> ${underScoped.status}`);
    }
    check("auth:refusals", authProblems.length === 0, authProblems.length ? authProblems.join("; ") : `${ENDPOINTS.length} endpoints x (no key 401, invalid key 401, missing scope 403)`);

    // 4. Practice isolation.
    const isolationProblems: string[] = [];
    const ownIds = new Set<string>();
    for (const rows of Object.values(extracted)) for (const r of rows) ownIds.add(r.id as string);
    const foreignRows = (await db.execute(sql`
      select 'soap-notes' as path, id::text as id from soap_notes where practice_id <> ${practice.id}::uuid and status = 'finalized'
      union all select 'invoices', id::text from invoices where practice_id <> ${practice.id}::uuid
      union all select 'prescriptions', id::text from prescriptions where practice_id <> ${practice.id}::uuid
      union all select 'products', id::text from products where practice_id <> ${practice.id}::uuid
    `)) as unknown as { path: string; id: string }[];
    const leaked = foreignRows.filter((r) => ownIds.has(r.id));
    if (leaked.length) isolationProblems.push(`${leaked.length} foreign ids appeared in extraction`);
    for (const path of ["soap-notes", "invoices", "prescriptions"]) {
      const sample = foreignRows.find((r) => r.path === path);
      if (!sample) continue;
      const res = await call(`${path}/${sample.id}`, full.raw);
      if (res.status !== 404) isolationProblems.push(`${path}/${sample.id} of another practice -> ${res.status}`);
    }
    const foreignPatient = (await db.execute(sql`select id::text as id from patients where practice_id <> ${practice.id}::uuid limit 1`)) as unknown as { id: string }[];
    if (foreignPatient[0]) {
      const res = await call(`invoices?patient_id=${foreignPatient[0].id}`, full.raw);
      if ((res.body?.pagination as Json | undefined)?.total !== 0) isolationProblems.push("filtering by another practice's patient returned records");
    }
    check(
      "isolation:other-practices",
      isolationProblems.length === 0 && foreignRows.length > 0,
      isolationProblems.length
        ? isolationProblems.join("; ")
        : `${foreignRows.length} records of ${otherPracticeIds.length} other practice(s) (${others.length} synthetic) never appear; direct reads return 404`,
    );

    // 5 and 6 use the application's own services (tRPC procedures), not SQL.
    if (amend || concurrency) {
      const staff = (await db.execute(sql`
        select id::text as id, name, email, role::text as role from users
        where practice_id = ${practice.id}::uuid and role = 'admin' and deleted_at is null limit 1
      `)) as unknown as { id: string; name: string; email: string; role: string }[];
      const { billingRouter } = await import("@/server/routers/billing");
      const { recordsRouter } = await import("@/server/routers/records");
      const callers = (database: Database = db) => {
        const ctx = {
          db: database,
          session: {
            expires: new Date(Date.now() + 3_600_000).toISOString(),
            user: { id: staff[0]!.id, practiceId: practice.id, name: staff[0]!.name, email: staff[0]!.email, role: staff[0]!.role },
          },
        };
        return { billing: billingRouter.createCaller(ctx as never), records: recordsRouter.createCaller(ctx as never) };
      };
      const catalog = live(extracted.services!).filter((svc) => (svc.code as string).startsWith("SYN-EXAM") || (svc.code as string).startsWith("SYN-CYTO"));
      const patient = (await db.execute(sql`
        select id::text as id, client_id::text as client_id from patients where practice_id = ${practice.id}::uuid order by created_at, id limit 1
      `)) as unknown as { id: string; client_id: string }[];
      const draftInvoice = (services: Json[]) =>
        callers().billing.createInvoice({
          clientId: patient[0]!.client_id,
          patientId: patient[0]!.id,
          items: services.map((svc) => ({
            description: `${svc.name as string} (synthetic)`,
            quantity: 1,
            unitPrice: svc.default_price as string,
            itemType: "service" as const,
            itemId: svc.id as string,
          })),
        });
      const openInvoices = invoices.filter((i) => ["sent", "overdue"].includes(i.status as string) && cents(i.total) - cents(i.paid_amount) - cents(i.adjusted_amount) >= 100);
      const pay = (invoiceId: string, database?: Database) =>
        callers(database).billing.recordPayment({ invoiceId, operationId: randomUUID(), amount: "1.00", method: "cash", notes: "Synthetic payment (API verification)." });

      if (amend) {
        // A draft invoice, created and read back before the watermark.
        const draft = await draftInvoice(catalog.slice(0, 2));
        const initial = (await call(`invoices/${draft.id}`, full.raw)).body!.data as Json;
        const initialLines = (initial.lines as Json[]).map((l) => l.id as string).sort();
        const initialOk = initial.status === "draft" && initial.total === draft.total && initialLines.length === 2;
        check("workflow:draft-extracted", initialOk, `draft ${draft.id} via createInvoice: API total ${initial.total as string}, service total ${draft.total as string}, ${initialLines.length} lines`);

        const watermark = new Date().toISOString();
        const note = extracted["soap-notes"]!.find((n) => n.effective)!;
        const openInvoice = openInvoices[0]!;
        const addendumText = "Owner called: appetite back to normal. [Synthetic amendment for API verification.]";
        await callers().records.addSoapNoteAddendum({ patientId: note.patient_id as string, noteId: note.id as string, operationId: randomUUID(), content: addendumText });
        await pay(openInvoice.id as string);
        const current = await callers().billing.getInvoice({ id: draft.id });
        await callers().billing.updateInvoiceItems({
          id: draft.id,
          expectedUpdatedAt: current.updatedAt,
          items: [catalog[0]!, catalog[2] ?? catalog[1]!].map((svc, index) => ({
            description: `${svc.name as string} (synthetic, revised)`,
            quantity: index === 0 ? 2 : 1,
            unitPrice: svc.default_price as string,
            itemType: "service" as const,
            itemId: svc.id as string,
          })),
        });
        const revised = await callers().billing.getInvoice({ id: draft.id });

        const since = `updated_since=${encodeURIComponent(watermark)}`;
        const changedNotes = (await extractAll("soap-notes", since)).records;
        const changedInvoices = (await extractAll("invoices", `${since}&include_deleted=true`)).records;
        const changedPayments = (await extractAll("payments", since)).records;
        const changedLines = (await extractAll("invoice-lines", `${since}&include_deleted=true`)).records;
        const draftCopy = changedInvoices.find((i) => i.id === draft.id);
        const draftLines = changedLines.filter((l) => l.invoice_id === draft.id);
        const tombstones = draftLines.filter((l) => l.deleted_at !== null).map((l) => l.id as string).sort();
        const replacements = draftLines.filter((l) => l.deleted_at === null).map((l) => l.id as string).sort();
        const lineTotal = (draftCopy?.lines as Json[] | undefined)?.reduce((s, l) => s + cents(l.total), 0) ?? -1;
        const noteOk = changedNotes.length === 1 && changedNotes[0]!.id === note.id && (changedNotes[0]!.addenda as Json[]).some((a) => a.content === addendumText);
        const invoicesOk = changedInvoices.length === 2 && changedInvoices.some((i) => i.id === openInvoice.id) && !!draftCopy;
        const totalsOk = !!draftCopy && draftCopy.subtotal === revised.subtotal && draftCopy.tax === revised.tax && draftCopy.total === revised.total && money(lineTotal) === revised.subtotal;
        const linesOk =
          JSON.stringify(tombstones) === JSON.stringify(initialLines) &&
          JSON.stringify(replacements) === JSON.stringify(((draftCopy?.lines as Json[]) ?? []).map((l) => l.id as string).sort()) &&
          changedLines.length === draftLines.length;
        const paymentsOk = changedPayments.length === 1 && changedPayments[0]!.invoice_id === openInvoice.id && changedPayments[0]!.amount === "1.00";
        check(
          "workflow:incremental-amendments",
          noteOk && invoicesOk && totalsOk && linesOk && paymentsOk,
          `since ${watermark}: note addendum ${noteOk ? "seen" : "MISSING"}; invoices ${changedInvoices.length} (draft totals ${draftCopy?.subtotal as string}/${draftCopy?.tax as string}/${draftCopy?.total as string} vs service ${revised.subtotal}/${revised.tax}/${revised.total}); lines ${tombstones.length} tombstones + ${replacements.length} replacements; payments ${changedPayments.length}`,
        );
        const unchanged = (await extractAll("products", since)).records.length + (await extractAll("prescriptions", since)).records.length;
        check("workflow:no-false-positives", unchanged === 0, `${unchanged} unchanged products/prescriptions returned since the watermark`);
      }

      if (concurrency) {
        // A paged extraction while records change. Plan targets from the
        // current order so the "already read" and "not yet read" cases are real.
        const ordered = (await extractAll("invoices", "include_deleted=true")).records;
        const opens = ordered.filter((i) => openInvoices.some((o) => o.id === i.id));
        if (opens.length < 3) throw new Error("The dataset needs at least three open invoices for the concurrency check.");
        const pageSize = Math.min(100, Math.max(5, Math.ceil(ordered.length / 8))); // the API caps limit at 100
        const [early, later, held] = [opens[0]!, opens.at(-2)!, opens.at(-1)!];
        const position = (id: unknown) => ordered.findIndex((i) => i.id === id);
        if (Math.floor(position(early.id) / pageSize) >= Math.floor(position(later.id) / pageSize)) {
          throw new Error("Open invoices are too close together for this page size.");
        }
        const passStartedAt = new Date().toISOString();
        const seen: Json[] = [];
        let cursor: string | null = null;
        let triggered = false;
        let newDraftId = "";
        let releaseHeld!: () => void;
        let heldWritten!: () => void;
        const gate = new Promise<void>((resolve) => (releaseHeld = resolve));
        const written = new Promise<void>((resolve) => (heldWritten = resolve));
        let heldTx: Promise<void> | null = null;
        do {
          const { body } = await call(`invoices?include_deleted=true&limit=${pageSize}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, full.raw);
          seen.push(...(body!.data as Json[]));
          cursor = (body!.pagination as { next_cursor: string | null }).next_cursor;
          if (!triggered && seen.some((i) => i.id === early.id)) {
            triggered = true;
            await pay(early.id as string); // already read
            await pay(later.id as string); // not yet read
            heldTx = db.transaction(async (tx) => {
              await pay(held.id as string, tx as unknown as Database); // not yet read, committed after the pass
              heldWritten();
              await gate;
            });
            await written;
            newDraftId = (await draftInvoice(catalog.slice(0, 1))).id;
          }
        } while (cursor);
        releaseHeld();
        await heldTx;

        const times = (id: unknown) => seen.filter((i) => i.id === id).length;
        const heldCopy = seen.find((i) => i.id === held.id)!;
        const highest = seen.reduce((max, i) => ((i.changed_at as string) > max ? (i.changed_at as string) : max), "");
        const naive = (await extractAll("invoices", `updated_since=${encodeURIComponent(highest)}&include_deleted=true`)).records;
        const overlapSince = new Date(Date.parse(passStartedAt) - 5 * 60_000).toISOString();
        const overlap = (await extractAll("invoices", `updated_since=${encodeURIComponent(overlapSince)}&include_deleted=true`)).records;
        const merged = new Map<string, Json>();
        for (const record of [...ordered, ...seen, ...naive, ...overlap]) {
          const existing = merged.get(record.id as string);
          if (!existing || (record.changed_at as string) >= (existing.changed_at as string)) merged.set(record.id as string, record);
        }
        const source = (await db.execute(sql`
          select v.id::text as id, v.status::text as status, v.total::text as total, v.paid_amount::text as paid_amount,
            coalesce((select string_agg(i.id::text, ',' order by i.id::text) from invoice_items i where i.invoice_id = v.id and i.deleted_at is null), '') as line_ids
          from invoices v where v.practice_id = ${practice.id}::uuid
        `)) as unknown as { id: string; status: string; total: string; paid_amount: string; line_ids: string }[];
        const mismatched = source.filter((row) => {
          const copy = merged.get(row.id);
          const lines = ((copy?.lines as Json[] | undefined) ?? []).map((l) => l.id as string).sort().join(",");
          return !copy || copy.status !== row.status || copy.total !== row.total || copy.paid_amount !== row.paid_amount || lines !== row.line_ids;
        });
        check(
          "concurrency:during-pass",
          times(early.id) === 2 && times(later.id) === 1 && times(newDraftId) === 1 && times(held.id) === 1 && heldCopy.paid_amount === held.paid_amount,
          `page size ${pageSize}: amended-after-read returned ${times(early.id)}x (duplicate), amended-before-read ${times(later.id)}x, created-during-pass ${times(newDraftId)}x, late commit returned ${times(held.id)}x with stale paid_amount ${heldCopy.paid_amount as string}`,
        );
        check(
          "concurrency:naive-watermark-gap",
          !naive.some((i) => i.id === held.id),
          `updated_since=highest changed_at seen (${highest}) ${naive.some((i) => i.id === held.id) ? "returned" : "missed"} the late-committed payment (documented limitation)`,
        );
        check(
          "concurrency:overlap-recovers",
          overlap.some((i) => i.id === held.id) && mismatched.length === 0 && merged.size === source.length,
          `updated_since=pass start - 5 min returned ${overlap.length} records; after de-duplicating by latest changed_at the copy has ${merged.size} invoices, ${mismatched.length} differing from the source`,
        );
      }
      console.log(`Dataset "${args.config.datasetId}" was amended. Regenerate it: pnpm synthetic:generate --preset ${args.config.datasetId} --replace`);
    }
  } finally {
    for (const key of keys) await db.execute(sql`delete from api_keys where id = ${key.id}::uuid`);
  }
  const ok = checks.every((c) => c.ok);
  console.log(`${ok ? "API VERIFIED" : "API CHECKS FAILED"}: ${checks.filter((c) => c.ok).length}/${checks.length} checks passed.`);
  return ok;
}
