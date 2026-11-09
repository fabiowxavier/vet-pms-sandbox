/**
 * Verifies the read-only extraction API against a generated synthetic dataset
 * over HTTP, using the running app (pnpm dev or a production build).
 *
 *   pnpm synthetic:verify-api --preset sample-1m [--base-url http://localhost:3000] [--amend]
 *
 * 1. Pages every extraction endpoint and checks for gaps and duplicates.
 * 2. Reconciles counts and financial totals with the dataset's answer key
 *    (read locally from synthetic-output/; the API never serves it).
 * 3. Checks that missing, invalid and under-scoped keys are refused.
 * 4. Checks that the key cannot read another practice's records.
 * 5. With --amend: adds a note addendum, a payment and an invoice-line
 *    replacement, then checks that incremental extraction returns exactly
 *    those changes. This modifies the dataset: regenerate it afterwards with
 *    `pnpm synthetic:generate --preset <name> --replace`.
 *
 * Temporary API keys are created for the synthetic practice only and are
 * deleted when the run ends.
 */
import { createHash, randomUUID } from "node:crypto";
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
    if (argv[i] === "--amend") continue;
    if (argv[i] === "--base-url") {
      baseUrl = argv[++i] ?? baseUrl;
      continue;
    }
    rest.push(argv[i]!);
  }
  baseUrl = baseUrl.replace(/\/$/, "");
  const args = parseSyntheticArgs(["validate", ...rest], today);
  const amend = argv.includes("--amend");

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

    // 5. Incremental extraction detects amendments.
    if (amend) {
      const watermark = new Date(Date.now() - 1000).toISOString();
      const note = extracted["soap-notes"]!.find((n) => n.effective)!;
      const openInvoice = invoices.find((i) => i.status !== "paid" && cents(i.total) - cents(i.paid_amount) >= 100)!;
      const lineInvoice = invoices.find((i) => i.id !== openInvoice.id && (i.lines as unknown[]).length > 0 && i.status !== "void")!;
      const actor = (await db.execute(sql`select id::text as id, name from users where practice_id = ${practice.id}::uuid and role = 'veterinarian' limit 1`)) as unknown as { id: string; name: string }[];
      const operationId = randomUUID();
      const addendumText = "Owner called: appetite back to normal. [Synthetic amendment for API verification.]";
      // Raw SQL parameters need an explicit ISO string; a Date would be sent as Date#toString().
      const now = new Date().toISOString();
      // The database guard checks the same payload hash the app's addendum service writes.
      const addendumHash = createHash("sha256")
        .update(JSON.stringify({ noteId: note.id, authorId: actor[0]!.id, content: addendumText }))
        .digest("hex");
      await db.transaction(async (tx) => {
        await tx.execute(sql`
          insert into soap_note_addenda (practice_id, soap_note_id, author_id, author_name, content, operation_id, operation_payload_hash, created_at)
          values (${practice.id}::uuid, ${note.id as string}::uuid, ${actor[0]!.id}::uuid, ${actor[0]!.name}, ${addendumText},
            ${operationId}::uuid, ${addendumHash}, ${now}::timestamptz)`);
        // A partial payment, as recordPayment writes it.
        await tx.execute(sql`
          insert into payments (invoice_id, amount, method, received_at, notes, external_id, created_at, updated_at)
          values (${openInvoice.id as string}::uuid, 1.00, 'cash', ${now}::timestamptz, 'Synthetic payment (API verification).',
            ${`dashboard-payment:${practice.id}:${randomUUID()}`}, ${now}::timestamptz, ${now}::timestamptz)`);
        await tx.execute(sql`update invoices set paid_amount = paid_amount + 1.00, updated_at = ${now}::timestamptz where id = ${openInvoice.id as string}::uuid`);
        // Re-save of invoice lines as the draft-invoice editor does: soft-delete
        // the current lines and insert replacements with new ids.
        await tx.execute(sql`update invoice_items set deleted_at = ${now}::timestamptz, updated_at = ${now}::timestamptz where invoice_id = ${lineInvoice.id as string}::uuid and deleted_at is null and source_dispense_charge_id is null`);
        await tx.execute(sql`
          insert into invoice_items (invoice_id, description, quantity, unit_price, total, item_type, item_id, taxable, created_at, updated_at)
          select invoice_id, description, quantity, unit_price, total, item_type, item_id, taxable, ${now}::timestamptz, ${now}::timestamptz
          from invoice_items where invoice_id = ${lineInvoice.id as string}::uuid and deleted_at = ${now}::timestamptz`);
      });
      const since = `updated_since=${encodeURIComponent(watermark)}`;
      const changedNotes = (await extractAll("soap-notes", since)).records;
      const changedInvoices = (await extractAll("invoices", since)).records;
      const changedPayments = (await extractAll("payments", since)).records;
      const changedLines = (await extractAll("invoice-lines", `${since}&include_deleted=true`)).records;
      const replacedCount = (lineInvoice.lines as Json[]).filter((l) => !l.source_dispense_charge_id).length;
      const noteOk = changedNotes.length === 1 && changedNotes[0]!.id === note.id && (changedNotes[0]!.addenda as Json[]).some((a) => a.content === addendumText);
      const invoiceIds = new Set(changedInvoices.map((i) => i.id));
      const invoicesOk = changedInvoices.length === 2 && invoiceIds.has(openInvoice.id) && invoiceIds.has(lineInvoice.id);
      const paymentsOk = changedPayments.length === 1 && changedPayments[0]!.invoice_id === openInvoice.id;
      const tombstones = changedLines.filter((l) => l.deleted_at !== null).length;
      const linesOk = tombstones === replacedCount && changedLines.length === replacedCount * 2;
      check(
        "incremental:amendments",
        noteOk && invoicesOk && paymentsOk && linesOk,
        `since ${watermark}: notes ${changedNotes.length} (addendum ${noteOk ? "seen" : "MISSING"}), invoices ${changedInvoices.length}, payments ${changedPayments.length}, lines ${changedLines.length} (${tombstones} tombstones for ${replacedCount} replaced)`,
      );
      const unchanged = (await extractAll("products", since)).records.length + (await extractAll("prescriptions", since)).records.length;
      check("incremental:no-false-positives", unchanged === 0, `${unchanged} unchanged products/prescriptions returned since the watermark`);
      console.log(`Dataset "${args.config.datasetId}" was amended. Regenerate it: pnpm synthetic:generate --preset ${args.config.datasetId} --replace`);
    }
  } finally {
    for (const key of keys) await db.execute(sql`delete from api_keys where id = ${key.id}::uuid`);
  }
  const ok = checks.every((c) => c.ok);
  console.log(`${ok ? "API VERIFIED" : "API CHECKS FAILED"}: ${checks.filter((c) => c.ok).length}/${checks.length} checks passed.`);
  return ok;
}
