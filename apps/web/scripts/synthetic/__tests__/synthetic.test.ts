import { describe, expect, it } from "vitest";
import { calculateInvoiceTaxTotals } from "@/lib/billing/invoice-tax";
import { moneyToCents } from "@/lib/billing/invoice-balance";
import { assertSafeDatabaseTarget, parseSyntheticArgs, PRESETS } from "../config";
import { expectedResultsFromPlan } from "../metrics";
import { buildPlan } from "../plan";
import { Rng } from "../rng";
import { localToUtc } from "../time";

const TODAY = "2026-11-09";
const sample = PRESETS["sample-1m"]!;

describe("synthetic data generator", () => {
  const plan = buildPlan(sample);
  const expected = expectedResultsFromPlan(plan);

  it("is deterministic for a fixed seed and changes with the seed", () => {
    const again = buildPlan(sample);
    expect(JSON.stringify(again.rows)).toBe(JSON.stringify(plan.rows));
    expect(JSON.stringify(expectedResultsFromPlan(again))).toBe(JSON.stringify(expected));
    const other = buildPlan({ ...sample, seed: "another-seed" });
    expect(other.practiceId).not.toBe(plan.practiceId);
  });

  it("derives independent RNG streams from labels", () => {
    const a = new Rng("seed").fork("x");
    const b = new Rng("seed").fork("x");
    expect([a.next(), a.uuid()]).toEqual([b.next(), b.uuid()]);
    expect(new Rng("seed").fork("y").next()).not.toBe(new Rng("seed").fork("x").next());
  });

  it("converts practice-local times across daylight-saving changes", () => {
    expect(localToUtc("2026-10-30", 9 * 60, "America/New_York").toISOString()).toBe("2026-10-30T13:00:00.000Z");
    expect(localToUtc("2026-11-02", 9 * 60, "America/New_York").toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });

  it("refuses unsafe or ambiguous runs", () => {
    expect(() => parseSyntheticArgs(["generate", "--end", "2026-12-01"], TODAY)).toThrow(/before today/);
    expect(() => parseSyntheticArgs(["generate", "--preset", "nope"], TODAY)).toThrow(/Unknown preset/);
    expect(() => parseSyntheticArgs(["generate", "--dataset", "Bad Id"], TODAY)).toThrow(/Dataset id/);
    expect(() => assertSafeDatabaseTarget("postgresql://u:p@db.example.com/x", {}, false)).toThrow(/non-local/);
    expect(() => assertSafeDatabaseTarget("postgresql://u:p@localhost/x", { VERCEL: "1" }, false)).toThrow(/production/);
    expect(() => assertSafeDatabaseTarget("postgresql://u:p@localhost:5432/x", {}, false)).not.toThrow();
  });

  it("keeps every generated event inside the historical window", () => {
    const asOf = plan.asOf.getTime();
    const instants: Date[] = [
      ...plan.rows.appointments.flatMap((a) => [a.createdAt, a.updatedAt, a.startTime, a.endTime] as Date[]),
      ...plan.rows.soapNotes.flatMap((n) => [n.createdAt, n.finalizedAt] as Date[]),
      ...plan.rows.payments.map((p) => p.receivedAt as Date),
      ...plan.rows.prescriptionEvents.map((e) => e.createdAt as Date),
      ...plan.rows.invoices.flatMap((i) => [i.createdAt, i.updatedAt] as Date[]),
    ];
    expect(instants.every((d) => d instanceof Date && d.getTime() <= asOf)).toBe(true);
  });

  it("produces internally consistent invoices using the app tax calculator", () => {
    for (const invoice of plan.rows.invoices) {
      const lines = plan.rows.invoiceItems.filter((i) => i.invoiceId === invoice.id);
      const totals = calculateInvoiceTaxTotals(
        lines.map((l) => ({ lineTotalCents: moneyToCents(l.total), taxable: l.taxable ?? true })),
        sample.taxRatePercent,
      );
      expect(moneyToCents(invoice.total)).toBe(totals.totalCents);
      const paid = plan.rows.payments.filter((p) => p.invoiceId === invoice.id).reduce((s, p) => s + moneyToCents(p.amount), 0);
      expect(moneyToCents(invoice.paidAmount)).toBe(paid);
      expect(invoice.status === "paid").toBe(paid >= moneyToCents(invoice.total));
    }
  });

  it("covers the required patterns and the configured discrepancies", () => {
    const counts = expected.metrics.counts;
    expect(counts["soapNotes.short"]).toBeGreaterThan(0);
    expect(counts["soapNotes.long"]).toBeGreaterThan(0);
    expect(counts["appointments.status.cancelled"]).toBeGreaterThan(0);
    expect(expected.metrics.patterns.repeatVisitPairs.length).toBeGreaterThan(0);
    expect(expected.metrics.financial.partialPaymentInvoices.length).toBeGreaterThan(0);
    const outcomes = new Set(expected.suspectedConditions.map((s) => s.outcome));
    expect(outcomes.has("confirmed") && outcomes.has("ruled_out")).toBe(true);
    expect(counts["prescriptions.writtenScript"]).toBeGreaterThan(0);
    for (const discrepancy of Object.values(expected.discrepancies)) {
      expect(discrepancy.count).toBe(sample.discrepanciesPerType);
    }
  });

  it("never treats a written prescription as dispensed", () => {
    const written = new Set(plan.rows.prescriptions.filter((rx) => !rx.productId).map((rx) => rx.id));
    expect(plan.rows.dispenseCharges.some((c) => written.has(c.prescriptionId))).toBe(false);
    expect(
      plan.rows.prescriptionEvents.some((e) => written.has(e.prescriptionId) && e.eventType === "refill_dispensed"),
    ).toBe(false);
  });

  it("books every appointment before it starts and cancels before the start", () => {
    for (const plan3 of [plan, buildPlan({ ...sample, startDate: "2025-01-01", endDate: "2025-06-30" })]) {
      for (const a of plan3.rows.appointments) {
        const created = (a.createdAt as Date).getTime();
        const start = (a.startTime as Date).getTime();
        expect(created).toBeLessThanOrEqual(start - 15 * 60_000);
        expect((a.updatedAt as Date).getTime()).toBeGreaterThanOrEqual(created);
        if (a.status === "cancelled") expect((a.updatedAt as Date).getTime()).toBeLessThanOrEqual(start);
      }
    }
  });

  it("records stock receipts whose quantity_after matches the time-ordered balance", () => {
    const longer = buildPlan(PRESETS["three-year"]!);
    expect(longer.rows.stockAdjustments.length).toBeGreaterThan(0);
    const productSku = new Map(longer.rows.products.map((p) => [p.id, p.sku!]));
    const opening = Object.fromEntries(Object.entries(longer.facts.stock).map(([sku, s]) => [sku, s.opening]));
    type Move = { sku: string; at: number; receipt: boolean; quantity: number; after?: number };
    const moves: Move[] = [
      ...longer.rows.stockAdjustments.map((a) => ({ sku: productSku.get(a.productId)!, at: (a.createdAt as Date).getTime(), receipt: true, quantity: Number(a.adjustment), after: Number(a.quantityAfter) })),
      ...longer.rows.prescriptionEvents
        .filter((e) => e.productId && (e.eventType === "created" || e.eventType === "refill_dispensed"))
        .map((e) => ({ sku: productSku.get(e.productId!)!, at: (e.createdAt as Date).getTime(), receipt: false, quantity: Number(e.quantity) })),
      ...longer.rows.invoiceItems
        .filter((i) => i.itemType === "product" && !i.sourceDispenseChargeId)
        .map((i) => ({ sku: productSku.get(i.itemId!)!, at: (i.createdAt as Date).getTime(), receipt: false, quantity: Number(i.quantity) })),
    ].sort((a, b) => (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : a.at - b.at || Number(b.receipt) - Number(a.receipt)));
    const balance: Record<string, number> = { ...opening };
    for (const m of moves) {
      balance[m.sku] = balance[m.sku]! + (m.receipt ? m.quantity : -m.quantity);
      expect(balance[m.sku]).toBeGreaterThanOrEqual(0);
      if (m.receipt) expect(m.after).toBe(balance[m.sku]);
    }
  });

  it("rejects a malformed answer key before querying", async () => {
    const { assertWellFormedAnswerKey } = await import("../validate");
    expect(() => assertWellFormedAnswerKey(expected)).not.toThrow();
    const tampered = { ...expected, meta: { ...expected.meta, practiceId: "x'; drop table practices; --" } };
    expect(() => assertWellFormedAnswerKey(tampered)).toThrow(/malformed/);
  });

  it("generates only companion species", () => {
    const species = new Set(plan.rows.patients.map((p) => p.species));
    for (const herd of ["bovine", "ovine", "caprine", "porcine", "poultry", "camelid", "equine"]) {
      expect(species.has(herd as never)).toBe(false);
    }
  });
});
