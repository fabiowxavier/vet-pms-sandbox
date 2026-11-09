/**
 * Inserts a synthetic plan in one transaction.
 *
 * Safety:
 * - refuses when the dataset already exists (database marker) or its expected
 *   results file exists, unless `--replace` is passed;
 * - with `--replace`, removes only that dataset, in the same transaction as
 *   the insert, so a failure leaves the previous dataset in place (reset.ts);
 * - the expected-results file is written before commit, so a failed write
 *   rolls the database back and nothing is left half-generated.
 *
 * Every row carries explicit historical timestamps from the plan. The only
 * UPDATE is the dispense-charge resolution the billing service performs after
 * the invoice line exists; it sets `updated_at` explicitly so Drizzle's
 * `$onUpdate` never substitutes the current time.
 */
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import {
  appointmentTypes,
  appointments,
  clients,
  dispenseChargeQueue,
  inventoryStockAdjustments,
  invoiceItems,
  invoices,
  labResultEvents,
  labResults,
  locations,
  patientWeights,
  patients,
  payments,
  practices,
  prescriptionEvents,
  prescriptions,
  problemList,
  products,
  rooms,
  services,
  soapNotes,
  users,
  vaccinationRecords,
  visitCloseouts,
  visitWorkItems,
} from "@openpims/db";
import type { Database } from "@openpims/db/client";
import type { ExpectedResults } from "./metrics";
import type { Plan } from "./plan";
import { findSyntheticPractices, resetSyntheticDataset } from "./reset";

const CHUNK = 400;

let progress: ((message: string) => void) | undefined;

async function insertAll(tx: Database, table: Parameters<Database["insert"]>[0], values: object[]) {
  for (let i = 0; i < values.length; i += CHUNK) {
    await tx.insert(table).values(values.slice(i, i + CHUNK) as never);
  }
  progress?.(`inserted ${values.length} rows into ${(table as unknown as Record<symbol, string>)[Symbol.for("drizzle:Name")] ?? "table"}`);
}

export type WriteOptions = {
  replace: boolean;
  expectedPath: string;
  staffPassword: string;
  onProgress?: (message: string) => void;
};

export async function writePlan(db: Database, plan: Plan, expected: ExpectedResults, options: WriteOptions) {
  progress = options.onProgress;
  const existing = await findSyntheticPractices(db, plan.config.datasetId);
  if ((existing.length || existsSync(options.expectedPath)) && !options.replace) {
    throw new Error(
      `Synthetic dataset "${plan.config.datasetId}" already exists` +
        (existing.length ? ` in the database (practice ${existing[0]!.id})` : "") +
        (existsSync(options.expectedPath) ? ` and/or at ${options.expectedPath}` : "") +
        ". Refusing to overwrite. Re-run with --replace, or reset it first.",
    );
  }

  const passwordHash = await bcrypt.hash(options.staffPassword, 10);
  const { rows } = plan;
  const resetReport = await db.transaction(async (tx) => {
    const t = tx as unknown as Database;
    // --replace removes the old dataset inside this transaction (as a
    // savepoint), so a failed insert keeps the previous dataset intact.
    const report = existing.length ? await resetSyntheticDataset(t, plan.config.datasetId) : null;
    await insertAll(t, practices, rows.practices);
    await insertAll(t, locations, rows.locations);
    await insertAll(t, users, rows.users.map((u) => ({ ...u, passwordHash })));
    await insertAll(t, rooms, rows.rooms);
    await insertAll(t, appointmentTypes, rows.appointmentTypes);
    await insertAll(t, services, rows.services);
    await insertAll(t, products, rows.products);
    await insertAll(t, clients, rows.clients);
    await insertAll(t, patients, rows.patients);
    await insertAll(t, patientWeights, rows.patientWeights);
    await insertAll(t, appointments, rows.appointments);
    await insertAll(t, soapNotes, rows.soapNotes);
    await insertAll(t, vaccinationRecords, rows.vaccinationRecords);
    await insertAll(t, labResults, rows.labResults);
    await insertAll(t, labResultEvents, rows.labResultEvents);
    await insertAll(t, problemList, rows.problemList);
    await insertAll(t, prescriptions, rows.prescriptions);
    await insertAll(t, prescriptionEvents, rows.prescriptionEvents);
    await insertAll(t, dispenseChargeQueue, rows.dispenseCharges);
    await insertAll(t, invoices, rows.invoices);
    await insertAll(t, invoiceItems, rows.invoiceItems);
    await insertAll(t, payments, rows.payments);
    for (const resolution of plan.dispenseResolutions) {
      const updated = await t
        .update(dispenseChargeQueue)
        .set({
          status: "invoiced",
          invoiceId: resolution.invoiceId,
          invoiceItemId: resolution.invoiceItemId,
          resolvedBy: resolution.resolvedBy,
          resolvedByName: resolution.resolvedByName,
          resolvedAt: resolution.resolvedAt,
          resolutionReason: null,
          updatedAt: resolution.resolvedAt,
        })
        .where(
          and(
            eq(dispenseChargeQueue.id, resolution.chargeId),
            eq(dispenseChargeQueue.practiceId, plan.practiceId),
            eq(dispenseChargeQueue.status, "pending"),
          ),
        )
        .returning({ id: dispenseChargeQueue.id });
      if (updated.length !== 1) throw new Error(`Dispense charge ${resolution.chargeId} could not be resolved.`);
    }
    await insertAll(t, visitWorkItems, rows.visitWorkItems);
    await insertAll(t, visitCloseouts, rows.visitCloseouts);
    await insertAll(t, inventoryStockAdjustments, rows.stockAdjustments);

    // Answer key last: if it cannot be written, the transaction rolls back.
    mkdirSync(dirname(options.expectedPath), { recursive: true });
    const temporary = join(dirname(options.expectedPath), `.expected-results.${process.pid}.tmp`);
    writeFileSync(temporary, `${JSON.stringify(expected, null, 2)}\n`, { mode: 0o644 });
    try {
      renameSync(temporary, options.expectedPath);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
    return report;
  });
  return { resetReport };
}
