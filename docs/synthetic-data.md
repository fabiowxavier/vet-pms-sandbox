# Synthetic clinic history

Integrations, reporting tools and practice-analytics products need realistic
history to develop against: months or years of visits, notes, prescriptions,
dispensing, invoices and payments that hang together. Real clinic data cannot
be used for that. The synthetic-data generator builds a fictional clinic's
history inside a local OpenVPM database, through the same tables and
invariants the application uses, and writes a separate answer key so the
results of any extraction or analysis can be checked exactly.

The demonstration seed (`pnpm db:seed`) is unchanged and unrelated: it creates
a two-week demo practice around today's date. The synthetic generator creates
its own, separately marked practice.

## Quick start

Follow the [README quick start](../README.md#quick-start) first (database
running, migrations applied). Then:

```bash
pnpm synthetic:plan --preset sample-1m        # dry run: counts only, no database writes
pnpm synthetic:generate --preset sample-1m    # writes the dataset + answer key
pnpm synthetic:validate --preset sample-1m    # compares the database with the answer key
```

Presets:

| Preset       | Window                    | Starting households | Approx. volume                                   | Runtime (local) |
| ------------ | ------------------------- | ------------------- | ------------------------------------------------ | --------------- |
| `sample-1m`  | 2026-10-01 → 2026-10-31   | 150                 | ~70 appointments, ~60 invoices                   | ~1 s            |
| `three-year` | 2023-11-01 → 2026-10-31   | 300 (+5/month)      | ~6,000 appointments, ~6,800 invoices, ~6,750 payments | ~25 s      |

Options (all optional): `--dataset <id>`, `--seed <text>`, `--start
YYYY-MM-DD`, `--end YYYY-MM-DD`, `--households <n>`,
`--new-households-per-month <n>`, `--discrepancies-per-type <n>`, `--out
<dir>`, `--replace`, `--verbose`. The end date must be before today: the
generator writes history only.

The same seed and options always produce the same records, identifiers and
answer key.

### Signing in

The generator creates eight fictional staff accounts for the synthetic
practice, for example `priya.raman@<dataset>.synthetic.example`
(veterinarian) and `jordan.ellis@<dataset>.synthetic.example` (admin). The
password is `SYNTHETIC_STAFF_PASSWORD` if set, otherwise the local-development
default used by the demo seed. These are local sandbox accounts; never point
the generator at a shared or hosted database.

## Safety and isolation

- **Separate practice.** Every record belongs to one new practice whose
  settings carry a `syntheticDataset` marker. Row-level tenancy keeps it apart
  from the demo practice and any other data.
- **Local databases only.** The command refuses a non-local `DATABASE_URL`,
  `NODE_ENV=production`, Vercel, or hosted billing, unless you pass
  `--allow-remote-db` for an isolated sandbox.
- **No accidental overwrite.** `generate` refuses when the dataset already
  exists in the database or its answer key exists on disk. `--replace` removes
  that dataset inside the same transaction as the new insert.
- **All-or-nothing.** The dataset is inserted in one transaction, and the
  answer key is written before commit. A failure leaves nothing behind, and a
  failed `--replace` leaves the previous dataset in place.
- **Scoped reset.**

  ```bash
  pnpm synthetic:reset --preset sample-1m --confirm sample-1m
  ```

  This deletes only the practice carrying that dataset marker, its rows, and
  rows that reference them through foreign keys (for example, records added
  while trying the dataset out in the UI). Before committing, it re-counts
  every table and rolls back if any row outside that scope was removed. Append-only
  ledgers (prescription events, dispense charges, finalized SOAP notes)
  accept deletes only through the database owner's `app.ledger_maintenance`
  session flag; the reset uses that path for this practice's rows and never
  disables triggers or constraints. (`pnpm db:reset` is different: it
  truncates every table.)
- **External services stay off.** The generator never calls email, SMS,
  payment or AI providers. Contact details use reserved `.example` domains and
  555 numbers, and SMS consent is not recorded.

## How history is represented

OpenVPM's tRPC procedures stamp the current time on the records they write
(payments, prescription events, SOAP finalization, stock changes), so they
cannot record past events. The generator therefore mirrors each procedure's
write set with explicit historical timestamps, and lets the database's own
triggers and checks validate every row:

- **Appointments** are booked into practice-local slots (converted to UTC
  across daylight-saving changes) at least 15 minutes after the booking was
  made, and end checked out, cancelled (before the start time) or no-show.
- **Consultation notes** are inserted as finalized with explicit
  `created_at`, `finalized_at` and finalizer. The SOAP lifecycle trigger would
  otherwise default `finalized_at` to the time of insertion.
- **Prescriptions** follow `records.createPrescription`: the prescription, its
  `created` event, the stock deduction and, for clinic stock, a pending
  dispense charge. Refills follow `recordPrescriptionRefill`
  (`refill_dispensed` for clinic stock, `refill_authorized` for written
  scripts). Course ends follow the nightly expiry job.
- **Billing** follows the dispense-charge queue and invoice services: dispense
  charges become invoice lines and are then marked invoiced. Totals use the
  application's own money, quantity and tax calculators. Payments use the
  recorded method and received time, and fully paid accounts-receivable visits
  update the closeout as `recordPayment` does.
- **Overdue** is a staff action in OpenVPM, so it is modelled as a monthly
  accounts-receivable review: on the first open day of each month, unpaid
  invoices past their due date are marked overdue. Past-due invoices that have
  not reached a review yet stay `sent`.
- **Inventory** starts from an opening quantity at go-live. Dispensing and
  retail product lines deduct stock, and supplier receipts are recorded as
  stock adjustments when a product falls below its reorder point.
- **Go-live.** The clinic starts using OpenVPM two weeks before the start date
  and registers its existing households then. Every event lies between go-live
  and the end of the end date (the "as of" instant); later events (payments,
  lab results, follow-ups) are left in the state they would be in at that
  moment.

## What the data contains

Fictional owners, patients (dogs, cats, rabbits, birds, reptiles), eight staff,
wellness visits with vaccinations, problem visits from template-driven
scenarios, repeat visits (rechecks and monitoring), short and long SOAP notes,
laboratory results, problem-list entries, prescriptions (clinic-dispensed and
written scripts), dispensing records, counter refills, invoices, partial and
late payments, overdue accounts, and stock receipts.

**Suspected versus confirmed conditions.** Diagnostic work-ups (hypothyroidism,
hyperthyroidism, diabetes mellitus) start with a SUSPECTED assessment and a
laboratory test. A results visit then records CONFIRMED (problem-list entry,
long-term medication) or RULED OUT. If the results visit is cancelled, the
suspicion stays unresolved. OpenVPM has no diagnosis-certainty field, so
certainty lives in the SOAP assessment and the problem list.

**A prescription is not proof of dispensing.** Written scripts have no product
link, no stock movement and no dispense charge, and their refills are
authorisations only. Dispensing is recorded by prescription events with a
product and their dispense charges.

**Labels.** The practice name and settings, client notes, appointment notes,
every SOAP note, prescription instructions and payment notes are marked
synthetic. Catalogue codes start with `SYN-`, and accounts use
`.synthetic.example` addresses.

## Answer key and validation

`generate` writes `synthetic-output/<dataset>/expected-results.json`, which is
git-ignored. It contains:

- exact counts (by status, type, species and record kind);
- financial totals (invoiced, tax, paid, outstanding, by status, by month, by
  payment method) and every partially paid invoice;
- inventory movements and closing stock per product;
- repeat-visit pairs, cancelled and no-show appointments, written
  prescriptions;
- each suspected condition with its outcome and supporting records;
- the deliberately introduced discrepancies, with the records involved.

The answer key is never stored in the database, so nothing reachable through
the PMS or its extraction API reveals it. Keep it out of any system that the
software under test can read.

Deliberate discrepancies (the number per type is configurable):

| Type                                                  | What was introduced                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `unbilled_dispense`                                   | Medication dispensed from clinic stock (stock deducted) but never invoiced           |
| `price_below_catalog_without_adjustment`              | Exam fee charged below the catalogue price with no invoice adjustment                |
| `billed_visit_without_consultation_note`              | Checked-out, invoiced visit with no SOAP note                                        |
| `prescription_only_product_sold_without_prescription` | Prescription-only medication sold as a retail line with no prescription for the patient |

Apart from these, clinical, dispensing and financial records are consistent.
`validate` checks this independently of the generator:

1. recomputes every metric with SQL and compares it exactly with the answer
   key;
2. checks invariants: invoice arithmetic, payments versus paid amounts,
   invoice status, dispense-charge and invoice-line links, the dispensing
   ledger, written scripts never dispensed, one completed closeout per
   checked-out visit, no unresolved work items, the stock equation (opening +
   receipts − dispensed − retail = closing), the stock ledger replayed in time
   order (never negative, each receipt's recorded balance correct), every
   timestamp within the historical window, event ordering (bookings before
   visits, updates after creation, notes, invoices, payments and follow-ups in
   sequence), labels present, and no answer-key content in the database;
3. runs SQL detectors that must find exactly the planted discrepancies and
   nothing else.

It writes `validation-report.json` next to the answer key and exits non-zero
on any failure.

## Verifying the extraction API

With the app running (`pnpm dev`, or a production build with `next start`):

```bash
pnpm synthetic:verify-api --preset sample-1m            # read-only checks
pnpm synthetic:verify-api --preset sample-1m --amend    # also amends records; regenerate afterwards
```

This creates temporary API keys for the synthetic practice only (deleted at
the end), pages every [read-only extraction endpoint](api/README.md#read-only-extraction-endpoints),
and checks that there are no gaps or duplicates, that counts, totals and stock
reconcile with the answer key, that missing, invalid and under-scoped keys are
refused, and that no other practice's records are visible. With `--amend` it
adds a note addendum, a payment and an invoice-line replacement, then checks
that `updated_since` returns exactly those changes. The answer key is read from
disk by this command; the API never serves it.

## Limitations

- **Species and herd workflows.** Only companion species are generated. The
  species list includes production animals, but OpenVPM models every patient
  as an individual animal: there is no herd or flock entity, group treatment,
  batch dispensing, or withdrawal-period tracking. Generating herds as
  hundreds of individual patients would misrepresent those workflows, so they
  are not generated.
- **Equine patients are not generated**, and exotic medicine is thin: birds and
  reptiles receive wellness examinations only, and rabbits wellness plus one
  eye scenario.
- **No date of death or deactivation date** exists on patients, so the
  population only grows.
- **Static prices and flat demand.** The price list does not change over the
  window, and demand has no seasonality.
- **Not generated:** estimates, voids, refunds, invoice adjustments, controlled
  substances, procedures, communications and reminders, audit-log entries,
  online (Stripe) payments, and staff changes.
- **Volume.** The default three-year population (300 starting households)
  produces fewer visits than a busy three-veterinarian clinic would. Use
  `--households` to scale up.
- **Problem status.** Confirmed conditions are recorded as `active`, as the
  problem-list service creates them; nothing marks them chronic or resolved
  later.

## Code

`apps/web/scripts/synthetic/`: `config.ts` (presets, safety), `catalog.ts`
(fictional reference data and note templates), `plan.ts` (deterministic
simulation), `metrics.ts` (answer key), `write.ts` (transactional insert),
`reset.ts` (scoped reset), `validate.ts` (SQL validation), `cli.ts`. Unit tests
in `__tests__/` cover determinism, safety refusals, time conversion and plan
invariants without a database.
