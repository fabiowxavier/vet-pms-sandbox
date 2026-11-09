/**
 * Reset restricted to one synthetic dataset.
 *
 * Only a practice whose settings carry the `syntheticDataset` marker with the
 * requested dataset id can be removed. Rows are found through the practice id
 * and the foreign-key graph (so sessions or audit entries created while
 * inspecting the dataset in the UI are included), then deleted in a single
 * statement inside one transaction.
 *
 * Append-only ledgers (prescription events, dispense charges, finalized SOAP
 * notes) refuse deletes unless the table owner enables the documented
 * `app.ledger_maintenance` session flag. The reset uses that owner-only path
 * for this practice's rows; it never disables triggers or constraints. The
 * repository-wide `pnpm db:reset`, which truncates every table, is unrelated.
 */
import { sql } from "drizzle-orm";
import type { Database } from "@openpims/db/client";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type SyntheticPracticeRow = { id: string; name: string; datasetId: string };

export async function findSyntheticPractices(db: Database, datasetId?: string): Promise<SyntheticPracticeRow[]> {
  const rows = (await db.execute(sql`
    select id::text as id, name, settings #>> '{syntheticDataset,datasetId}' as "datasetId"
    from practices
    where settings ? 'syntheticDataset'
      and (${datasetId ?? null}::text is null or settings #>> '{syntheticDataset,datasetId}' = ${datasetId ?? null}::text)
    order by created_at
  `)) as unknown as SyntheticPracticeRow[];
  return rows;
}

type ForeignKey = { child: string; childColumn: string; parent: string; parentColumn: string };

function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Unexpected identifier: ${name}`);
  return `"${name}"`;
}

/** Build a predicate per table that selects only rows owned by the practice. */
async function scopedPredicates(db: Database, practiceId: string): Promise<Map<string, string>> {
  const practiceTables = (await db.execute(sql`
    select c.table_name as name
    from information_schema.columns c
    join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
    where c.table_schema = 'public' and c.column_name = 'practice_id' and t.table_type = 'BASE TABLE'
  `)) as unknown as { name: string }[];
  const fks = (await db.execute(sql`
    select cl.relname as child, ca.attname as "childColumn", pl.relname as parent, pa.attname as "parentColumn"
    from pg_constraint con
    join pg_class cl on cl.oid = con.conrelid
    join pg_class pl on pl.oid = con.confrelid
    join pg_namespace n on n.oid = cl.relnamespace and n.nspname = 'public'
    join pg_attribute ca on ca.attrelid = con.conrelid and ca.attnum = con.conkey[1]
    join pg_attribute pa on pa.attrelid = con.confrelid and pa.attnum = con.confkey[1]
    where con.contype = 'f' and array_length(con.conkey, 1) = 1
  `)) as unknown as ForeignKey[];

  const literal = `'${practiceId}'::uuid`;
  // Layer 0: the practice row and every table that carries practice_id.
  const known = new Map<string, string>();
  known.set("practices", `${ident("id")} = ${literal}`);
  for (const { name } of practiceTables) known.set(name, `${ident("practice_id")} = ${literal}`);

  // Later layers: tables without practice_id whose rows reference an
  // already-scoped table (for example sessions -> users). Each layer only
  // derives from settled predicates, so the result is deterministic.
  for (let layer = 0; layer < 6; layer++) {
    const next = new Map<string, string[]>();
    for (const fk of fks) {
      if (known.has(fk.child) || fk.child === fk.parent || !known.has(fk.parent)) continue;
      const clause = `${ident(fk.childColumn)} in (select ${ident(fk.parentColumn)} from ${ident(fk.parent)} where ${known.get(fk.parent)})`;
      next.set(fk.child, [...(next.get(fk.child) ?? []), clause]);
    }
    if (next.size === 0) break;
    for (const [table, clauses] of next) known.set(table, clauses.join(" or "));
  }
  return known;
}

export type ResetReport = { practiceId: string; deletedByTable: Record<string, number>; otherRowsUnchanged: boolean };

export async function resetSyntheticDataset(db: Database, datasetId: string): Promise<ResetReport | null> {
  const [practice, ...others] = await findSyntheticPractices(db, datasetId);
  if (!practice) return null;
  if (others.length) throw new Error(`More than one practice is marked as synthetic dataset "${datasetId}"; resolve manually.`);
  if (!UUID.test(practice.id)) throw new Error("Unexpected practice id format.");

  return db.transaction(async (tx) => {
    // Re-check the marker inside the transaction before deleting anything.
    const [marked] = (await tx.execute(sql`
      select 1 as ok from practices
      where id = ${practice.id}::uuid and settings #>> '{syntheticDataset,datasetId}' = ${datasetId}
      for update
    `)) as unknown as { ok: number }[];
    if (!marked) throw new Error("Practice is no longer marked as this synthetic dataset; nothing deleted.");

    const predicates = await scopedPredicates(tx as unknown as Database, practice.id);
    const tables = [...predicates.keys()].sort();
    // Count every base table, not only the scoped ones, so a cascade into an
    // unrelated table would be caught and rolled back.
    const allTables = (
      (await tx.execute(sql`
        select table_name as name from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE' order by 1
      `)) as unknown as { name: string }[]
    ).map((r) => r.name);
    const totalsBefore = new Map<string, number>();
    for (const table of allTables) {
      const [row] = (await tx.execute(sql.raw(`select count(*)::int as n from ${ident(table)}`))) as unknown as { n: number }[];
      totalsBefore.set(table, row!.n);
    }

    await tx.execute(sql`select set_config('app.ledger_maintenance', 'on', true)`);
    const ctes = tables.map((table, i) => `d${i} as (delete from ${ident(table)} where ${predicates.get(table)} returning 1)`);
    const selects = tables.map((table, i) => `(select count(*) from d${i})::int as ${ident(table)}`);
    const [deleted] = (await tx.execute(sql.raw(`with ${ctes.join(",\n")} select ${selects.join(", ")}`))) as unknown as Record<string, number>[];

    let otherRowsUnchanged = true;
    for (const table of allTables) {
      const [row] = (await tx.execute(sql.raw(`select count(*)::int as n from ${ident(table)}`))) as unknown as { n: number }[];
      if (row!.n !== totalsBefore.get(table)! - (deleted![table] ?? 0)) otherRowsUnchanged = false;
    }
    for (const table of tables) {
      const [left] = (await tx.execute(
        sql.raw(`select count(*)::int as n from ${ident(table)} where ${predicates.get(table)}`),
      )) as unknown as { n: number }[];
      if (left!.n !== 0) throw new Error(`Reset left ${left!.n} rows in ${table}; rolled back.`);
    }
    if (!otherRowsUnchanged) throw new Error("Row counts outside the synthetic practice changed; rolled back.");
    await tx.execute(sql`select set_config('app.ledger_maintenance', 'off', true)`);

    const deletedByTable = Object.fromEntries(Object.entries(deleted!).filter(([, n]) => n > 0).sort());
    return { practiceId: practice.id, deletedByTable, otherRowsUnchanged };
  });
}
