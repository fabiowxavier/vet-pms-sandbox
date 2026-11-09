/**
 * Validates a generated dataset against its expected-results file.
 *
 * 1. Recomputes every metric with SQL (independently of the planner) and
 *    compares it exactly with the answer key.
 * 2. Runs invariant checks that hold for any correct dataset: invoice
 *    arithmetic, payments vs paid amounts, dispense ledger links, stock
 *    reconciliation, historical timestamps, closeouts, labels.
 * 3. Runs SQL discrepancy detectors that must find exactly the deliberately
 *    planted discrepancies and nothing else.
 */
import { sql, type SQL } from "drizzle-orm";
import type { Database } from "@openpims/db/client";
import type { ExpectedResults, Metrics, MoneySummary } from "./metrics";
import { LONG_NOTE_THRESHOLD } from "./plan";

type Row = Record<string, unknown>;

async function q<T extends Row = Row>(db: Database, query: SQL): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

function money(alias: string, expression: string) {
  return `coalesce(sum(${expression}), 0)::numeric(14,2)::text as "${alias}"`;
}

async function moneySummaries(db: Database, practiceId: string, groupBy: string | null): Promise<Record<string, MoneySummary>> {
  const rows = await q<{ key: string; count: number; subtotal: string; tax: string; total: string; paid: string; outstanding: string }>(
    db,
    sql.raw(`
      select ${groupBy ?? "'all'"}::text as key, count(*)::int as count,
        ${money("subtotal", "subtotal")}, ${money("tax", "tax")}, ${money("total", "total")},
        ${money("paid", "paid_amount")}, ${money("outstanding", "total - paid_amount")}
      from invoices where practice_id = '${practiceId}'::uuid and deleted_at is null
      ${groupBy ? `group by ${groupBy}` : ""}
    `),
  );
  return Object.fromEntries(rows.map(({ key, ...rest }) => [key, rest]));
}

async function grouped(db: Database, prefix: string, query: string): Promise<Record<string, number>> {
  const rows = await q<{ key: string; n: number }>(db, sql.raw(query));
  return Object.fromEntries(rows.map((r) => [`${prefix}.${r.key}`, r.n]));
}

export async function metricsFromDatabase(db: Database, practiceId: string, timeZone: string): Promise<Metrics> {
  const p = `'${practiceId}'::uuid`;
  const tz = timeZone.replace(/'/g, "");
  const count = async (query: string) => (await q<{ n: number }>(db, sql.raw(query)))[0]!.n;
  const invoiceScope = `invoice_id in (select id from invoices where practice_id = ${p})`;

  const counts: Record<string, number> = {
    clients: await count(`select count(*)::int as n from clients where practice_id = ${p}`),
    patients: await count(`select count(*)::int as n from patients where practice_id = ${p}`),
    appointments: await count(`select count(*)::int as n from appointments where practice_id = ${p}`),
    soapNotes: await count(`select count(*)::int as n from soap_notes where practice_id = ${p}`),
    vaccinations: await count(`select count(*)::int as n from vaccination_records where practice_id = ${p}`),
    labResults: await count(`select count(*)::int as n from lab_results where practice_id = ${p}`),
    problems: await count(`select count(*)::int as n from problem_list where practice_id = ${p}`),
    prescriptions: await count(`select count(*)::int as n from prescriptions where practice_id = ${p}`),
    invoices: await count(`select count(*)::int as n from invoices where practice_id = ${p}`),
    invoiceItems: await count(`select count(*)::int as n from invoice_items where ${invoiceScope}`),
    payments: await count(`select count(*)::int as n from payments where ${invoiceScope}`),
    visitCloseouts: await count(`select count(*)::int as n from visit_closeouts where practice_id = ${p}`),
    patientWeights: await count(`select count(*)::int as n from patient_weights where patient_id in (select id from patients where practice_id = ${p})`),
    stockAdjustments: await count(`select count(*)::int as n from inventory_stock_adjustments where practice_id = ${p}`),
    ...(await grouped(db, "patients.species", `select species::text as key, count(*)::int as n from patients where practice_id = ${p} group by 1`)),
    ...(await grouped(db, "staff", `select role::text as key, count(*)::int as n from users where practice_id = ${p} group by 1`)),
    ...(await grouped(db, "appointments.status", `select status::text as key, count(*)::int as n from appointments where practice_id = ${p} group by 1`)),
    ...(await grouped(db, "appointments.type", `select t.name as key, count(*)::int as n from appointments a join appointment_types t on t.id = a.type_id where a.practice_id = ${p} group by 1`)),
    ...(await grouped(
      db,
      "soapNotes",
      `select case when char_length(coalesce(subjective,'')) + char_length(coalesce(objective,'')) + char_length(coalesce(assessment,'')) + char_length(coalesce(plan,'')) >= ${LONG_NOTE_THRESHOLD} then 'long' else 'short' end as key, count(*)::int as n from soap_notes where practice_id = ${p} group by 1`,
    )),
    ...(await grouped(db, "labResults.status", `select status::text as key, count(*)::int as n from lab_results where practice_id = ${p} group by 1`)),
    ...(await grouped(db, "prescriptions", `select case when product_id is null then 'writtenScript' else 'dispensedFromClinicStock' end as key, count(*)::int as n from prescriptions where practice_id = ${p} group by 1`)),
    ...(await grouped(db, "prescriptions.status", `select status::text as key, count(*)::int as n from prescriptions where practice_id = ${p} group by 1`)),
    ...(await grouped(db, "prescriptionEvents", `select event_type::text as key, count(*)::int as n from prescription_events where practice_id = ${p} group by 1`)),
    ...(await grouped(db, "dispenseCharges", `select status::text as key, count(*)::int as n from dispense_charge_queue where practice_id = ${p} group by 1`)),
    ...(await grouped(db, "invoices.status", `select status::text as key, count(*)::int as n from invoices where practice_id = ${p} group by 1`)),
    ...(await grouped(db, "invoices", `select case when appointment_id is null then 'counter' else 'visit' end as key, count(*)::int as n from invoices where practice_id = ${p} group by 1`)),
    ...(await grouped(
      db,
      "invoiceItems",
      `select case when item_type = 'service' then 'service' when source_dispense_charge_id is not null then 'productDispensed' else 'productRetail' end as key, count(*)::int as n from invoice_items where ${invoiceScope} group by 1`,
    )),
    ...(await grouped(db, "visitCloseouts.charge", `select charge_disposition::text as key, count(*)::int as n from visit_closeouts where practice_id = ${p} group by 1`)),
    ...(await grouped(db, "visitCloseouts.followUp", `select follow_up_disposition::text as key, count(*)::int as n from visit_closeouts where practice_id = ${p} group by 1`)),
    ...(await grouped(db, "visitWorkItems", `select status::text as key, count(*)::int as n from visit_work_items where practice_id = ${p} group by 1`)),
  };

  const [all] = Object.values(await moneySummaries(db, practiceId, null));
  const monthly = async (query: string) =>
    Object.fromEntries((await q<{ key: string; amount: string }>(db, sql.raw(query))).map((r) => [r.key, r.amount]));
  const paymentsByMethod = Object.fromEntries(
    (
      await q<{ key: string; count: number; amount: string }>(
        db,
        sql.raw(`select method::text as key, count(*)::int as count, ${money("amount", "amount")} from payments where ${invoiceScope} group by 1`),
      )
    ).map((r) => [r.key, { count: r.count, amount: r.amount }]),
  );
  const partialPaymentInvoices = await q<{ invoiceId: string; total: string; paid: string; balance: string }>(
    db,
    sql.raw(`
      select id::text as "invoiceId", total::text as total, paid_amount::text as paid, (total - paid_amount)::numeric(14,2)::text as balance
      from invoices where practice_id = ${p} and paid_amount > 0 and paid_amount < total
      order by id::text collate "C"`),
  );

  const inventoryRows = await q<{ sku: string; receipts: number; dispensed: number; retailSold: number; closing: number }>(
    db,
    sql.raw(`
      select pr.sku,
        coalesce((select sum(adjustment) from inventory_stock_adjustments a where a.product_id = pr.id and a.adjustment > 0), 0)::float8 as receipts,
        coalesce((select sum(quantity) from prescription_events e where e.product_id = pr.id and e.event_type in ('created','refill_dispensed')), 0)::float8 as dispensed,
        coalesce((select sum(i.quantity) from invoice_items i join invoices v on v.id = i.invoice_id
                  where i.item_type = 'product' and i.item_id = pr.id and i.source_dispense_charge_id is null
                    and i.deleted_at is null and v.deleted_at is null and v.status <> 'void' and not v.is_estimate), 0)::float8 as "retailSold",
        pr.stock_quantity::float8 as closing
      from products pr where pr.practice_id = ${p}`),
  );

  const ids = async (query: string) => (await q<{ id: string }>(db, sql.raw(query))).map((r) => r.id);
  return {
    counts,
    financial: {
      invoices: all ?? { count: 0, subtotal: "0.00", tax: "0.00", total: "0.00", paid: "0.00", outstanding: "0.00" },
      invoicesByStatus: await moneySummaries(db, practiceId, "status"),
      invoicedByIssueMonth: await monthly(
        `select to_char(created_at at time zone '${tz}', 'YYYY-MM') as key, ${money("amount", "total")} from invoices where practice_id = ${p} group by 1`,
      ),
      collectedByPaymentMonth: await monthly(
        `select to_char(received_at at time zone '${tz}', 'YYYY-MM') as key, ${money("amount", "amount")} from payments where ${invoiceScope} group by 1`,
      ),
      paymentsByMethod,
      partialPaymentInvoices,
    },
    inventory: Object.fromEntries(inventoryRows.map(({ sku, ...rest }) => [sku, rest])),
    patterns: {
      repeatVisitPairs: (
        await q<{ a: string; b: string }>(
          db,
          sql.raw(`select appointment_id::text as a, follow_up_appointment_id::text as b from visit_closeouts
                   where practice_id = ${p} and follow_up_appointment_id is not null order by appointment_id::text collate "C"`),
        )
      ).map((r) => [r.a, r.b] as [string, string]),
      cancelledAppointmentIds: await ids(`select id::text as id from appointments where practice_id = ${p} and status = 'cancelled' order by id::text collate "C"`),
      noShowAppointmentIds: await ids(`select id::text as id from appointments where practice_id = ${p} and status = 'no_show' order by id::text collate "C"`),
      writtenPrescriptionIds: await ids(`select id::text as id from prescriptions where practice_id = ${p} and product_id is null order by id::text collate "C"`),
    },
  };
}

export function diff(expected: unknown, actual: unknown, path = "", out: string[] = []): string[] {
  if (out.length >= 60) return out;
  if (Array.isArray(expected) || Array.isArray(actual)) {
    if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) {
      out.push(`${path}: expected ${JSON.stringify(expected)?.slice(0, 160)} got ${JSON.stringify(actual)?.slice(0, 160)}`);
      return out;
    }
    expected.forEach((e, i) => diff(e, actual[i], `${path}[${i}]`, out));
    return out;
  }
  if (expected && actual && typeof expected === "object" && typeof actual === "object") {
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const key of [...keys].sort()) {
      diff((expected as Row)[key], (actual as Row)[key], path ? `${path}.${key}` : key, out);
    }
    return out;
  }
  if (expected !== actual) out.push(`${path}: expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
  return out;
}

export type CheckResult = { name: string; ok: boolean; detail: string };

async function zeroRows(db: Database, name: string, query: string, describe: string): Promise<CheckResult> {
  const rows = await q(db, sql.raw(query));
  return { name, ok: rows.length === 0, detail: rows.length === 0 ? describe : `${rows.length} violation(s), e.g. ${JSON.stringify(rows.slice(0, 3))}` };
}

export async function invariantChecks(db: Database, expected: ExpectedResults): Promise<CheckResult[]> {
  const p = `'${expected.meta.practiceId}'::uuid`;
  const asOf = `'${expected.meta.asOf}'::timestamptz`;
  const goLive = `('${expected.meta.goLiveDate}'::date::timestamp at time zone '${expected.meta.timezone.replace(/'/g, "")}')`;
  const checks: CheckResult[] = [];

  checks.push(
    await zeroRows(db, "invoice_line_arithmetic", `
      select i.id from invoice_items i join invoices v on v.id = i.invoice_id
      where v.practice_id = ${p} and i.total <> round(i.quantity * i.unit_price, 2)`,
      "every line total = round(quantity x unit price, 2)"),
    await zeroRows(db, "invoice_totals", `
      select v.id from invoices v join practices pr on pr.id = v.practice_id
      left join lateral (
        select coalesce(sum(total), 0) as subtotal, coalesce(sum(total) filter (where taxable), 0) as taxable
        from invoice_items where invoice_id = v.id and deleted_at is null) s on true
      where v.practice_id = ${p}
        and (v.subtotal <> s.subtotal or v.tax <> round(s.taxable * pr.tax_rate_percent / 100, 2) or v.total <> v.subtotal + v.tax)`,
      "subtotal = sum of lines; tax = round(taxable lines x practice rate); total = subtotal + tax"),
    await zeroRows(db, "paid_amount_matches_payments", `
      select v.id from invoices v left join lateral (select coalesce(sum(amount), 0) as paid from payments where invoice_id = v.id and deleted_at is null) s on true
      where v.practice_id = ${p} and v.paid_amount <> s.paid`,
      "invoice paid_amount = sum of its payments"),
    await zeroRows(db, "invoice_status_consistent", `
      select id, status from invoices where practice_id = ${p}
        and ((status = 'paid') <> (paid_amount >= total) or paid_amount > total)`,
      "paid exactly when fully paid; never overpaid"),
    await zeroRows(db, "dispense_charge_links", `
      select c.id from dispense_charge_queue c where c.practice_id = ${p} and c.status = 'invoiced'
        and (select count(*) from invoice_items i where i.source_dispense_charge_id = c.id and i.id = c.invoice_item_id and i.invoice_id = c.invoice_id) <> 1
      union all
      select i.id from invoice_items i join invoices v on v.id = i.invoice_id
      where v.practice_id = ${p} and i.source_dispense_charge_id is not null
        and not exists (select 1 from dispense_charge_queue c where c.id = i.source_dispense_charge_id and c.status = 'invoiced' and c.invoice_item_id = i.id)`,
      "invoiced dispense charges and their invoice lines point at each other"),
    await zeroRows(db, "dispense_ledger", `
      select e.id from prescription_events e where e.practice_id = ${p} and e.product_id is not null
        and e.event_type in ('created','refill_dispensed')
        and (select count(*) from dispense_charge_queue c where c.prescription_event_id = e.id) <> 1
      union all
      select c.id from dispense_charge_queue c where c.practice_id = ${p}
        and not exists (select 1 from prescription_events e where e.id = c.prescription_event_id and e.product_id is not null)`,
      "each dispensing event has exactly one dispense charge and vice versa"),
    await zeroRows(db, "prescription_is_not_proof_of_dispensing", `
      select rx.id from prescriptions rx where rx.practice_id = ${p} and rx.product_id is null
        and (exists (select 1 from dispense_charge_queue c where c.prescription_id = rx.id)
             or exists (select 1 from prescription_events e where e.prescription_id = rx.id and e.event_type = 'refill_dispensed'))`,
      "written scripts (no product) have no dispense records; refills on them are authorisations only"),
    await zeroRows(db, "closeout_per_completed_visit", `
      select a.id, a.status from appointments a where a.practice_id = ${p}
        and ((a.status = 'checked_out') <> exists (select 1 from visit_closeouts c where c.appointment_id = a.id and c.status = 'completed'))`,
      "every checked-out visit, and only those, has a completed closeout"),
    await zeroRows(db, "work_items_resolved", `select id from visit_work_items where practice_id = ${p} and status = 'unresolved'`,
      "no unresolved visit work items"),
  );

  const opening = expected.reference.openingStockBySku;
  const stockRows = await q<{ sku: string; closing: number; receipts: number; dispensed: number; retail: number }>(
    db,
    sql.raw(`
      select pr.sku, pr.stock_quantity::float8 as closing,
        coalesce((select sum(adjustment) from inventory_stock_adjustments a where a.product_id = pr.id), 0)::float8 as receipts,
        coalesce((select sum(quantity) from prescription_events e where e.product_id = pr.id and e.event_type in ('created','refill_dispensed')), 0)::float8 as dispensed,
        coalesce((select sum(i.quantity) from invoice_items i join invoices v on v.id = i.invoice_id where i.item_type = 'product' and i.item_id = pr.id and i.source_dispense_charge_id is null and v.status <> 'void'), 0)::float8 as retail
      from products pr where pr.practice_id = ${p}`),
  );
  const stockBad = stockRows.filter((r) => opening[r.sku]! + r.receipts - r.dispensed - r.retail !== r.closing);
  checks.push({
    name: "stock_reconciliation",
    ok: stockBad.length === 0 && stockRows.length === Object.keys(opening).length,
    detail: stockBad.length ? JSON.stringify(stockBad.slice(0, 3)) : "closing = opening + receipts - dispensed - retail for every product",
  });

  const timestampColumns: [string, string[], string][] = [
    ["appointments", ["created_at", "updated_at", "start_time", "end_time"], `practice_id = ${p}`],
    ["soap_notes", ["created_at", "updated_at", "finalized_at"], `practice_id = ${p}`],
    ["payments", ["created_at", "updated_at", "received_at"], `invoice_id in (select id from invoices where practice_id = ${p})`],
    ["invoices", ["created_at", "updated_at"], `practice_id = ${p}`],
    ["invoice_items", ["created_at", "updated_at"], `invoice_id in (select id from invoices where practice_id = ${p})`],
    ["prescriptions", ["created_at", "updated_at"], `practice_id = ${p}`],
    ["prescription_events", ["created_at"], `practice_id = ${p}`],
    ["dispense_charge_queue", ["created_at", "updated_at", "resolved_at"], `practice_id = ${p}`],
    ["lab_results", ["created_at", "updated_at", "completed_at", "reviewed_at"], `practice_id = ${p}`],
    ["lab_result_events", ["created_at"], `practice_id = ${p}`],
    ["vaccination_records", ["created_at", "updated_at", "administered_at"], `practice_id = ${p}`],
    ["visit_closeouts", ["created_at", "updated_at", "clinical_finalized_at", "completed_at"], `practice_id = ${p}`],
    ["visit_work_items", ["created_at", "updated_at", "resolved_at"], `practice_id = ${p}`],
    ["inventory_stock_adjustments", ["created_at"], `practice_id = ${p}`],
    ["products", ["created_at", "updated_at"], `practice_id = ${p}`],
    ["patient_weights", ["created_at", "updated_at", "recorded_at"], `patient_id in (select id from patients where practice_id = ${p})`],
    ["problem_list", ["created_at", "updated_at"], `practice_id = ${p}`],
    ["clients", ["created_at", "updated_at"], `practice_id = ${p}`],
    ["patients", ["created_at", "updated_at"], `practice_id = ${p}`],
    ["users", ["created_at", "updated_at"], `practice_id = ${p}`],
  ];
  const outOfRange: string[] = [];
  for (const [table, columns, scope] of timestampColumns) {
    for (const column of columns) {
      const [row] = await q<{ n: number }>(
        db,
        sql.raw(`select count(*)::int as n from ${table} where ${scope} and ${column} is not null and (${column} > ${asOf} or ${column} < ${goLive})`),
      );
      if (row!.n) outOfRange.push(`${table}.${column}: ${row!.n}`);
    }
  }
  checks.push({
    name: "historical_timestamps",
    ok: outOfRange.length === 0,
    detail: outOfRange.length ? outOfRange.join("; ") : `every event timestamp lies between go-live (${expected.meta.goLiveDate}) and the as-of instant; none defaulted to the time of generation`,
  });

  checks.push(
    await zeroRows(db, "synthetic_labels", `
      select 'practice' as what from practices where id = ${p} and not (settings ? 'syntheticDataset')
      union all select 'client ' || id from clients where practice_id = ${p} and notes not like 'Synthetic client:%'
      union all select 'appointment ' || id from appointments where practice_id = ${p} and notes not like '[Synthetic]%'
      union all select 'soap ' || id from soap_notes where practice_id = ${p} and plan not like '%[Synthetic record:%'
      union all select 'prescription ' || id from prescriptions where practice_id = ${p} and instructions not like '%[Synthetic record:%'
      union all select 'payment ' || id from payments where invoice_id in (select id from invoices where practice_id = ${p}) and notes not like 'Synthetic payment%'
      union all select 'product ' || id from products where practice_id = ${p} and sku not like 'SYN-%'
      union all select 'service ' || id from services where practice_id = ${p} and code not like 'SYN-%'
      union all select 'user ' || id from users where practice_id = ${p} and email not like '%.synthetic.example'
      union all select 'client email ' || id from clients where practice_id = ${p} and email not like '%.synthetic.example'`,
      "practice, clients, appointments, notes, prescriptions, payments, catalogue and accounts are all labelled synthetic"),
    await zeroRows(db, "answer_key_not_in_database", `
      select id from practices where id = ${p} and (settings::text ilike '%discrepan%' or settings::text ilike '%expected%')`,
      "the database carries no discrepancy labels or expected results"),
  );

  // Suspected vs confirmed conditions recorded the way the answer key says.
  const conditionProblems: string[] = [];
  for (const s of expected.suspectedConditions) {
    const [suspected] = await q<{ assessment: string }>(db, sql`select assessment from soap_notes where appointment_id = ${s.suspectedAppointmentId}::uuid`);
    const [lab] = await q<{ value: string | null }>(db, sql`select result_value as value from lab_results where id = ${s.labResultId}::uuid`);
    if (!suspected || !/SUSPECTED/.test(suspected.assessment)) conditionProblems.push(`${s.suspectedAppointmentId}: no SUSPECTED assessment`);
    if (!lab) conditionProblems.push(`${s.labResultId}: lab missing`);
    else if (lab.value !== null && lab.value !== s.labValue) conditionProblems.push(`${s.labResultId}: lab value ${lab.value} != ${s.labValue}`);
    if (s.outcome === "confirmed" || s.outcome === "ruled_out") {
      const [resolved] = await q<{ assessment: string }>(db, sql`select assessment from soap_notes where appointment_id = ${s.resolvedAppointmentId}::uuid`);
      const marker = s.outcome === "confirmed" ? /CONFIRMED/ : /RULED OUT/;
      if (!resolved || !marker.test(resolved.assessment)) conditionProblems.push(`${s.resolvedAppointmentId}: assessment lacks ${marker}`);
    }
    const problems = await q<{ id: string; onset: string }>(
      db,
      sql`select id::text as id, onset_date::text as onset from problem_list where patient_id = ${s.patientId}::uuid and description = ${s.condition}`,
    );
    if (s.outcome === "confirmed" && !problems.some((pr) => pr.id === s.problemId && pr.onset === s.suspectedOn)) {
      conditionProblems.push(`${s.patientId}: confirmed ${s.condition} missing from problem list`);
    }
    // A ruled-out or unresolved work-up must not have produced a problem entry.
    // The same condition may still be confirmed by a later, separate work-up.
    if (s.outcome !== "confirmed" && problems.some((pr) => pr.onset === s.suspectedOn)) {
      conditionProblems.push(`${s.patientId}: ${s.outcome} work-up of ${s.suspectedOn} produced a ${s.condition} problem entry`);
    }
  }
  checks.push({
    name: "suspected_vs_confirmed_conditions",
    ok: conditionProblems.length === 0,
    detail: conditionProblems.length ? conditionProblems.slice(0, 5).join("; ") : `${expected.suspectedConditions.length} suspected conditions match notes, labs and problem list`,
  });
  return checks;
}

export async function discrepancyDetectors(db: Database, expected: ExpectedResults): Promise<CheckResult[]> {
  const p = `'${expected.meta.practiceId}'::uuid`;
  const tz = expected.meta.timezone.replace(/'/g, "");
  const rxOnly = expected.reference.prescriptionOnlyProductIds.map((id) => `'${id}'::uuid`).join(",") || "null";
  const detectors: Record<keyof ExpectedResults["discrepancies"], { key: string; query: string }> = {
    unbilled_dispense: {
      key: "dispenseChargeId",
      query: `select id::text as id from dispense_charge_queue where practice_id = ${p} and status = 'pending'`,
    },
    price_below_catalog_without_adjustment: {
      key: "invoiceItemId",
      query: `select i.id::text as id from invoice_items i join invoices v on v.id = i.invoice_id join services s on s.id = i.item_id
              where v.practice_id = ${p} and i.item_type = 'service' and i.unit_price < s.default_price
                and not exists (select 1 from invoice_adjustments a where a.invoice_id = v.id)`,
    },
    billed_visit_without_consultation_note: {
      key: "appointmentId",
      query: `select a.id::text as id from appointments a where a.practice_id = ${p} and a.status = 'checked_out'
                and exists (select 1 from invoices v where v.appointment_id = a.id and v.status <> 'void')
                and not exists (select 1 from soap_notes n where n.appointment_id = a.id and n.deleted_at is null)`,
    },
    prescription_only_product_sold_without_prescription: {
      key: "invoiceItemId",
      query: `select i.id::text as id from invoice_items i join invoices v on v.id = i.invoice_id
              where v.practice_id = ${p} and i.item_type = 'product' and i.source_dispense_charge_id is null
                and i.item_id in (${rxOnly})
                and not exists (select 1 from prescriptions rx where rx.patient_id = v.patient_id and rx.product_id = i.item_id
                                and rx.start_date <= (v.created_at at time zone '${tz}')::date)`,
    },
  };
  const results: CheckResult[] = [];
  for (const [type, { key, query }] of Object.entries(detectors) as [keyof ExpectedResults["discrepancies"], { key: string; query: string }][]) {
    const found = (await q<{ id: string }>(db, sql.raw(query))).map((r) => r.id).sort();
    const wanted = expected.discrepancies[type].instances.map((i) => i[key]!).sort();
    const ok = JSON.stringify(found) === JSON.stringify(wanted) && wanted.length === expected.discrepancies[type].count;
    results.push({ name: `discrepancy:${type}`, ok, detail: ok ? `found exactly the ${wanted.length} planted instance(s)` : `expected ${JSON.stringify(wanted)} found ${JSON.stringify(found)}` });
  }
  return results;
}

export async function validateDataset(db: Database, expected: ExpectedResults) {
  const [practice] = await q<{ ok: number }>(
    db,
    sql`select 1 as ok from practices where id = ${expected.meta.practiceId}::uuid and settings #>> '{syntheticDataset,datasetId}' = ${expected.meta.datasetId}`,
  );
  if (!practice) throw new Error(`Dataset ${expected.meta.datasetId} (practice ${expected.meta.practiceId}) is not in this database.`);
  const actual = await metricsFromDatabase(db, expected.meta.practiceId, expected.meta.timezone);
  const differences = diff(expected.metrics, actual);
  const checks: CheckResult[] = [
    { name: "metrics_match_expected_results", ok: differences.length === 0, detail: differences.length ? differences.slice(0, 15).join("\n  ") : "counts, financial totals, inventory and patterns match exactly" },
    ...(await invariantChecks(db, expected)),
    ...(await discrepancyDetectors(db, expected)),
  ];
  return { ok: checks.every((c) => c.ok), checks, actual };
}
