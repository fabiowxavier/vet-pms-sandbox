#!/usr/bin/env node
/**
 * Synthetic clinic history for local sandboxes.
 *
 *   pnpm synthetic:plan     --preset sample-1m   # dry run: counts only, no database
 *   pnpm synthetic:generate --preset sample-1m   # insert + write expected results
 *   pnpm synthetic:validate --preset sample-1m   # compare database to expected results
 *   pnpm synthetic:reset    --preset sample-1m --confirm sample-1m
 *
 * See docs/synthetic-data.md.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertSafeDatabaseTarget, parseSyntheticArgs } from "./config";
import { expectedResultsFromPlan, type ExpectedResults } from "./metrics";
import { buildPlan } from "./plan";

const REPO_ROOT = resolve(import.meta.dirname, "../../../..");

function loadRootEnv() {
  const envPath = resolve(REPO_ROOT, ".env");
  if (existsSync(envPath)) {
    // Existing shell exports win, matching how `pnpm dev` loads the root .env.
    const before = { ...process.env };
    process.loadEnvFile(envPath);
    Object.assign(process.env, before);
  }
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const args = parseSyntheticArgs(process.argv.slice(2), today);
  const outDir = resolve(REPO_ROOT, args.outDir);
  const expectedPath = resolve(outDir, "expected-results.json");
  const { config } = args;

  if (args.command === "plan") {
    const plan = buildPlan(config);
    const expected = expectedResultsFromPlan(plan);
    console.log(JSON.stringify({ meta: expected.meta, counts: expected.metrics.counts, invoices: expected.metrics.financial.invoices }, null, 2));
    return;
  }

  loadRootEnv();
  assertSafeDatabaseTarget(process.env.DATABASE_URL, process.env, args.allowRemoteDatabase);
  const { db } = await import("@openpims/db/client");

  if (args.command === "generate") {
    const started = Date.now();
    const plan = buildPlan(config);
    const expected = expectedResultsFromPlan(plan);
    const { writePlan } = await import("./write");
    const password = process.env.SYNTHETIC_STAFF_PASSWORD || "password123";
    const { resetReport } = await writePlan(db, plan, expected, {
      replace: args.replace,
      expectedPath,
      staffPassword: password,
      onProgress: process.argv.includes("--verbose")
        ? (message) => console.log(`  ${message} (rss ${Math.round(process.memoryUsage().rss / 1e6)} MB)`)
        : undefined,
    });
    if (resetReport) console.log(`Replaced previous dataset (practice ${resetReport.practiceId}).`);
    console.log(`Generated synthetic dataset "${config.datasetId}" in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    console.log(`  practice   ${plan.practiceId}  ${config.practiceName}`);
    console.log(`  window     ${config.startDate} .. ${config.endDate} (${config.timezone}), seed "${config.seed}"`);
    console.log(`  records    ${expected.metrics.counts.appointments} appointments, ${expected.metrics.counts.soapNotes} notes, ${expected.metrics.counts.invoices} invoices, ${expected.metrics.counts.payments} payments`);
    console.log(`  expected   ${expectedPath}`);
    console.log(`  sign in    ${plan.staffEmails.vet1} (veterinarian), ${plan.staffEmails.admin} (admin); password from SYNTHETIC_STAFF_PASSWORD or the local default`);
    return;
  }

  if (args.command === "validate") {
    if (!existsSync(expectedPath)) throw new Error(`No expected results at ${expectedPath}. Generate the dataset first.`);
    const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as ExpectedResults;
    const { validateDataset } = await import("./validate");
    const result = await validateDataset(db, expected);
    for (const check of result.checks) console.log(`${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
    const reportPath = resolve(outDir, "validation-report.json");
    writeFileSync(reportPath, `${JSON.stringify({ validatedAt: new Date().toISOString(), ok: result.ok, checks: result.checks }, null, 2)}\n`);
    console.log(`${result.ok ? "VALID" : "INVALID"}: ${result.checks.filter((c) => c.ok).length}/${result.checks.length} checks passed. Report: ${reportPath}`);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (args.command === "reset") {
    if (args.confirm !== config.datasetId) {
      throw new Error(`Reset deletes synthetic dataset "${config.datasetId}" only. Re-run with --confirm ${config.datasetId}.`);
    }
    const { resetSyntheticDataset } = await import("./reset");
    const report = await resetSyntheticDataset(db, config.datasetId);
    if (!report) {
      console.log(`No synthetic dataset "${config.datasetId}" in this database; nothing deleted.`);
    } else {
      const total = Object.values(report.deletedByTable).reduce((a, b) => a + b, 0);
      console.log(`Deleted ${total} rows of synthetic dataset "${config.datasetId}" (practice ${report.practiceId}); other practices unchanged.`);
      console.log(JSON.stringify(report.deletedByTable));
    }
    if (existsSync(expectedPath)) {
      const archived = `${expectedPath}.reset-${Date.now()}`;
      renameSync(expectedPath, archived);
      console.log(`Expected results moved to ${archived}`);
    }
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
