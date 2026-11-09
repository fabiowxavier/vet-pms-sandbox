import { describe, expect, it, vi } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import * as schema from "../../../../packages/db/schema/index";
import type { Database } from "@openpims/db/client";
import { withTenant } from "@/lib/tenant-db";
import { listResource, parseExtractionParams } from "@/lib/compat/shared/extraction";
import { invoiceLinesResource, invoicesResource } from "@/lib/compat/openvpm/extraction-resources";
import { disposableClinic } from "./helpers/disposable-clinic";
import { runGoldenClinic } from "./helpers/golden-clinic";

// Provider delivery is outside this database contract.
vi.mock("@/lib/webhook-dispatcher", () => ({ dispatchWebhookEvent: vi.fn() }));

type Row = Record<string, unknown> & { id: string; changed_at: string; deleted_at: string | null };
type Invoice = Row & { total: string; subtotal: string; tax: string; status: string; lines: { id: string; total: string }[] };

/**
 * Extraction API behaviour against real PostgreSQL, the application role
 * (row-level security on) and the billing service's own procedures:
 *
 * 1. A draft invoice edited through updateInvoiceItems is returned by an
 *    incremental extraction with its new totals, the removed lines as
 *    tombstones and the replacement lines.
 * 2. While records change during a paged extraction, the documented
 *    guarantees hold (no committed, unchanged record is skipped; records
 *    amended after being read are returned again), a late-committing change
 *    can be missed by a naive watermark, and an overlap window plus
 *    de-duplication by latest changed_at recovers the source state.
 */
const integration = process.env.EXTRACTION_SYNC_DB_INTEGRATION === "1" ? describe : describe.skip;

integration("Extraction API incremental sync on disposable PostgreSQL", () => {
  it("detects service-made amendments and recovers concurrent changes with an overlap window", async () => {
    const fixture = await disposableClinic();
    const originalUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = fixture.appUrl;
    try {
      const clinic = await runGoldenClinic(fixture);
      const { billingRouter } = await import("../routers/billing");
      const billing = (db?: Database) =>
        billingRouter.createCaller(db ? { ...clinic.context(), db } : clinic.context());
      const practiceId = clinic.practice.id;
      const db = fixture.db as unknown as Database;

      const extract = async <T extends Row>(resource: typeof invoicesResource, query: string, practice = practiceId) => {
        const records: T[] = [];
        let cursor: string | null = null;
        do {
          const parsed = parseExtractionParams(
            new URLSearchParams(`${query}&limit=100${cursor ? `&cursor=${cursor}` : ""}`),
            resource.filters ?? [],
          );
          if (!parsed.ok) throw new Error(parsed.message);
          const page = await withTenant(db, practice, (tx) => listResource(tx, practice, resource, parsed.params));
          records.push(...(page.data as T[]));
          cursor = page.pagination.next_cursor;
        } while (cursor);
        return records;
      };
      const draft = (description: string, unitPrice: string) =>
        billing().createInvoice({
          clientId: clinic.client.id,
          patientId: clinic.patient.id,
          items: [
            { description, quantity: 1, unitPrice, itemType: "service" },
            { description: `${description} supplies`, quantity: 2, unitPrice: "5.00", itemType: "service" },
          ],
        });
      const editLines = async (id: string, items: { description: string; quantity: number; unitPrice: string }[], db2?: Database) => {
        const current = await billing(db2).getInvoice({ id });
        return billing(db2).updateInvoiceItems({
          id,
          expectedUpdatedAt: current.updatedAt,
          items: items.map((item) => ({ ...item, itemType: "service" as const })),
        });
      };

      // --- 1. Draft invoice amended through the billing service ------------
      const created = await draft("Synthetic recheck consultation", "40.00");
      const before = await extract<Invoice>(invoicesResource, "include_deleted=true");
      // Timestamps are ISO-8601 UTC, not the driver's PostgreSQL text form.
      const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
      for (const record of before) {
        for (const key of ["created_at", "updated_at", "changed_at"] as const) expect(record[key]).toMatch(ISO);
        for (const line of record.lines as unknown as Record<string, string>[]) expect(line.created_at).toMatch(ISO);
      }
      const initial = before.find((i) => i.id === created.id)!;
      expect(initial).toMatchObject({ status: "draft", subtotal: "50.00" });
      const initialLineIds = initial.lines.map((l) => l.id).sort();
      expect(initialLineIds).toHaveLength(2);

      const watermark = new Date(Date.now() - 1).toISOString();
      await editLines(created.id, [
        { description: "Synthetic recheck consultation", quantity: 1, unitPrice: "45.00" },
        { description: "Synthetic ear cytology", quantity: 1, unitPrice: "38.00" },
      ]);
      const serviceView = await billing().getInvoice({ id: created.id });

      const changedInvoices = await extract<Invoice>(invoicesResource, `updated_since=${watermark}&include_deleted=true`);
      expect(changedInvoices.map((i) => i.id)).toEqual([created.id]);
      const amended = changedInvoices[0]!;
      expect(amended).toMatchObject({
        subtotal: serviceView.subtotal,
        tax: serviceView.tax,
        total: serviceView.total,
      });
      expect(amended.subtotal).toBe("83.00");
      expect(amended.lines.map((l) => l.total).sort()).toEqual(["38.00", "45.00"]);
      expect(amended.lines.some((l) => initialLineIds.includes(l.id))).toBe(false);

      const changedLines = await extract<Row>(
        invoiceLinesResource,
        `updated_since=${watermark}&include_deleted=true&invoice_id=${created.id}`,
      );
      const tombstones = changedLines.filter((l) => l.deleted_at !== null).map((l) => l.id).sort();
      expect(tombstones).toEqual(initialLineIds);
      expect(changedLines.filter((l) => l.deleted_at === null).map((l) => l.id).sort()).toEqual(
        amended.lines.map((l) => l.id).sort(),
      );

      // Another practice's key sees none of it (application role + RLS).
      const foreign = await extract<Invoice>(invoicesResource, "include_deleted=true", clinic.foreignDoctor.practiceId);
      expect(foreign.some((i) => i.id === created.id)).toBe(false);

      // --- 2. Extraction while records change -------------------------------
      const d0 = await draft("Synthetic dental check", "55.00");
      const d1 = await draft("Synthetic weigh-in", "10.00");
      const d2 = await draft("Synthetic nail trim", "18.00");
      const passStartedAt = new Date().toISOString();

      const seen: Invoice[] = [];
      let cursor: string | null = null;
      let fetchedD0 = false;
      let started = false;
      let releaseHeld!: () => void;
      let heldWritten!: () => void;
      const heldGate = new Promise<void>((resolve) => (releaseHeld = resolve));
      const heldDone = new Promise<void>((resolve) => (heldWritten = resolve));
      let held: Promise<void> | null = null;
      let newDraftId = "";
      do {
        const parsed = parseExtractionParams(
          new URLSearchParams(`include_deleted=true&limit=1${cursor ? `&cursor=${cursor}` : ""}`),
          [],
        );
        if (!parsed.ok) throw new Error(parsed.message);
        const page = await withTenant(db, practiceId, (tx) => listResource(tx, practiceId, invoicesResource, parsed.params));
        seen.push(...(page.data as Invoice[]));
        cursor = page.pagination.next_cursor;

        if (!started && seen.some((i) => i.id === d0.id)) {
          started = true;
          fetchedD0 = true;
          // Amend a record that was already read.
          await editLines(d0.id, [{ description: "Synthetic dental check", quantity: 1, unitPrice: "60.00" }]);
          // Hold an amendment of a record not yet read in an open transaction:
          // its changed_at is set now, but it only becomes visible at commit.
          held = db.transaction(async (tx) => {
            await editLines(d2.id, [{ description: "Synthetic nail trim", quantity: 1, unitPrice: "20.00" }], tx as unknown as Database);
            heldWritten();
            await heldGate;
          });
          await heldDone;
          // Create a new record while paging continues.
          newDraftId = (await draft("Synthetic new-client exam", "70.00")).id;
        }
      } while (cursor);
      releaseHeld();
      await held;
      expect(fetchedD0).toBe(true);

      const count = (id: string) => seen.filter((i) => i.id === id).length;
      // Read, then amended: returned again later in the same pass.
      expect(count(d0.id)).toBe(2);
      // Created during the pass: returned once.
      expect(count(newDraftId)).toBe(1);
      // Unchanged records are never skipped and never repeated.
      expect(count(d1.id)).toBe(1);
      // The late-committed amendment was invisible during the pass: d2 was
      // returned once, with its original lines.
      const staleD2 = seen.filter((i) => i.id === d2.id);
      expect(staleD2).toHaveLength(1);
      expect(staleD2[0]!.subtotal).toBe("28.00");

      // A naive watermark (highest changed_at seen) misses the late commit.
      const highest = seen.reduce((max, i) => (i.changed_at > max ? i.changed_at : max), "");
      const naive = await extract<Invoice>(invoicesResource, `updated_since=${highest}&include_deleted=true`);
      expect(naive.some((i) => i.id === d2.id)).toBe(false);

      // An overlap window recovers it; de-duplicate by latest changed_at.
      const overlapSince = new Date(Date.parse(passStartedAt) - 5 * 60_000).toISOString();
      const recovered = await extract<Invoice>(invoicesResource, `updated_since=${overlapSince}&include_deleted=true`);
      expect(recovered.find((i) => i.id === d2.id)!.subtotal).toBe("20.00");
      const merged = new Map<string, Invoice>();
      for (const record of [...before, ...changedInvoices, ...seen, ...naive, ...recovered]) {
        const current = merged.get(record.id);
        if (!current || record.changed_at >= current.changed_at) merged.set(record.id, record);
      }

      // Compare with the source tables once changes have stopped.
      const sourceInvoices = await fixture.ownerDb
        .select({ id: schema.invoices.id, total: schema.invoices.total, status: schema.invoices.status })
        .from(schema.invoices)
        .where(eq(schema.invoices.practiceId, practiceId));
      const sourceLines = await fixture.ownerDb
        .select({ id: schema.invoiceItems.id, invoiceId: schema.invoiceItems.invoiceId })
        .from(schema.invoiceItems)
        .innerJoin(schema.invoices, eq(schema.invoices.id, schema.invoiceItems.invoiceId))
        .where(and(eq(schema.invoices.practiceId, practiceId), isNull(schema.invoiceItems.deletedAt)));
      expect([...merged.keys()].sort()).toEqual(sourceInvoices.map((i) => i.id).sort());
      for (const source of sourceInvoices) {
        const copy = merged.get(source.id)!;
        expect({ id: copy.id, total: copy.total, status: copy.status }).toEqual(source);
        expect(copy.lines.map((l) => l.id).sort()).toEqual(
          sourceLines.filter((l) => l.invoiceId === source.id).map((l) => l.id).sort(),
        );
      }
    } finally {
      process.env.DATABASE_URL = originalUrl;
      await fixture.close();
    }
  }, 300_000);
});
