/**
 * Expected results: one shape, two producers.
 *
 * `metricsFromPlan` computes the answer key from the generator's in-memory
 * plan. `validate.ts` computes the same shape independently with SQL against
 * the database. Validation is an exact deep comparison plus invariant checks
 * and discrepancy detectors. The answer key is written to a file only; it is
 * never stored in the database, so the PMS extraction API cannot expose it.
 */
import { centsToMoney, moneyToCents } from "@/lib/billing/invoice-balance";
import { classifyNoteLength, LONG_NOTE_THRESHOLD, type DiscrepancyType, type Plan } from "./plan";
import { GENERATOR_VERSION } from "./config";
import { localMonthOf } from "./time";

export type MoneySummary = { count: number; subtotal: string; tax: string; total: string; paid: string; outstanding: string };

export type Metrics = {
  counts: Record<string, number>;
  financial: {
    invoices: MoneySummary;
    invoicesByStatus: Record<string, MoneySummary>;
    invoicedByIssueMonth: Record<string, string>;
    collectedByPaymentMonth: Record<string, string>;
    paymentsByMethod: Record<string, { count: number; amount: string }>;
    partialPaymentInvoices: { invoiceId: string; total: string; paid: string; balance: string }[];
  };
  inventory: Record<string, { receipts: number; dispensed: number; retailSold: number; closing: number }>;
  patterns: {
    repeatVisitPairs: [string, string][];
    cancelledAppointmentIds: string[];
    noShowAppointmentIds: string[];
    writtenPrescriptionIds: string[];
  };
};

export type ExpectedResults = {
  meta: {
    datasetId: string;
    seed: string;
    generatorVersion: string;
    practiceId: string;
    practiceName: string;
    startDate: string;
    endDate: string;
    asOf: string;
    goLiveDate: string;
    timezone: string;
    taxRatePercent: string;
    note: string;
  };
  metrics: Metrics;
  suspectedConditions: Plan["facts"]["suspectedConditions"];
  establishedChronicPatients: Plan["facts"]["establishedChronicPatients"];
  discrepancies: Record<DiscrepancyType, { count: number; description: string; instances: Record<string, string>[] }>;
  reference: {
    prescriptionOnlyProductIds: string[];
    openingStockBySku: Record<string, number>;
    longNoteThresholdCharacters: number;
  };
};

const sum = (values: (string | number | null | undefined)[]) =>
  values.reduce<number>((total, v) => total + moneyToCents(v ?? 0), 0);

function bump(map: Record<string, number>, key: string, by = 1) {
  if (by === 0) return;
  map[key] = (map[key] ?? 0) + by;
}

export const localMonth = localMonthOf;

/** Sum money per key in one pass; keys sorted for a stable file. */
function totalsBy<T>(items: readonly T[], key: (item: T) => string, amount: (item: T) => string | null | undefined) {
  const cents = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    cents.set(k, (cents.get(k) ?? 0) + moneyToCents(amount(item) ?? 0));
  }
  return Object.fromEntries([...cents.keys()].sort().map((k) => [k, centsToMoney(cents.get(k)!)]));
}

function moneySummary(rows: { subtotal?: string | null; tax?: string | null; total?: string | null; paidAmount?: string | null }[]): MoneySummary {
  const total = sum(rows.map((r) => r.total));
  const paid = sum(rows.map((r) => r.paidAmount));
  return {
    count: rows.length,
    subtotal: centsToMoney(sum(rows.map((r) => r.subtotal))),
    tax: centsToMoney(sum(rows.map((r) => r.tax))),
    total: centsToMoney(total),
    paid: centsToMoney(paid),
    outstanding: centsToMoney(total - paid),
  };
}

export function metricsFromPlan(plan: Plan): Metrics {
  const { rows, facts } = plan;
  const tz = plan.config.timezone;
  const counts: Record<string, number> = {
    clients: rows.clients.length,
    patients: rows.patients.length,
    appointments: rows.appointments.length,
    soapNotes: rows.soapNotes.length,
    vaccinations: rows.vaccinationRecords.length,
    labResults: rows.labResults.length,
    problems: rows.problemList.length,
    prescriptions: rows.prescriptions.length,
    invoices: rows.invoices.length,
    invoiceItems: rows.invoiceItems.length,
    payments: rows.payments.length,
    visitCloseouts: rows.visitCloseouts.length,
    patientWeights: rows.patientWeights.length,
    stockAdjustments: rows.stockAdjustments.length,
  };
  for (const p of rows.patients) bump(counts, `patients.species.${p.species}`);
  for (const u of rows.users) bump(counts, `staff.${u.role}`);
  const typeName = new Map(rows.appointmentTypes.map((t) => [t.id, t.name]));
  for (const a of rows.appointments) {
    bump(counts, `appointments.status.${a.status}`);
    bump(counts, `appointments.type.${typeName.get(a.typeId!)}`);
  }
  for (const n of rows.soapNotes) bump(counts, `soapNotes.${classifyNoteLength(n)}`);
  for (const l of rows.labResults) bump(counts, `labResults.status.${l.status}`);
  for (const rx of rows.prescriptions) {
    bump(counts, rx.productId ? "prescriptions.dispensedFromClinicStock" : "prescriptions.writtenScript");
    bump(counts, `prescriptions.status.${rx.status}`);
  }
  for (const e of rows.prescriptionEvents) bump(counts, `prescriptionEvents.${e.eventType}`);
  const resolved = new Set(plan.dispenseResolutions.map((r) => r.chargeId));
  for (const c of rows.dispenseCharges) bump(counts, `dispenseCharges.${resolved.has(c.id!) ? "invoiced" : "pending"}`);
  for (const inv of rows.invoices) {
    bump(counts, `invoices.status.${inv.status}`);
    bump(counts, inv.appointmentId ? "invoices.visit" : "invoices.counter");
  }
  for (const item of rows.invoiceItems) {
    bump(counts, item.itemType === "service" ? "invoiceItems.service" : item.sourceDispenseChargeId ? "invoiceItems.productDispensed" : "invoiceItems.productRetail");
  }
  for (const c of rows.visitCloseouts) {
    bump(counts, `visitCloseouts.charge.${c.chargeDisposition}`);
    bump(counts, `visitCloseouts.followUp.${c.followUpDisposition}`);
  }
  for (const w of rows.visitWorkItems) bump(counts, `visitWorkItems.${w.status}`);

  const byStatus: Record<string, MoneySummary> = {};
  for (const status of [...new Set(rows.invoices.map((i) => i.status!))].sort()) {
    byStatus[status] = moneySummary(rows.invoices.filter((i) => i.status === status));
  }
  const invoicedByIssueMonth = totalsBy(rows.invoices, (i) => localMonth(i.createdAt as Date, tz), (i) => i.total);
  const collectedByPaymentMonth = totalsBy(rows.payments, (p) => localMonth(p.receivedAt as Date, tz), (p) => p.amount);
  const paymentsByMethod: Record<string, { count: number; amount: string }> = {};
  for (const method of [...new Set(rows.payments.map((p) => p.method))].sort()) {
    const subset = rows.payments.filter((p) => p.method === method);
    paymentsByMethod[method] = { count: subset.length, amount: centsToMoney(sum(subset.map((p) => p.amount))) };
  }
  const invoiceById = new Map(rows.invoices.map((i) => [i.id!, i]));
  const partialPaymentInvoices = [...facts.partialPaymentInvoiceIds].sort().map((id) => {
    const inv = invoiceById.get(id)!;
    return {
      invoiceId: id,
      total: inv.total!,
      paid: inv.paidAmount!,
      balance: centsToMoney(moneyToCents(inv.total) - moneyToCents(inv.paidAmount)),
    };
  });

  const inventory: Metrics["inventory"] = {};
  for (const sku of Object.keys(facts.stock).sort()) {
    const s = facts.stock[sku]!;
    inventory[sku] = { receipts: s.receipts, dispensed: s.dispensed, retailSold: s.retailSold, closing: s.closing };
  }

  const repeatVisitPairs = rows.visitCloseouts
    .filter((c) => c.followUpAppointmentId)
    .map((c) => [c.appointmentId, c.followUpAppointmentId!] as [string, string])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  return {
    counts: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
    financial: {
      invoices: moneySummary(rows.invoices),
      invoicesByStatus: byStatus,
      invoicedByIssueMonth,
      collectedByPaymentMonth,
      paymentsByMethod,
      partialPaymentInvoices,
    },
    inventory,
    patterns: {
      repeatVisitPairs,
      cancelledAppointmentIds: facts.visits.filter((v) => v.status === "cancelled").map((v) => v.appointmentId).sort(),
      noShowAppointmentIds: facts.visits.filter((v) => v.status === "no_show").map((v) => v.appointmentId).sort(),
      writtenPrescriptionIds: rows.prescriptions.filter((rx) => !rx.productId).map((rx) => rx.id!).sort(),
    },
  };
}

const DISCREPANCY_TYPES: DiscrepancyType[] = [
  "unbilled_dispense",
  "price_below_catalog_without_adjustment",
  "billed_visit_without_consultation_note",
  "prescription_only_product_sold_without_prescription",
];

export function expectedResultsFromPlan(plan: Plan): ExpectedResults {
  const discrepancies = {} as ExpectedResults["discrepancies"];
  for (const type of DISCREPANCY_TYPES) {
    const instances = plan.facts.discrepancies.filter((d) => d.type === type);
    discrepancies[type] = {
      count: instances.length,
      description: instances[0]?.description ?? "",
      instances: instances.map((d) => d.records),
    };
  }
  return {
    meta: {
      datasetId: plan.config.datasetId,
      seed: plan.config.seed,
      generatorVersion: GENERATOR_VERSION,
      practiceId: plan.practiceId,
      practiceName: plan.config.practiceName,
      startDate: plan.config.startDate,
      endDate: plan.config.endDate,
      asOf: plan.asOf.toISOString(),
      goLiveDate: plan.goLive,
      timezone: plan.config.timezone,
      taxRatePercent: plan.config.taxRatePercent,
      note:
        "Answer key for a synthetic dataset. Keep it outside the PMS: it is not stored in the database and is not reachable through the extraction API. All states are as of the end date.",
    },
    metrics: metricsFromPlan(plan),
    suspectedConditions: plan.facts.suspectedConditions,
    establishedChronicPatients: plan.facts.establishedChronicPatients,
    discrepancies,
    reference: {
      prescriptionOnlyProductIds: [...plan.facts.prescriptionOnlyProductIds].sort(),
      openingStockBySku: Object.fromEntries(Object.entries(plan.facts.stock).map(([sku, s]) => [sku, s.opening])),
      longNoteThresholdCharacters: LONG_NOTE_THRESHOLD,
    },
  };
}
