import { sql } from "drizzle-orm";
import type { ExtractionResource } from "@/lib/compat/shared/extraction";
import { isoSql, toIsoTimestamp } from "@/lib/compat/shared/extraction";

/**
 * Read-only extraction resources for the v1 API. Each base query is scoped to
 * one practice and selects `id`, `changed_at` and `deleted_at`, which the
 * shared extraction layer uses for keyset paging, `updated_since`, and
 * tombstones. Money is returned as decimal strings (exact), quantities as
 * numbers, timestamps as ISO-8601 UTC, and dates as YYYY-MM-DD.
 */

type Row = Record<string, unknown>;

const iso = toIsoTimestamp;
const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const str = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

function stamps(row: Row) {
  return {
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    deleted_at: iso(row.deleted_at),
    changed_at: iso(row.changed_at),
  };
}

// --- Consultation (SOAP) notes ----------------------------------------------

export const soapNotesResource: ExtractionResource<Row> = {
  scope: "records:read",
  name: "SOAP note",
  filters: ["patient_id", "appointment_id"],
  // Finalized notes only: drafts are working copies that can be discarded
  // (hard-deleted), so they cannot be extracted reliably.
  base: (practiceId) => sql`
    select n.id, n.patient_id, n.appointment_id, n.author_id, n.author_name, n.revision,
      n.subjective, n.objective, n.assessment, n.plan, n.imported,
      n.finalized_at, n.finalized_by, n.finalizer_name,
      n.created_at, n.updated_at, n.deleted_at,
      coalesce((
        select json_agg(json_build_object(
          'id', a.id, 'author_id', a.author_id, 'author_name', a.author_name,
          'content', a.content, 'created_at', ${isoSql(sql`a.created_at`)}
        ) order by a.created_at, a.id)
        from soap_note_addenda a where a.practice_id = n.practice_id and a.soap_note_id = n.id
      ), '[]'::json) as addenda,
      coalesce((
        select json_agg(json_build_object(
          'id', c.id, 'action', c.action, 'reason', c.reason, 'corrected_by', c.corrected_by,
          'corrected_by_name', c.corrected_by_name, 'created_at', ${isoSql(sql`c.created_at`)}
        ) order by c.created_at, c.id)
        from clinical_record_corrections c where c.practice_id = n.practice_id and c.soap_note_id = n.id
      ), '[]'::json) as corrections,
      (select r.replacement_soap_note_id from soap_note_replacements r
        where r.practice_id = n.practice_id and r.source_soap_note_id = n.id
        order by r.created_at desc, r.id desc limit 1) as replaced_by_note_id,
      (select r.source_soap_note_id from soap_note_replacements r
        where r.practice_id = n.practice_id and r.replacement_soap_note_id = n.id
        order by r.created_at desc, r.id desc limit 1) as replaces_note_id,
      greatest(
        n.updated_at,
        (select max(a.created_at) from soap_note_addenda a where a.practice_id = n.practice_id and a.soap_note_id = n.id),
        (select max(c.created_at) from clinical_record_corrections c where c.practice_id = n.practice_id and c.soap_note_id = n.id),
        (select max(r.created_at) from soap_note_replacements r
          where r.practice_id = n.practice_id and (r.source_soap_note_id = n.id or r.replacement_soap_note_id = n.id))
      ) as changed_at
    from soap_notes n
    where n.practice_id = ${practiceId}::uuid and n.status = 'finalized'
  `,
  map: (row) => {
    const corrections = row.corrections as unknown[];
    return {
      id: row.id,
      patient_id: row.patient_id,
      appointment_id: row.appointment_id,
      author_id: row.author_id,
      author_name: row.author_name,
      revision: row.revision,
      subjective: row.subjective,
      objective: row.objective,
      assessment: row.assessment,
      plan: row.plan,
      imported: row.imported,
      finalized_at: iso(row.finalized_at),
      finalized_by: row.finalized_by,
      finalizer_name: row.finalizer_name,
      // False once the note is marked entered-in-error (and possibly replaced).
      effective: row.deleted_at === null && corrections.length === 0,
      addenda: row.addenda,
      corrections,
      replaced_by_note_id: row.replaced_by_note_id,
      replaces_note_id: row.replaces_note_id,
      ...stamps(row),
    };
  },
};

// --- Prescriptions (orders; dispensing is a separate resource) --------------

export const prescriptionsResource: ExtractionResource<Row> = {
  scope: "records:read",
  name: "Prescription",
  filters: ["patient_id", "appointment_id", "product_id"],
  base: (practiceId) => sql`
    select rx.id, rx.patient_id, rx.appointment_id, rx.medication_name, rx.dosage, rx.frequency,
      rx.quantity, rx.product_id, rx.refills_remaining, rx.prescribed_by, rx.start_date::text as start_date,
      rx.end_date::text as end_date, rx.status, rx.instructions, rx.created_at, rx.updated_at, rx.deleted_at,
      coalesce((
        select json_agg(json_build_object(
          'id', e.id, 'event_type', e.event_type, 'status_before', e.status_before, 'status_after', e.status_after,
          'refills_before', e.refills_before, 'refills_after', e.refills_after, 'quantity', e.quantity,
          'product_id', e.product_id, 'reason', e.reason, 'actor_id', e.actor_id, 'actor_name', e.actor_name,
          'created_at', ${isoSql(sql`e.created_at`)}
        ) order by e.created_at, e.id)
        from prescription_events e where e.practice_id = rx.practice_id and e.prescription_id = rx.id
      ), '[]'::json) as events,
      greatest(rx.updated_at, (select max(e.created_at) from prescription_events e
        where e.practice_id = rx.practice_id and e.prescription_id = rx.id)) as changed_at
    from prescriptions rx
    where rx.practice_id = ${practiceId}::uuid
  `,
  map: (row) => ({
    id: row.id,
    patient_id: row.patient_id,
    appointment_id: row.appointment_id,
    medication_name: row.medication_name,
    dosage: row.dosage,
    frequency: row.frequency,
    quantity: num(row.quantity),
    // "clinic_stock": linked to an inventory product; "written": a script
    // filled elsewhere. Neither is proof of supply: see /dispensing-events.
    supply: row.product_id ? "clinic_stock" : "written",
    product_id: row.product_id,
    refills_remaining: row.refills_remaining,
    prescribed_by: row.prescribed_by,
    start_date: row.start_date,
    end_date: row.end_date,
    status: row.status,
    instructions: row.instructions,
    events: (row.events as Row[]).map((e) => ({ ...e, quantity: num(e.quantity) })),
    ...stamps(row),
  }),
};

// --- Dispensing events (actual supply from clinic stock) ---------------------

export const dispensingEventsResource: ExtractionResource<Row> = {
  scope: "inventory:read",
  name: "Dispensing event",
  filters: ["patient_id", "prescription_id", "product_id", "invoice_id"],
  base: (practiceId) => sql`
    select e.id, e.prescription_id, e.patient_id, c.client_id, c.appointment_id, e.product_id,
      case e.event_type when 'created' then 'initial' else 'refill' end as dispense_type,
      e.quantity, e.actor_id as dispensed_by, e.actor_name as dispensed_by_name,
      e.created_at as dispensed_at, c.id as dispense_charge_id, c.status as billing_status,
      c.unit_price_snapshot, c.description_snapshot, c.invoice_id, c.invoice_item_id, c.resolved_at,
      c.resolution_reason, e.created_at, coalesce(c.updated_at, e.created_at) as updated_at,
      null::timestamptz as deleted_at,
      greatest(e.created_at, c.updated_at) as changed_at
    from prescription_events e
    left join dispense_charge_queue c on c.practice_id = e.practice_id and c.prescription_event_id = e.id
    where e.practice_id = ${practiceId}::uuid and e.product_id is not null
      and e.event_type in ('created', 'refill_dispensed')
  `,
  map: (row) => ({
    id: row.id,
    prescription_id: row.prescription_id,
    patient_id: row.patient_id,
    client_id: row.client_id,
    appointment_id: row.appointment_id,
    product_id: row.product_id,
    dispense_type: row.dispense_type,
    quantity: num(row.quantity),
    dispensed_at: iso(row.dispensed_at),
    dispensed_by: row.dispensed_by,
    dispensed_by_name: row.dispensed_by_name,
    billing: {
      dispense_charge_id: row.dispense_charge_id,
      // pending: not yet invoiced; invoiced: on invoice_id; waived: no charge.
      status: row.billing_status,
      unit_price: str(row.unit_price_snapshot),
      description: row.description_snapshot,
      invoice_id: row.invoice_id,
      invoice_line_id: row.invoice_item_id,
      resolved_at: iso(row.resolved_at),
      resolution_reason: row.resolution_reason,
    },
    ...stamps(row),
  }),
};

// --- Stock movements ---------------------------------------------------------

export const stockMovementsResource: ExtractionResource<Row> = {
  scope: "inventory:read",
  name: "Stock movement",
  filters: ["product_id"],
  base: (practiceId) => sql`
    select a.id, 'stock_adjustment' as movement_type, a.product_id, a.adjustment as quantity_change,
      a.quantity_after, a.reason, a.adjusted_by as actor_id, null::uuid as prescription_id,
      null::uuid as invoice_id, false as reversed, a.created_at as occurred_at,
      a.created_at, a.created_at as updated_at, null::timestamptz as deleted_at, a.created_at as changed_at
    from inventory_stock_adjustments a
    where a.practice_id = ${practiceId}::uuid
    union all
    select e.id, 'dispensing', e.product_id, -e.quantity, null, null, e.actor_id, e.prescription_id,
      null, false, e.created_at, e.created_at, e.created_at, null, e.created_at
    from prescription_events e
    where e.practice_id = ${practiceId}::uuid and e.product_id is not null
      and e.event_type in ('created', 'refill_dispensed')
    union all
    select i.id, 'invoice_sale', i.item_id, -i.quantity, null, i.description, null, null,
      v.id, (v.status = 'void'), i.created_at, i.created_at, i.updated_at, i.deleted_at,
      greatest(i.updated_at, case when v.status = 'void' then v.updated_at end)
    from invoice_items i
    join invoices v on v.id = i.invoice_id and v.practice_id = ${practiceId}::uuid
    join products p on p.id = i.item_id and p.practice_id = v.practice_id and p.inventory_tracked
    where i.item_type = 'product' and i.source_dispense_charge_id is null
      and i.source_prescription_id is null and not v.is_estimate
  `,
  map: (row) => ({
    id: row.id,
    movement_type: row.movement_type,
    product_id: row.product_id,
    quantity_change: num(row.quantity_change),
    quantity_after: num(row.quantity_after),
    reason: row.reason,
    actor_id: row.actor_id,
    prescription_id: row.prescription_id,
    invoice_id: row.invoice_id,
    reversed: row.reversed,
    occurred_at: iso(row.occurred_at),
    ...stamps(row),
  }),
};

// --- Invoices, lines, payments, adjustments ---------------------------------

const LINE_JSON = sql`json_build_object(
  'id', i.id, 'description', i.description, 'item_type', i.item_type, 'item_id', i.item_id,
  'quantity', i.quantity, 'unit_price', i.unit_price::text, 'total', i.total::text, 'taxable', i.taxable,
  'source_dispense_charge_id', i.source_dispense_charge_id, 'source_prescription_id', i.source_prescription_id,
  'created_at', ${isoSql(sql`i.created_at`)}, 'updated_at', ${isoSql(sql`i.updated_at`)}
)`;

export const invoicesResource: ExtractionResource<Row> = {
  scope: "billing:read",
  name: "Invoice",
  filters: ["client_id", "patient_id", "appointment_id"],
  base: (practiceId) => sql`
    select v.id, v.client_id, v.patient_id, v.appointment_id, v.status, v.is_estimate,
      v.subtotal::text as subtotal, v.tax::text as tax, v.total::text as total,
      v.paid_amount::text as paid_amount,
      coalesce((select sum(a.amount) from invoice_adjustments a where a.invoice_id = v.id and a.deleted_at is null), 0)::numeric(12,2)::text as adjusted_amount,
      v.due_date::text as due_date, v.created_at, v.updated_at, v.deleted_at,
      coalesce((select json_agg(${LINE_JSON} order by i.created_at, i.id)
        from invoice_items i where i.invoice_id = v.id and i.deleted_at is null), '[]'::json) as lines,
      greatest(v.updated_at,
        (select max(i.updated_at) from invoice_items i where i.invoice_id = v.id),
        (select max(p.updated_at) from payments p where p.invoice_id = v.id),
        (select max(a.updated_at) from invoice_adjustments a where a.invoice_id = v.id)) as changed_at
    from invoices v
    where v.practice_id = ${practiceId}::uuid
  `,
  map: (row) => ({
    id: row.id,
    client_id: row.client_id,
    patient_id: row.patient_id,
    appointment_id: row.appointment_id,
    status: row.status,
    is_estimate: row.is_estimate,
    subtotal: row.subtotal,
    tax: row.tax,
    total: row.total,
    paid_amount: row.paid_amount,
    adjusted_amount: row.adjusted_amount,
    due_date: row.due_date,
    lines: (row.lines as Row[]).map((l) => ({ ...l, quantity: num(l.quantity) })),
    ...stamps(row),
  }),
};

export const invoiceLinesResource: ExtractionResource<Row> = {
  scope: "billing:read",
  name: "Invoice line",
  filters: ["invoice_id", "item_id"],
  base: (practiceId) => sql`
    select i.id, i.invoice_id, i.description, i.item_type, i.item_id, i.quantity,
      i.unit_price::text as unit_price, i.total::text as total, i.taxable,
      i.source_dispense_charge_id, i.source_prescription_id,
      (select c.prescription_event_id from dispense_charge_queue c
        where c.id = i.source_dispense_charge_id and c.practice_id = v.practice_id) as dispensing_event_id,
      i.created_at, i.updated_at, i.deleted_at, i.updated_at as changed_at
    from invoice_items i
    join invoices v on v.id = i.invoice_id
    where v.practice_id = ${practiceId}::uuid
  `,
  map: (row) => ({
    id: row.id,
    invoice_id: row.invoice_id,
    description: row.description,
    item_type: row.item_type,
    item_id: row.item_id,
    quantity: num(row.quantity),
    unit_price: row.unit_price,
    total: row.total,
    taxable: row.taxable,
    source_dispense_charge_id: row.source_dispense_charge_id,
    source_prescription_id: row.source_prescription_id,
    dispensing_event_id: row.dispensing_event_id,
    ...stamps(row),
  }),
};

export const paymentsResource: ExtractionResource<Row> = {
  scope: "billing:read",
  name: "Payment",
  filters: ["invoice_id"],
  base: (practiceId) => sql`
    select p.id, p.invoice_id, v.client_id, p.amount::text as amount, p.method, p.received_by,
      p.received_at, p.notes, p.created_at, p.updated_at, p.deleted_at, p.updated_at as changed_at
    from payments p
    join invoices v on v.id = p.invoice_id
    where v.practice_id = ${practiceId}::uuid
  `,
  map: (row) => ({
    id: row.id,
    invoice_id: row.invoice_id,
    client_id: row.client_id,
    amount: row.amount,
    method: row.method,
    received_by: row.received_by,
    received_at: iso(row.received_at),
    notes: row.notes,
    ...stamps(row),
  }),
};

export const invoiceAdjustmentsResource: ExtractionResource<Row> = {
  scope: "billing:read",
  name: "Invoice adjustment",
  filters: ["invoice_id"],
  base: (practiceId) => sql`
    select a.id, a.invoice_id, a.type, a.amount::text as amount, a.reason, a.created_by,
      a.balance_after::text as balance_after, a.created_at, a.updated_at, a.deleted_at,
      a.updated_at as changed_at
    from invoice_adjustments a
    join invoices v on v.id = a.invoice_id
    where v.practice_id = ${practiceId}::uuid
  `,
  map: (row) => ({
    id: row.id,
    invoice_id: row.invoice_id,
    type: row.type,
    amount: row.amount,
    reason: row.reason,
    created_by: row.created_by,
    balance_after: row.balance_after,
    ...stamps(row),
  }),
};

// --- Catalogue ---------------------------------------------------------------

export const productsResource: ExtractionResource<Row> = {
  scope: "catalog:read",
  name: "Product",
  filters: ["location_id"],
  base: (practiceId) => sql`
    select p.id, p.location_id, p.name, p.sku, p.category, p.unit_price::text as unit_price,
      p.cost_price::text as cost_price, p.stock_quantity, p.reorder_point, p.lot_number,
      p.expiration_date::text as expiration_date, p.taxable, p.inventory_tracked,
      p.created_at, p.updated_at, p.deleted_at, p.updated_at as changed_at
    from products p where p.practice_id = ${practiceId}::uuid
  `,
  map: (row) => ({
    id: row.id,
    location_id: row.location_id,
    name: row.name,
    sku: row.sku,
    category: row.category,
    unit_price: row.unit_price,
    cost_price: row.cost_price,
    stock_quantity: num(row.stock_quantity),
    reorder_point: num(row.reorder_point),
    lot_number: row.lot_number,
    expiration_date: row.expiration_date,
    taxable: row.taxable,
    inventory_tracked: row.inventory_tracked,
    ...stamps(row),
  }),
};

export const servicesResource: ExtractionResource<Row> = {
  scope: "catalog:read",
  name: "Service",
  base: (practiceId) => sql`
    select s.id, s.name, s.code, s.category, s.default_price::text as default_price, s.taxable,
      s.created_at, s.updated_at, s.deleted_at, s.updated_at as changed_at
    from services s where s.practice_id = ${practiceId}::uuid
  `,
  map: (row) => ({
    id: row.id,
    name: row.name,
    code: row.code,
    category: row.category,
    default_price: row.default_price,
    taxable: row.taxable,
    ...stamps(row),
  }),
};
