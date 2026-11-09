# OpenVPM REST API (v1)

A versioned, public REST API over OpenVPM's core records. It is intended for
third-party integrators (booking, reminders, client comms, AI agents) that read
and write practice data without using the internal tRPC client.

> **Compatibility layer.** The `v1` surface is OpenVPM's own clean contract and
> doubles as the reference implementation for vendor-compatible APIs. Each
> response shape is owned by an explicit schema and frozen independently of the
> internal database — internal columns can change without breaking you. A
> vendor-specific "identical-twin" surface (so an existing integration can point
> at OpenVPM with zero changes) is added as a sibling namespace; see
> [Adding a compatibility target](../../CONTRIBUTING.md#adding-a-compatibility-endpoint-or-target).

## Authentication

Every request requires a scoped API key. A practice admin creates one from
**Settings → API Keys** (backed by the `apiKeys` tRPC router). The raw key is
shown **once** at creation — store it securely.

Send it on every request as a bearer token (preferred) or `X-API-Key`:

```bash
curl https://demo.openvpm.com/api/v1/clients \
  -H "Authorization: Bearer ovpm_xxxxxxxxxxxxxxxxxxxxxxxx"

# equivalent
curl https://demo.openvpm.com/api/v1/clients \
  -H "X-API-Key: ovpm_xxxxxxxxxxxxxxxxxxxxxxxx"
```

Keys are stored as bcrypt hashes (never in plaintext) and are scoped to a single
practice — a key can only ever read or write its own practice's data.

### Scopes

| Scope                | Grants                                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------ |
| `clients:read`       | List/read clients                                                                                            |
| `patients:read`      | List/read patients                                                                                           |
| `appointments:read`  | List/read appointments                                                                                       |
| `appointments:write` | Create appointments                                                                                          |
| `records:read`       | Read SOAP notes (with addenda and corrections) and prescriptions; see the extraction section below           |
| `records:write`      | Create clinical record entries such as SOAP notes                                                            |
| `billing:read`       | Read invoices, invoice lines, payments and invoice adjustments                                               |
| `catalog:read`       | Read products and services                                                                                   |
| `inventory:read`     | Read dispensing events and stock movements                                                                   |
| `agent:run`          | Run the OpenVPM Agent over the API                                                                           |
| `agent:write`        | Allow write-enabled agent runs when paired with `agent:run`; write tools still require their resource scopes |
| `*`                  | All of the above                                                                                             |

A request missing the required scope returns `403`.
API key creation rejects `agent:write` unless the key also includes `agent:run`
or `*`, because `agent:write` only enables write mode for agent runs.

## Rate limits

Each key is limited to **600 requests/minute**. Over the limit returns `429`
with `Retry-After` and `X-RateLimit-*` headers.

Rate limits are enforced through the shared `rate_limit_buckets` table, so the
budget follows the key across serverless instances and process restarts. Expired
buckets are removed by the scheduled cleanup job.

## Error format

All errors use a single envelope:

```json
{ "error": { "message": "API key missing required scope: appointments:write" } }
```

Validation errors (`400`) include field detail:

```json
{
  "error": {
    "message": "Validation failed",
    "fields": { "end_time": ["end_time must be after start_time"] }
  }
}
```

| Status | Meaning                                      |
| ------ | -------------------------------------------- |
| `400`  | Malformed JSON or failed validation          |
| `401`  | Missing or invalid API key                   |
| `403`  | Key lacks the required scope                 |
| `404`  | Resource not found (or not in your practice) |
| `429`  | Rate limit exceeded                          |

## Endpoints

List responses use a `{ data, pagination }` envelope; single-resource responses
use `{ data }`.

### `GET /api/v1/clients`

Scope `clients:read`. Query: `limit` (default 25, max 100), `offset`.

```json
{
  "data": [
    {
      "id": "…",
      "first_name": "Jane",
      "last_name": "Doe",
      "email": "jane@example.com",
      "phone": "555-0100",
      "address": "1 Main St",
      "city": "Tampa",
      "state": "FL",
      "zip": "33601",
      "preferred_contact_method": "email",
      "notes": null,
      "created_at": "2026-01-02T03:04:05.000Z",
      "updated_at": "2026-01-02T03:04:05.000Z"
    }
  ],
  "pagination": { "limit": 25, "offset": 0, "total": 1 }
}
```

### `GET /api/v1/clients/:id`

Scope `clients:read`. Returns `{ data: <client> }` or `404`.

### `GET /api/v1/patients`

Scope `patients:read`. Query: `limit`, `offset`, optional `client_id`.
Species are normalized to integrator-friendly values (`dog`, `cat`, `bird`,
`rabbit`, `reptile`, `horse`, `other`) and the internal sex enum is split into
`sex` (`male`/`female`/`unknown`) + `neutered` (boolean | null).

### `GET /api/v1/patients/:id`

Scope `patients:read`. Returns `{ data: <patient> }` or `404`.

### `GET /api/v1/appointments`

Scope `appointments:read`. Query: `limit`, `offset`, optional `client_id`,
`patient_id`, `status`, `from`, and `to`. `status` must be one of `scheduled`,
`confirmed`, `checked_in`, `in_exam`, `checked_out`, `no_show`, or `cancelled`.
Date filters must be valid ISO dates (`YYYY-MM-DD`) or timezone-qualified ISO
timestamps and match appointment `start_time`. Date-only filters are interpreted
as UTC calendar-day bounds (`from` starts at `00:00:00.000Z`; `to` ends at
`23:59:59.999Z`).

```json
{
  "data": [
    {
      "id": "…",
      "start_time": "2026-03-01T09:00:00.000Z",
      "end_time": "2026-03-01T09:30:00.000Z",
      "status": "scheduled",
      "client_id": "…",
      "patient_id": "…",
      "doctor_id": "…",
      "type_id": "…",
      "room_id": "…",
      "notes": "Annual exam",
      "created_at": "2026-01-02T03:04:05.000Z",
      "updated_at": "2026-01-02T03:04:05.000Z"
    }
  ],
  "pagination": { "limit": 25, "offset": 0, "total": 1 }
}
```

### `GET /api/v1/appointments/:id`

Scope `appointments:read`. Returns `{ data: <appointment> }` or `404`.

### `POST /api/v1/appointments`

Scope `appointments:write`. Body:

```json
{
  "start_time": "2026-03-01T09:00:00.000Z",
  "end_time": "2026-03-01T09:30:00.000Z",
  "client_id": "…",
  "patient_id": "…",
  "doctor_id": "…",
  "type_id": "…",
  "room_id": "…",
  "notes": "Annual exam"
}
```

`start_time`/`end_time` are required timezone-qualified ISO-8601 timestamps
(`end_time` must be after `start_time`); all ids and `notes` are optional. Returns `201` with
`{ data: <appointment> }` and fires the `appointment.created` webhook to any
subscribed endpoints with camelCase appointment fields (see the
[Webhooks](../../README.md#webhooks) section).

### `POST /api/v1/soap-notes`

Scope `records:write`. Create an immediately finalized, immutable SOAP note
from an external AI scribe. The clinician should review the content before the
integration submits it. Body:

```json
{
  "patient_id": "…",
  "appointment_id": "…",
  "author_id": "…",
  "subjective": "Owner reports decreased appetite x3 days.",
  "objective": "T: 101.5F, HR: 120, RR: 24. Mild dehydration.",
  "assessment": "Suspect early-stage renal disease.",
  "plan": "CBC/Chem panel, urinalysis. Recheck in 2 weeks.",
  "source": "scribenote"
}
```

`patient_id`, `appointment_id`, and `source` are required. The appointment must
belong to the same patient/practice and be an active in-exam appointment whose
clinical closeout has not been finalized. `author_id` is optional when the
appointment has an assigned doctor; otherwise it must identify an active admin
or veterinarian in the authenticated practice. At least one SOAP section must
contain clinical text. Returns `201` with `{ data: <soap_note> }` and fires the
`soap_note.created` webhook. Returns `409` if the encounter already has a saved
SOAP draft or an effective finalized SOAP note; integrations must not treat
this endpoint as an editable draft workflow.

### `POST /api/v1/agent`

Scope `agent:run`. Run the OpenVPM Agent over the API, scoped to the key's
practice. Body:

```json
{
  "instruction": "Which patients are overdue for vaccinations?",
  "allow_writes": false
}
```

`instruction` must contain non-whitespace text and is trimmed before the agent
runs. `allow_writes` (default `false`) gates write tools such as booking
appointments and recording vitals. Requests with
`allow_writes: true` also require `agent:write`; when the agent invokes a write
tool, the key must also carry that tool's resource scope, such as
`appointments:write` for booking or `records:write` for vitals. Returns
`{ data: { text, toolCalls, iterations, stopReason } }`, where `toolCalls`
traces every tool the agent invoked. On OpenVPM Cloud, a card-free trial
returns `403` until billing setup is confirmed by the signed Stripe Checkout
webhook; adding a card does not end the free trial. Returns `503` if the
configured model provider is unavailable (Vertex AI workload identity settings
for hosted Gemini, or `ANTHROPIC_API_KEY` for an explicit Claude model).

## Read-only extraction endpoints

These endpoints let an integration (reporting, practice analytics, a data
warehouse) copy historical clinical, financial and inventory records and keep
the copy current. They are read-only and use the same API keys, error format
and rate limits as the rest of `v1`.

| Scope            | Grants                                                                  |
| ---------------- | ----------------------------------------------------------------------- |
| `records:read`   | Consultation (SOAP) notes with addenda and corrections; prescriptions   |
| `billing:read`   | Invoices, invoice lines, payments, invoice adjustments                  |
| `catalog:read`   | Products and services                                                   |
| `inventory:read` | Dispensing events and stock movements                                   |

Grant only the scopes an integration needs. `*` includes all of them.

### Conventions

- **Practice scope.** A key only ever sees its own practice's records. A record
  of another practice is indistinguishable from a missing one (`404`).
- **Identifiers.** Every record has a stable UUID `id` and references related
  records by id (`patient_id`, `invoice_id`, `prescription_id`, …).
- **Timestamps.** `created_at`, `updated_at`, `deleted_at` (null unless
  soft-deleted) and `changed_at` are ISO-8601 UTC with millisecond precision
  (`2026-10-14T18:22:03.512Z`). Sub-millisecond digits are truncated, never
  rounded up, so passing a record's `changed_at` back as `updated_since`
  (inclusive) always includes that record. Dates are `YYYY-MM-DD`.
- **Money** is a decimal string (`"45.00"`), never a float. Quantities are
  numbers (up to three decimals).
- **Ordering and paging.** Lists are ordered by `(changed_at, id)` and paged
  with an opaque cursor. Request `?limit=` (1–100, default 25) and pass
  `pagination.next_cursor` as `?cursor=` until it is `null`. Each page is a
  separate read, not a snapshot of the whole list: see
  [what is guaranteed while records change](#extraction-while-records-change).
  `offset` is rejected on these endpoints.
- **Totals.** `pagination.total` counts every record matching the filters (not
  just the remaining pages), so a full extraction can be checked against it.

```json
{
  "data": [ { "id": "…", "changed_at": "2026-10-14T18:22:03.512Z", "…": "…" } ],
  "pagination": { "limit": 100, "next_cursor": "eyJ0IjoiMjAyNi0…", "has_more": true, "total": 6690 }
}
```

### Incremental extraction and change detection

Each record has a `changed_at`: the latest time the record **or anything that
belongs to it** changed.

| Resource            | `changed_at` is the latest of                                                        |
| ------------------- | ------------------------------------------------------------------------------------ |
| SOAP notes          | the note, its addenda, its corrections (entered in error), its replacement links     |
| Prescriptions       | the prescription and its lifecycle events (refills, completion, cancellation, expiry) |
| Invoices            | the invoice, its lines (including removed ones), payments and adjustments            |
| Dispensing events   | the dispensing event and its billing state (pending → invoiced or waived)            |
| Stock movements     | the movement (invoice sales also when the line is removed or the invoice voided)     |
| Lines, payments, adjustments, products, services | the record's own `updated_at`                           |

To keep a copy current:

1. Note the time **before** you start a pass (`pass_started_at`), then page
   to the end with `?include_deleted=true` (plus `updated_since` after the
   first pass).
2. Upsert every record by `id`, keeping the version with the latest
   `changed_at`. The same record can arrive more than once in a pass.
3. Start the next pass with `updated_since = pass_started_at − overlap`, where
   the overlap is longer than the longest write transaction you expect (5
   minutes is a comfortable default). Do not use the highest `changed_at` you
   received as the next watermark on its own: see below.

How each kind of change appears:

- **New records** appear with `changed_at` equal to their creation time.
- **Amended records** reappear with a later `changed_at`:
  - a SOAP note gains an entry in `addenda` (finalized notes are never edited
    in place);
  - a note marked entered in error gains an entry in `corrections` and
    `effective: false`; if it was replaced, `replaced_by_note_id` points to the
    new note, whose `replaces_note_id` points back;
  - when an invoice's charges are re-saved, OpenVPM soft-deletes the old lines
    and inserts new ones with new ids. `/invoice-lines?include_deleted=true`
    returns the removed lines as tombstones and the new lines as new records,
    and the parent invoice reappears with the current `lines` and totals;
  - a payment or adjustment reappears on its own endpoint and also bumps its
    invoice's `changed_at`. A refund is a new payment record with a negative
    `amount`, not a change to the original payment;
  - a prescription status change or refill appends to `events`.
- **Deleted records**: OpenVPM soft-deletes (sets `deleted_at`). Deleted
  records are hidden unless `include_deleted=true`, which returns them as
  tombstones with `deleted_at` set. A voided invoice is not deleted: it stays
  with `status: "void"`, and its stock-affecting lines are marked
  `reversed: true` in `/stock-movements`.

#### Extraction while records change

Each page is read in its own transaction, so a pass is not a point-in-time
snapshot. Tested behaviour (see `server/__tests__/extraction-sync.integration.test.ts`
and `pnpm synthetic:verify-api --concurrency`):

**Guaranteed within one pass**
- A record that was committed before the pass started and is not changed
  during it is returned exactly once.
- A record created or changed (and committed) before the pass reaches the end
  is returned with that newer version, because its `changed_at` moves it
  ahead of the cursor.

**Expected within one pass (handle by de-duplicating)**
- A record changed **after** it was read is returned again later in the same
  pass (a duplicate with a later `changed_at`). Keep the latest version.
- `pagination.total` can change between pages.

**Recovered by the next pass, not by the current one**
- `changed_at` is set when a change is written, not when its transaction
  commits. A change that commits after the pass has moved past its
  `changed_at` is invisible to that pass, and a naive next watermark (the
  highest `changed_at` received) misses it permanently. Starting the next pass
  from `pass_started_at − overlap` returns it. In the tests, the late commit
  was missed by the naive watermark and recovered by a 5-minute overlap, after
  which the merged copy matched the source tables exactly.

**Remaining limitations**
- This is at-least-once delivery, not exactly-once: expect duplicates and
  upsert by `id`.
- A write transaction that stays open longer than your overlap window can
  still be missed. Size the overlap to your environment.
- A copy is only as current as its last completed pass; there is no change
  stream or webhook for these resources.

#### Limitations
- **Hard deletes are not visible.** Draft SOAP notes can be discarded
  outright, so only finalized notes are exposed. Database-level maintenance
  (for example removing a synthetic dataset) is not reported.
- **Not covered:** clients, patients and appointments use the older offset
  endpoints without `updated_since`; vaccinations, lab results, procedures,
  communications, audit history and controlled-substance logs are not exposed
  yet.
- **Stock movements are reconstructed** from receipts and manual adjustments,
  dispensing events and product sales on invoices. The opening quantity set
  when a product was created is not a movement: use the product's
  `stock_quantity` as the authoritative current balance. Reversals from voided
  invoices are flags on the original movement, timed by the invoice's last
  update rather than recorded as separate movements.
- **Change times are computed, not indexed.** `updated_since` scans the
  practice's records of that type. This is fine for a single clinic's history
  but not tuned for very large multi-year datasets.
- **Price and catalogue history** is not versioned: products and services show
  their current values, while invoice lines keep the price actually charged.

### Endpoints

All endpoints accept `limit`, `cursor`, `updated_since` (ISO date or
timezone-qualified timestamp) and `include_deleted=true|false`, plus the
filters listed. `/:id` endpoints return `{ data }` and accept
`include_deleted=true`.

| Endpoint                                   | Scope            | Filters                                                    |
| ------------------------------------------ | ---------------- | ---------------------------------------------------------- |
| `GET /api/v1/soap-notes`, `/:id`           | `records:read`   | `patient_id`, `appointment_id`                             |
| `GET /api/v1/prescriptions`, `/:id`        | `records:read`   | `patient_id`, `appointment_id`, `product_id`               |
| `GET /api/v1/invoices`, `/:id`             | `billing:read`   | `client_id`, `patient_id`, `appointment_id`                |
| `GET /api/v1/invoice-lines`                | `billing:read`   | `invoice_id`, `item_id`                                    |
| `GET /api/v1/payments`                     | `billing:read`   | `invoice_id`                                               |
| `GET /api/v1/invoice-adjustments`          | `billing:read`   | `invoice_id`                                               |
| `GET /api/v1/products`, `/:id`             | `catalog:read`   | `location_id`                                              |
| `GET /api/v1/services`                     | `catalog:read`   | —                                                          |
| `GET /api/v1/dispensing-events`            | `inventory:read` | `patient_id`, `prescription_id`, `product_id`, `invoice_id` |
| `GET /api/v1/stock-movements`              | `inventory:read` | `product_id`                                               |

**Prescriptions are not dispensing.** A prescription is the clinician's order.
`supply` says whether it is linked to clinic stock (`clinic_stock`) or is a
written script filled elsewhere (`written`); neither proves anything was
supplied. Actual supply from clinic stock is a **dispensing event**: the
initial dispense or a refill, with the quantity, time, and billing state of its
charge (`pending`, `invoiced` on an invoice line, or `waived`). A written
script never has dispensing events; its refills appear only as
`refill_authorized` entries in the prescription's `events`.

**Stock movements** combine `stock_adjustment` (receipts and manual counts,
with `quantity_after`), `dispensing` (negative `quantity_change`) and
`invoice_sale` (product sold on an invoice without a prescription).

### Examples

```bash
# First full extraction of invoices (lines embedded), including tombstones
curl "https://pms.example.com/api/v1/invoices?limit=100&include_deleted=true" \
  -H "Authorization: Bearer ovpm_YOUR_KEY_HERE"

# Next page
curl "https://pms.example.com/api/v1/invoices?limit=100&include_deleted=true&cursor=NEXT_CURSOR" \
  -H "Authorization: Bearer ovpm_YOUR_KEY_HERE"

# Everything that changed since the last pass started, with a 5-minute overlap
curl "https://pms.example.com/api/v1/soap-notes?updated_since=2026-10-31T23:55:00Z&include_deleted=true&limit=100" \
  -H "Authorization: Bearer ovpm_YOUR_KEY_HERE"

# Dispensing for one prescription
curl "https://pms.example.com/api/v1/dispensing-events?prescription_id=PRESCRIPTION_UUID" \
  -H "X-API-Key: ovpm_YOUR_KEY_HERE"
```
