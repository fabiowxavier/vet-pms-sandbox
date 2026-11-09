/**
 * Pure, deterministic planner for a synthetic clinic history.
 *
 * The planner simulates the clinic day by day and produces every row the
 * application's own services would have written — appointments, SOAP notes,
 * vaccinations, labs, prescriptions and their event ledger, dispense charges,
 * invoices, payments, visit work items and closeouts, stock receipts — with
 * explicit historical timestamps. It never touches the database; `write.ts`
 * inserts the plan and the database triggers re-validate every invariant.
 *
 * Why not call the tRPC procedures? They stamp `now()` (payments.received_at,
 * prescription events, SOAP finalisation, stock changes), so they cannot record
 * history. Instead this module mirrors their write sets field for field and
 * reuses the app's money, quantity and tax calculators.
 */
import type {
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
import { calculateInvoiceTaxTotals } from "@/lib/billing/invoice-tax";
import { centsToMoney, moneyToCents } from "@/lib/billing/invoice-balance";
import { quantityLineTotalCents } from "@/lib/quantity";
import {
  ACUTE_SCENARIOS,
  BREEDS,
  COLORS,
  OWNER_FIRST_NAMES,
  OWNER_LAST_NAMES,
  PET_NAMES,
  PRODUCTS,
  SERVICES,
  SPECIES_WEIGHTS,
  STAFF,
  STREETS,
  SYNTHETIC_FOOTER,
  TOWNS,
  VACCINES,
  VET_SCHEDULE,
  WEIGHT_KG,
  WELLNESS_NOTES,
  WORKUPS,
  type AcuteScenario,
  type MedicationPlan,
  type NoteTemplate,
  type ProductKey,
  type ServiceKey,
  type Species,
  type StaffKey,
  type Workup,
} from "./catalog";
import { GENERATOR_VERSION, goLiveDate, type SyntheticConfig } from "./config";
import { Rng } from "./rng";
import {
  addDays,
  addMinutes,
  dayOfWeek,
  diffDays,
  eachDate,
  isClinicHoliday,
  localDateOf,
  localToUtc,
  type CalendarDate,
} from "./time";

type Insert<T extends { $inferInsert: unknown }> = T["$inferInsert"];

export type PlanRows = {
  practices: Insert<typeof practices>[];
  locations: Insert<typeof locations>[];
  users: Insert<typeof users>[];
  rooms: Insert<typeof rooms>[];
  appointmentTypes: Insert<typeof appointmentTypes>[];
  services: Insert<typeof services>[];
  products: Insert<typeof products>[];
  clients: Insert<typeof clients>[];
  patients: Insert<typeof patients>[];
  patientWeights: Insert<typeof patientWeights>[];
  appointments: Insert<typeof appointments>[];
  soapNotes: Insert<typeof soapNotes>[];
  vaccinationRecords: Insert<typeof vaccinationRecords>[];
  labResults: Insert<typeof labResults>[];
  labResultEvents: Insert<typeof labResultEvents>[];
  problemList: Insert<typeof problemList>[];
  prescriptions: Insert<typeof prescriptions>[];
  prescriptionEvents: Insert<typeof prescriptionEvents>[];
  /** Inserted as pending; `dispenseResolutions` then marks them invoiced. */
  dispenseCharges: Insert<typeof dispenseChargeQueue>[];
  invoices: Insert<typeof invoices>[];
  invoiceItems: Insert<typeof invoiceItems>[];
  payments: Insert<typeof payments>[];
  visitWorkItems: Insert<typeof visitWorkItems>[];
  visitCloseouts: Insert<typeof visitCloseouts>[];
  stockAdjustments: Insert<typeof inventoryStockAdjustments>[];
};

export type DispenseResolution = {
  chargeId: string;
  invoiceId: string;
  invoiceItemId: string;
  resolvedBy: string;
  resolvedByName: string;
  resolvedAt: Date;
};

export type VisitKind =
  | "wellness"
  | "acute"
  | "acute_recheck"
  | "workup_suspected"
  | "workup_result"
  | "chronic_monitoring";

export type VisitFact = {
  appointmentId: string;
  patientId: string;
  date: CalendarDate;
  kind: VisitKind;
  status: "checked_out" | "cancelled" | "no_show";
  note: "short" | "long" | "none";
  scenario: string | null;
  /** The visit this one follows up (repeat visit chain). */
  followsAppointmentId: string | null;
  vetId: string;
};

export type SuspectedConditionFact = {
  patientId: string;
  condition: string;
  suspectedAppointmentId: string;
  suspectedOn: CalendarDate;
  labResultId: string;
  labValue: string;
  outcome: "confirmed" | "ruled_out" | "unresolved_follow_up_missed" | "pending_after_window";
  resolvedAppointmentId: string | null;
  problemId: string | null;
};

export type DiscrepancyType =
  | "unbilled_dispense"
  | "price_below_catalog_without_adjustment"
  | "billed_visit_without_consultation_note"
  | "prescription_only_product_sold_without_prescription";

export type DiscrepancyFact = {
  type: DiscrepancyType;
  description: string;
  records: Record<string, string>;
};

export type PlanFacts = {
  visits: VisitFact[];
  suspectedConditions: SuspectedConditionFact[];
  establishedChronicPatients: { patientId: string; condition: string; problemId: string }[];
  discrepancies: DiscrepancyFact[];
  partialPaymentInvoiceIds: string[];
  counterInvoiceIds: string[];
  stock: Record<
    string,
    { productId: string; opening: number; receipts: number; dispensed: number; retailSold: number; closing: number }
  >;
  prescriptionOnlyProductIds: string[];
};

export type Plan = {
  config: SyntheticConfig;
  practiceId: string;
  goLive: CalendarDate;
  asOf: Date;
  rows: PlanRows;
  dispenseResolutions: DispenseResolution[];
  facts: PlanFacts;
  /** Staff accounts for UI inspection (password set at write time). */
  staffEmails: Record<StaffKey, string>;
};

// ---------------------------------------------------------------------------

const SLOT_MINUTES = [510, 540, 570, 600, 630, 660, 690, 780, 810, 840, 870, 900, 930, 960, 990];
const VISIT_MINUTES = 30;
const VET_KEYS = ["vet1", "vet2", "vet3"] as const;
type VetKey = (typeof VET_KEYS)[number];
const PAYMENT_METHODS = [
  ["credit_card", 55],
  ["debit_card", 22],
  ["cash", 15],
  ["check", 8],
] as const;

type Household = {
  id: string;
  first: string;
  last: string;
  registeredAt: Date;
};

type Rx = {
  id: string;
  patientId: string;
  clientId: string;
  appointmentId: string | null;
  product: ProductKey | null;
  plan: MedicationPlan;
  quantity: number;
  refillsRemaining: number;
  status: "active" | "completed" | "cancelled" | "expired";
  startDate: CalendarDate;
  endDate: CalendarDate;
  prescribedBy: VetKey;
  createdAt: Date;
  lastEventAt: Date;
  nextRefill: CalendarDate | null;
  chronic: boolean;
};

type Chronic = {
  workup: Workup;
  writtenScript: boolean;
  rx: Rx | null;
  nextMonitoring: CalendarDate;
};

type Pet = {
  id: string;
  clientId: string;
  name: string;
  species: Species;
  dob: CalendarDate;
  baseWeight: number;
  registeredAt: Date;
  registeredOn: CalendarDate;
  wellnessDue: CalendarDate;
  hasUpcoming: boolean;
  lastVet: VetKey | null;
  chronic: Chronic | null;
  pendingWorkup: boolean;
  rxProducts: { product: ProductKey; date: CalendarDate }[];
};

type Booking = {
  pet: Pet;
  date: CalendarDate;
  vet: VetKey;
  minute: number;
  kind: VisitKind;
  bookedAt: Date;
  context?: {
    acute?: AcuteScenario;
    workup?: Workup;
    forceOutcome?: "confirmed" | "ruled_out";
    previousAppointmentId?: string;
    suspected?: SuspectedConditionFact;
    labTruth?: boolean;
  };
};

type InvoiceLine = Insert<typeof invoiceItems> & { taxable: boolean };

class DiscrepancyScheduler {
  private targets = new Map<DiscrepancyType, CalendarDate[]>();
  private claimed = new Map<DiscrepancyType, number>();

  constructor(types: DiscrepancyType[], perType: number, start: CalendarDate, end: CalendarDate) {
    const span = Math.max(1, Math.floor(diffDays(end, start) * 0.8));
    for (const type of types) {
      const dates: CalendarDate[] = [];
      for (let i = 0; i < perType; i++) {
        dates.push(addDays(start, Math.floor((span * i) / Math.max(1, perType))));
      }
      this.targets.set(type, dates);
      this.claimed.set(type, 0);
    }
  }

  claim(type: DiscrepancyType, date: CalendarDate): boolean {
    const dates = this.targets.get(type)!;
    const used = this.claimed.get(type)!;
    if (used < dates.length && dates[used]! <= date) {
      this.claimed.set(type, used + 1);
      return true;
    }
    return false;
  }

  shortfall(): string[] {
    return [...this.targets.entries()]
      .filter(([type, dates]) => this.claimed.get(type)! < dates.length)
      .map(([type, dates]) => `${type}: ${this.claimed.get(type)}/${dates.length}`);
  }
}

/** Notes at or above this many characters (all four SOAP sections) count as long. */
export const LONG_NOTE_THRESHOLD = 700;

export function classifyNoteLength(note: {
  subjective?: string | null;
  objective?: string | null;
  assessment?: string | null;
  plan?: string | null;
}): "short" | "long" {
  const length = [note.subjective, note.objective, note.assessment, note.plan].reduce(
    (sum, part) => sum + (part?.length ?? 0),
    0,
  );
  return length >= LONG_NOTE_THRESHOLD ? "long" : "short";
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);
}

function isOpenDay(date: CalendarDate): boolean {
  const dow = dayOfWeek(date);
  return dow >= 1 && dow <= 5 && !isClinicHoliday(date);
}

function nextOpenDay(date: CalendarDate): CalendarDate {
  let d = date;
  while (!isOpenDay(d)) d = addDays(d, 1);
  return d;
}

function ageYears(dob: CalendarDate, on: CalendarDate): number {
  return diffDays(on, dob) / 365.25;
}

function round(value: number, decimals: number): string {
  return value.toFixed(decimals);
}

export function buildPlan(config: SyntheticConfig): Plan {
  const root = new Rng(`${config.seed}|${config.datasetId}|v${GENERATOR_VERSION}`);
  const ids = root.fork("ids");
  const popRng = root.fork("population");
  const demandRng = root.fork("demand");
  const clinicalRng = root.fork("clinical");
  const billingRng = root.fork("billing");
  const tz = config.timezone;
  const at = (date: CalendarDate, minute: number) => localToUtc(date, minute, tz);
  const goLive = goLiveDate(config);
  const asOf = new Date(at(addDays(config.endDate, 1), 0).getTime() - 1);
  const inWindow = (instant: Date) => instant.getTime() <= asOf.getTime();

  const rows: PlanRows = {
    practices: [], locations: [], users: [], rooms: [], appointmentTypes: [], services: [], products: [],
    clients: [], patients: [], patientWeights: [], appointments: [], soapNotes: [], vaccinationRecords: [],
    labResults: [], labResultEvents: [], problemList: [], prescriptions: [], prescriptionEvents: [],
    dispenseCharges: [], invoices: [], invoiceItems: [], payments: [], visitWorkItems: [], visitCloseouts: [],
    stockAdjustments: [],
  };
  const dispenseResolutions: DispenseResolution[] = [];
  const facts: PlanFacts = {
    visits: [], suspectedConditions: [], establishedChronicPatients: [], discrepancies: [],
    partialPaymentInvoiceIds: [], counterInvoiceIds: [], stock: {}, prescriptionOnlyProductIds: [],
  };

  // -------------------------------------------------------------------------
  // Clinic setup at go-live
  // -------------------------------------------------------------------------
  const practiceId = ids.uuid();
  const goLiveAt = at(goLive, 8 * 60);
  const locationId = ids.uuid();
  const emailDomain = `${config.datasetId}.synthetic.example`;
  const staffEmails = {} as Record<StaffKey, string>;
  const staffId = {} as Record<StaffKey, string>;
  const staffName = {} as Record<StaffKey, string>;

  rows.practices.push({
    id: practiceId,
    name: config.practiceName,
    address: "1 Lighthouse Drive, Harborview (fictional)",
    phone: "(555) 010-0000",
    email: `frontdesk@${emailDomain}`,
    timezone: tz,
    country: "US",
    currency: "USD",
    taxRatePercent: config.taxRatePercent,
    settings: {
      onboardingCompletedAt: goLiveAt.toISOString(),
      syntheticDataset: {
        label: "SYNTHETIC: fictional data generated for testing. Not a real clinic.",
        datasetId: config.datasetId,
        generatorVersion: GENERATOR_VERSION,
        startDate: config.startDate,
        endDate: config.endDate,
      },
    },
    createdAt: goLiveAt,
    updatedAt: goLiveAt,
  });
  rows.locations.push({
    id: locationId, practiceId, name: "Harborview Main Clinic", address: "1 Lighthouse Drive, Harborview (fictional)",
    phone: "(555) 010-0000", isPrimary: true, createdAt: goLiveAt, updatedAt: goLiveAt,
  });
  for (const member of STAFF) {
    const id = ids.uuid();
    const [first, ...rest] = member.name.replace(/^Dr\. /, "").split(" ");
    staffId[member.key] = id;
    staffName[member.key] = member.name;
    staffEmails[member.key] = `${first!.toLowerCase()}.${rest.join("").toLowerCase()}@${emailDomain}`;
    rows.users.push({
      id, practiceId, locationId, email: staffEmails[member.key], name: member.name,
      role: member.role, isVeterinarian: member.role === "veterinarian", licenseNumber: member.license,
      phone: "(555) 010-0001", passwordHash: "set-at-write-time", createdAt: goLiveAt, updatedAt: goLiveAt,
    });
  }
  const roomId: Record<VetKey, string> = { vet1: ids.uuid(), vet2: ids.uuid(), vet3: ids.uuid() };
  VET_KEYS.forEach((vet, i) =>
    rows.rooms.push({ id: roomId[vet], practiceId, locationId, name: `Exam Room ${i + 1}`, type: "exam", createdAt: goLiveAt, updatedAt: goLiveAt }),
  );
  const typeId: Record<"wellness" | "sick" | "recheck", string> = { wellness: ids.uuid(), sick: ids.uuid(), recheck: ids.uuid() };
  rows.appointmentTypes.push(
    { id: typeId.wellness, practiceId, name: "Wellness Exam", durationMinutes: 30, color: "#0d9488", requiresDoctor: 1, defaultRoomType: "exam", createdAt: goLiveAt, updatedAt: goLiveAt },
    { id: typeId.sick, practiceId, name: "Sick Visit", durationMinutes: 30, color: "#dc2626", requiresDoctor: 1, defaultRoomType: "exam", createdAt: goLiveAt, updatedAt: goLiveAt },
    { id: typeId.recheck, practiceId, name: "Recheck", durationMinutes: 30, color: "#16a34a", requiresDoctor: 1, defaultRoomType: "exam", createdAt: goLiveAt, updatedAt: goLiveAt },
  );
  const serviceId = {} as Record<ServiceKey, string>;
  for (const [key, def] of Object.entries(SERVICES) as [ServiceKey, (typeof SERVICES)[ServiceKey]][]) {
    serviceId[key] = ids.uuid();
    rows.services.push({
      id: serviceId[key], practiceId, name: def.name, code: def.code, category: def.category,
      defaultPrice: def.price, taxable: false, createdAt: goLiveAt, updatedAt: goLiveAt,
    });
  }
  const productId = {} as Record<ProductKey, string>;
  for (const key of Object.keys(PRODUCTS) as ProductKey[]) productId[key] = ids.uuid();
  facts.prescriptionOnlyProductIds = (Object.keys(PRODUCTS) as ProductKey[])
    .filter((k) => PRODUCTS[k].prescriptionOnly)
    .map((k) => productId[k]);

  // Stock movements resolved into receipts and closing quantities at the end.
  const movements: { product: ProductKey; at: Date; quantity: number; kind: "dispensed" | "retail" }[] = [];

  // -------------------------------------------------------------------------
  // Population
  // -------------------------------------------------------------------------
  const pets: Pet[] = [];
  const petsById = new Map<string, Pet>();
  let householdSerial = 0;

  function createHousehold(registeredAt: Date, registeredOn: CalendarDate): Pet[] {
    householdSerial++;
    const first = popRng.pick(OWNER_FIRST_NAMES);
    const last = popRng.pick(OWNER_LAST_NAMES);
    const town = popRng.pick(TOWNS);
    const household: Household = { id: ids.uuid(), first, last, registeredAt };
    rows.clients.push({
      id: household.id, practiceId, firstName: first, lastName: last,
      email: `${first.toLowerCase()}.${last.toLowerCase()}.${householdSerial}@owners.synthetic.example`,
      phone: `(555) 01${String(householdSerial % 100).padStart(2, "0")}-${String(1000 + (householdSerial % 9000)).slice(-4)}`,
      address: `${popRng.int(1, 240)} ${popRng.pick(STREETS)}`, city: town.city, state: "ZZ", zip: town.zip,
      preferredContactMethod: popRng.pick(["phone", "email"] as const), smsConsent: false,
      notes: `Synthetic client: fictional household generated for testing (dataset ${config.datasetId}).`,
      createdAt: registeredAt, updatedAt: registeredAt,
    });
    const petCount = popRng.weighted([[1, 60], [2, 30], [3, 10]] as const);
    const created: Pet[] = [];
    for (let i = 0; i < petCount; i++) {
      const species = popRng.weighted(SPECIES_WEIGHTS);
      const maxAge = species === "canine" || species === "feline" ? 15 : species === "rabbit" ? 8 : 12;
      const ageDays = popRng.int(120, Math.floor(maxAge * 365));
      const dob = addDays(registeredOn, -ageDays);
      const [lo, hi] = WEIGHT_KG[species];
      const baseWeight = lo + popRng.next() * (hi - lo);
      const female = popRng.chance(0.5);
      const neutered = species === "canine" || species === "feline" ? popRng.chance(0.8) : popRng.chance(0.2);
      const pet: Pet = {
        id: ids.uuid(), clientId: household.id, name: popRng.pick(PET_NAMES), species, dob, baseWeight,
        registeredAt, registeredOn,
        wellnessDue: addDays(registeredOn, popRng.int(0, 364)),
        hasUpcoming: false, lastVet: null, chronic: null, pendingWorkup: false, rxProducts: [],
      };
      rows.patients.push({
        id: pet.id, practiceId, clientId: household.id, name: pet.name, species,
        breed: popRng.pick(BREEDS[species]),
        sex: female ? (neutered ? "female_spayed" : "female") : neutered ? "male_neutered" : "male",
        dob, color: popRng.pick(COLORS[species]), status: "active", createdAt: registeredAt, updatedAt: registeredAt,
      });
      pets.push(pet);
      petsById.set(pet.id, pet);
      created.push(pet);
    }
    return created;
  }

  // Existing households are registered during go-live week.
  for (let i = 0; i < config.households; i++) {
    const day = addDays(goLive, popRng.int(0, 9));
    createHousehold(at(day, popRng.int(9 * 60, 17 * 60)), day);
  }
  // New households join during the window and book a first wellness visit.
  const windowDays = eachDate(config.startDate, config.endDate);
  const newHouseholdDays: CalendarDate[] = [];
  const expectedNew = (config.newHouseholdsPerMonth * windowDays.length) / 30;
  for (let i = 0; i < Math.round(expectedNew); i++) {
    newHouseholdDays.push(nextOpenDay(popRng.pick(windowDays)));
  }
  newHouseholdDays.sort();

  // -------------------------------------------------------------------------
  // Scheduling
  // -------------------------------------------------------------------------
  const occupied = new Set<string>();
  const bookings = new Map<CalendarDate, Booking[]>();
  const slotKey = (date: CalendarDate, vet: VetKey, minute: number) => `${date}|${vet}|${minute}`;
  const vetWorks = (vet: VetKey, date: CalendarDate) => VET_SCHEDULE[vet].includes(dayOfWeek(date));

  /** Minimum gap between making a booking and the appointment starting. */
  const MIN_BOOKING_LEAD_MS = 15 * 60_000;

  function findSlot(
    date: CalendarDate,
    preferred: VetKey | null,
    rng: Rng,
    bookedAt: Date,
  ): { vet: VetKey; minute: number } | null {
    if (!isOpenDay(date)) return null;
    const vets = rng.shuffle(VET_KEYS.filter((v) => vetWorks(v, date)));
    if (preferred && vets.includes(preferred)) vets.unshift(...vets.splice(vets.indexOf(preferred), 1));
    for (const vet of vets) {
      const offset = rng.int(0, SLOT_MINUTES.length - 1);
      for (let i = 0; i < SLOT_MINUTES.length; i++) {
        const minute = SLOT_MINUTES[(offset + i) % SLOT_MINUTES.length]!;
        // A same-day booking can only take a slot that starts after it was made.
        if (at(date, minute).getTime() - bookedAt.getTime() < MIN_BOOKING_LEAD_MS) continue;
        if (!occupied.has(slotKey(date, vet, minute))) return { vet, minute };
      }
    }
    return null;
  }

  function book(pet: Pet, date: CalendarDate, kind: VisitKind, bookedAt: Date, context: Booking["context"], preferred: VetKey | null): Booking | null {
    for (let tries = 0; tries < 6; tries++) {
      const day = nextOpenDay(addDays(date, tries));
      if (day > config.endDate) return null;
      const slot = findSlot(day, preferred, demandRng, bookedAt);
      if (!slot) continue;
      occupied.add(slotKey(day, slot.vet, slot.minute));
      const booking: Booking = { pet, date: day, vet: slot.vet, minute: slot.minute, kind, bookedAt, context };
      const list = bookings.get(day) ?? [];
      list.push(booking);
      bookings.set(day, list);
      pet.hasUpcoming = true;
      return booking;
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Shared record builders
  // -------------------------------------------------------------------------
  const scheduler = new DiscrepancyScheduler(
    [
      "unbilled_dispense",
      "price_below_catalog_without_adjustment",
      "billed_visit_without_consultation_note",
      "prescription_only_product_sold_without_prescription",
    ],
    config.discrepanciesPerType,
    config.startDate,
    config.endDate,
  );

  function vitals(pet: Pet, rng: Rng): Record<string, string> {
    const weight = pet.baseWeight * (0.96 + rng.next() * 0.08);
    const species = pet.species;
    const temp =
      species === "reptile" ? "n/a (ectotherm)" : species === "avian" ? round(104 + rng.next() * 2, 1) : round(100.6 + rng.next() * 1.8, 1);
    const hr = species === "feline" ? rng.int(160, 210) : species === "canine" ? rng.int(70, 130) : species === "rabbit" ? rng.int(140, 220) : rng.int(60, 300);
    return {
      pet: pet.name,
      species: species === "canine" ? "dog" : species === "feline" ? "cat" : species,
      temp,
      hr: String(hr),
      rr: String(rng.int(16, 36)),
      weight: weight < 1 ? round(weight, 3) : round(weight, 1),
      bcs: String(rng.int(4, 6)),
    };
  }

  function noteRow(
    pet: Pet,
    appointmentId: string,
    vet: VetKey,
    template: NoteTemplate,
    vars: Record<string, string>,
    startedAt: Date,
    finalizedAt: Date,
  ) {
    rows.soapNotes.push({
      id: ids.uuid(), practiceId, patientId: pet.id, appointmentId, authorId: staffId[vet], authorName: staffName[vet],
      status: "finalized", revision: 1, finalizedAt, finalizedBy: staffId[vet], finalizerName: staffName[vet],
      imported: false,
      subjective: fill(template.subjective, vars),
      objective: fill(template.objective, vars),
      assessment: fill(template.assessment, vars),
      plan: `${fill(template.plan, vars)}\n${SYNTHETIC_FOOTER}`,
      createdAt: startedAt, updatedAt: finalizedAt,
    });
  }

  function serviceLine(invoiceId: string, key: ServiceKey, createdAt: Date, unitPrice?: string): InvoiceLine {
    const def = SERVICES[key];
    const price = unitPrice ?? def.price;
    return {
      id: ids.uuid(), invoiceId, description: def.name, quantity: 1, unitPrice: price,
      total: centsToMoney(quantityLineTotalCents(moneyToCents(price), 1)), itemType: "service",
      itemId: serviceId[key], taxable: false, createdAt, updatedAt: createdAt,
    };
  }

  function productLine(invoiceId: string, key: ProductKey, quantity: number, createdAt: Date, description?: string, sourceDispenseChargeId?: string): InvoiceLine {
    const def = PRODUCTS[key];
    return {
      id: ids.uuid(), invoiceId, description: description ?? def.name, quantity, unitPrice: def.unitPrice,
      total: centsToMoney(quantityLineTotalCents(moneyToCents(def.unitPrice), quantity)), itemType: "product",
      itemId: productId[key], taxable: true, sourceDispenseChargeId: sourceDispenseChargeId ?? null,
      createdAt, updatedAt: createdAt,
    };
  }

  function dispenseDescription(rx: Rx): string {
    return `${PRODUCTS[rx.product!].name} — ${rx.plan.medicationName}`.slice(0, 500);
  }

  /** Mirrors records.createPrescription: prescription, `created` event, stock, dispense charge. */
  function createPrescription(
    pet: Pet,
    plan: MedicationPlan,
    vet: VetKey,
    appointmentId: string | null,
    date: CalendarDate,
    createdAt: Date,
    options: { written: boolean; refills: number; chronic: boolean; endDate: CalendarDate },
  ): { rx: Rx; chargeId: string | null } {
    const rx: Rx = {
      id: ids.uuid(), patientId: pet.id, clientId: pet.clientId, appointmentId,
      product: options.written ? null : plan.product, plan, quantity: plan.quantity,
      refillsRemaining: options.refills, status: "active", startDate: date, endDate: options.endDate,
      prescribedBy: vet, createdAt, lastEventAt: createdAt,
      nextRefill: options.refills > 0 ? addDays(date, plan.days) : null, chronic: options.chronic,
    };
    rxList.push(rx);
    rows.prescriptionEvents.push({
      id: ids.uuid(), practiceId, prescriptionId: rx.id, patientId: pet.id, productId: rx.product ? productId[rx.product] : null,
      quantity: rx.quantity, eventType: "created", statusBefore: null, statusAfter: "active", refillsBefore: null,
      refillsAfter: options.refills, reason: null, actorId: staffId[vet], actorName: staffName[vet],
      operationId: rxOperationId(rx), createdAt,
    });
    let chargeId: string | null = null;
    if (rx.product) {
      pet.rxProducts.push({ product: rx.product, date });
      movements.push({ product: rx.product, at: createdAt, quantity: rx.quantity, kind: "dispensed" });
      chargeId = ids.uuid();
      rows.dispenseCharges.push({
        id: chargeId, practiceId, prescriptionEventId: rows.prescriptionEvents.at(-1)!.id!, prescriptionId: rx.id,
        patientId: pet.id, clientId: pet.clientId, appointmentId, productId: productId[rx.product], quantity: rx.quantity,
        descriptionSnapshot: dispenseDescription(rx), unitPriceSnapshot: PRODUCTS[rx.product].unitPrice, status: "pending",
        createdAt, updatedAt: createdAt,
      });
    }
    return { rx, chargeId };
  }

  const rxOperationIds = new Map<string, string>();
  function rxOperationId(rx: Rx): string {
    let id = rxOperationIds.get(rx.id);
    if (!id) {
      id = ids.uuid();
      rxOperationIds.set(rx.id, id);
    }
    return id;
  }

  const rxList: Rx[] = [];

  function closeRx(rx: Rx, eventType: "completed" | "expired", when: Date, reason: string, actor: VetKey | null) {
    if (rx.status !== "active") return;
    rx.status = eventType;
    rx.lastEventAt = when;
    rows.prescriptionEvents.push({
      id: ids.uuid(), practiceId, prescriptionId: rx.id, patientId: rx.patientId,
      productId: rx.product ? productId[rx.product] : null, quantity: rx.quantity, eventType,
      statusBefore: "active", statusAfter: eventType, refillsBefore: rx.refillsRemaining, refillsAfter: rx.refillsRemaining,
      reason, actorId: actor ? staffId[actor] : null, actorName: actor ? staffName[actor] : "OpenVPM system",
      operationId: actor ? ids.uuid() : null, createdAt: when,
    });
  }

  type PaymentPlan = "full_at_checkout" | "full_later" | "partial" | "unpaid";

  /** Invoice, lines, payments and final status as of the window end. */
  function createInvoice(input: {
    pet: Pet;
    appointmentId: string | null;
    issuedAt: Date;
    issuedOn: CalendarDate;
    lines: InvoiceLine[];
    paymentPlan: PaymentPlan;
    cashier: StaffKey;
  }) {
    const invoiceId = input.lines[0]!.invoiceId;
    const totals = calculateInvoiceTaxTotals(
      input.lines.map((line) => ({ lineTotalCents: moneyToCents(line.total), taxable: line.taxable })),
      config.taxRatePercent,
    );
    const totalCents = totals.totalCents;
    const paymentsPlanned: { amountCents: number; at: Date }[] = [];
    if (input.paymentPlan === "full_at_checkout") {
      paymentsPlanned.push({ amountCents: totalCents, at: addMinutes(input.issuedAt, 3) });
    } else if (input.paymentPlan === "full_later") {
      const day = nextOpenDay(addDays(input.issuedOn, billingRng.int(4, 40)));
      paymentsPlanned.push({ amountCents: totalCents, at: at(day, billingRng.int(9 * 60, 17 * 60)) });
    } else if (input.paymentPlan === "partial") {
      const first = Math.min(totalCents - 100, Math.max(100, Math.round((totalCents * (0.35 + billingRng.next() * 0.3)) / 100) * 100));
      paymentsPlanned.push({ amountCents: first, at: addMinutes(input.issuedAt, 3) });
      if (billingRng.chance(0.5)) {
        const day = nextOpenDay(addDays(input.issuedOn, billingRng.int(10, 60)));
        paymentsPlanned.push({ amountCents: totalCents - first, at: at(day, billingRng.int(9 * 60, 17 * 60)) });
      }
    }
    const dueDate = input.paymentPlan === "full_at_checkout" ? input.issuedOn : addDays(input.issuedOn, 30);
    let paidCents = 0;
    let lastChange = input.issuedAt;
    let paidAt: Date | null = null;
    for (const payment of paymentsPlanned) {
      if (!inWindow(payment.at)) continue;
      paidCents += payment.amountCents;
      lastChange = payment.at;
      rows.payments.push({
        id: ids.uuid(), invoiceId, amount: centsToMoney(payment.amountCents), method: billingRng.weighted(PAYMENT_METHODS),
        receivedBy: staffId[input.cashier], receivedAt: payment.at,
        externalId: `dashboard-payment:${practiceId}:${ids.uuid()}`,
        notes: "Synthetic payment (fictional).", createdAt: payment.at, updatedAt: payment.at,
      });
      if (paidCents >= totalCents) paidAt = payment.at;
    }
    // Monthly accounts-receivable review marks unpaid past-due invoices overdue.
    let status: "sent" | "paid" | "overdue" = paidCents >= totalCents ? "paid" : "sent";
    if (status !== "paid") {
      // The review runs on the first open day of the month after the due date.
      const dayAfterDue = addDays(dueDate, 1);
      const firstOfMonth =
        dayAfterDue.slice(8) === "01"
          ? dayAfterDue
          : `${addDays(`${dayAfterDue.slice(0, 7)}-01`, 32).slice(0, 7)}-01`;
      const reviewAt = at(nextOpenDay(firstOfMonth), 9 * 60 + 15);
      if (inWindow(reviewAt)) {
        const paidBeforeReview = paymentsPlanned.filter((p) => p.at <= reviewAt).reduce((s, p) => s + p.amountCents, 0);
        if (paidBeforeReview < totalCents) {
          status = "overdue";
          if (reviewAt > lastChange) lastChange = reviewAt;
        }
      }
    }
    if (paidAt) status = "paid";
    rows.invoices.push({
      id: invoiceId, practiceId, clientId: input.pet.clientId, patientId: input.pet.id, appointmentId: input.appointmentId,
      status, subtotal: centsToMoney(totals.subtotalCents), tax: centsToMoney(totals.taxCents), total: centsToMoney(totalCents),
      paidAmount: centsToMoney(paidCents), dueDate, isEstimate: false, createdAt: input.issuedAt, updatedAt: lastChange,
    });
    for (const line of input.lines) rows.invoiceItems.push(line);
    if (paidCents > 0 && paidCents < totalCents) facts.partialPaymentInvoiceIds.push(invoiceId);
    return { invoiceId, status, paidAt, totalCents };
  }

  function choosePaymentPlan(rng: Rng, counter: boolean): PaymentPlan {
    return counter
      ? rng.weighted([["full_at_checkout", 92], ["full_later", 8]] as const)
      : rng.weighted([["full_at_checkout", 78], ["full_later", 10], ["partial", 8], ["unpaid", 4]] as const);
  }

  function labResult(
    pet: Pet,
    appointmentId: string,
    vet: VetKey,
    orderedAt: Date,
    testName: string,
    unit: string,
    low: string,
    high: string,
    value: string,
    flag: "normal" | "abnormal",
  ) {
    const id = ids.uuid();
    const completedAt = at(nextOpenDay(addDays(dateOf(orderedAt), 1)), 14 * 60);
    const reviewedAt = at(nextOpenDay(addDays(dateOf(completedAt), 1)), 9 * 60 + 30);
    const status = inWindow(reviewedAt) ? "reviewed" : inWindow(completedAt) ? "completed" : "pending";
    const operationId = ids.uuid();
    const payloadHash = ids.hex64();
    const complete = status !== "pending";
    rows.labResults.push({
      id, practiceId, patientId: pet.id, appointmentId, testName,
      resultValue: complete ? value : null, unit: complete ? unit : null,
      referenceRangeLow: complete ? low : null, referenceRangeHigh: complete ? high : null,
      status, orderedBy: staffId[vet], reviewedBy: status === "reviewed" ? staffId[vet] : null,
      creationOperationId: operationId, creationPayloadHash: payloadHash,
      resultFlag: complete ? flag : "unknown", completedAt: complete ? completedAt : null,
      reviewedAt: status === "reviewed" ? reviewedAt : null, followUpStatus: "not_required",
      createdAt: orderedAt, updatedAt: status === "reviewed" ? reviewedAt : complete ? completedAt : orderedAt,
    });
    const base = { practiceId, labResultId: id, patientId: pet.id, appointmentId, followUpStatus: "not_required" as const, actorId: staffId[vet], actorName: staffName[vet] };
    rows.labResultEvents.push({
      ...base, id: ids.uuid(), eventType: "created", statusBefore: null, statusAfter: "pending", resultValue: null, unit: null,
      referenceRangeLow: null, referenceRangeHigh: null, resultFlag: "unknown", operationId, operationPayloadHash: payloadHash, createdAt: orderedAt,
    });
    if (complete) {
      rows.labResultEvents.push({
        ...base, id: ids.uuid(), eventType: "completed", statusBefore: "pending", statusAfter: "completed", resultValue: value, unit,
        referenceRangeLow: low, referenceRangeHigh: high, resultFlag: flag, note: "Reference laboratory result received.",
        operationId: ids.uuid(), operationPayloadHash: ids.hex64(), createdAt: completedAt,
      });
    }
    if (status === "reviewed") {
      rows.labResultEvents.push({
        ...base, id: ids.uuid(), eventType: "reviewed", statusBefore: "completed", statusAfter: "reviewed", resultValue: value, unit,
        referenceRangeLow: low, referenceRangeHigh: high, resultFlag: flag, operationId: ids.uuid(), operationPayloadHash: ids.hex64(), createdAt: reviewedAt,
      });
    }
    return { id, status };
  }

  function dateOf(instant: Date): CalendarDate {
    return localDateOf(instant, tz);
  }

  function workItem(appointmentId: string, source: Partial<Insert<typeof visitWorkItems>>, createdAt: Date, resolution: { invoiceId: string; invoiceItemId: string } | { noChargeReason: string }, resolvedAt: Date, resolver: StaffKey) {
    rows.visitWorkItems.push({
      id: ids.uuid(), practiceId, appointmentId, ...source,
      ...("invoiceId" in resolution
        ? { status: "charged" as const, invoiceId: resolution.invoiceId, invoiceItemId: resolution.invoiceItemId }
        : { status: "no_charge" as const, noChargeReason: resolution.noChargeReason }),
      resolvedBy: staffId[resolver], resolvedAt, createdAt, updatedAt: resolvedAt,
    });
  }

  // -------------------------------------------------------------------------
  // Visits
  // -------------------------------------------------------------------------
  function runVisit(booking: Booking) {
    const { pet, date, vet, minute, kind, context } = booking;
    const rng = clinicalRng;
    const appointmentId = ids.uuid();
    const start = at(date, minute);
    const end = addMinutes(start, VISIT_MINUTES);
    pet.hasUpcoming = false;
    const typeKey = kind === "wellness" ? "wellness" : kind === "acute" || kind === "workup_suspected" ? "sick" : "recheck";
    const label: Record<VisitKind, string> = {
      wellness: "Wellness exam", acute: `Sick visit: ${context?.acute?.diagnosis ?? "problem"}`,
      acute_recheck: "Recheck", workup_suspected: "Sick visit", workup_result: "Results review",
      chronic_monitoring: `Monitoring: ${context?.workup?.condition ?? ""}`,
    };

    // Cancellations and no-shows.
    const cancelRoll = rng.next();
    const status: VisitFact["status"] = cancelRoll < 0.05 ? "cancelled" : cancelRoll < 0.08 ? "no_show" : "checked_out";
    let updatedAt = addMinutes(end, 20);
    if (status === "cancelled") {
      // Bookings are made at least 15 minutes ahead, so the cancellation always
      // falls after the booking and before the appointment.
      updatedAt = new Date(Math.max(booking.bookedAt.getTime() + 60_000, start.getTime() - rng.int(2, 72) * 3_600_000));
    } else if (status === "no_show") {
      updatedAt = addMinutes(start, 45);
    }
    rows.appointments.push({
      id: appointmentId, practiceId, locationId, startTime: start, endTime: end, typeId: typeId[typeKey], patientId: pet.id,
      clientId: pet.clientId, doctorId: staffId[vet], roomId: roomId[vet], status,
      notes: `[Synthetic] ${label[kind]}`, origin: "scheduled", createdAt: booking.bookedAt, updatedAt,
    });
    const fact: VisitFact = {
      appointmentId, patientId: pet.id, date, kind, status, note: "none", scenario: context?.acute?.key ?? context?.workup?.key ?? null,
      followsAppointmentId: context?.previousAppointmentId ?? null, vetId: staffId[vet],
    };
    facts.visits.push(fact);

    if (status !== "checked_out") {
      if (kind === "workup_result" && context?.suspected) {
        context.suspected.outcome = "unresolved_follow_up_missed";
        pet.pendingWorkup = false;
      }
      if (kind === "chronic_monitoring" && pet.chronic) {
        pet.chronic.nextMonitoring = addDays(date, 21);
      }
      return;
    }
    pet.lastVet = vet;

    const v = vitals(pet, rng);
    const weightAt = addMinutes(start, 4);
    rows.patientWeights.push({
      id: ids.uuid(), patientId: pet.id, weightKg: v.weight,
      recordedAt: weightAt, recordedBy: staffId[rng.pick(["tech1", "tech2"] as const)], createdAt: weightAt, updatedAt: weightAt,
    });

    const invoiceId = ids.uuid();
    const lines: InvoiceLine[] = [];
    const work: { source: Partial<Insert<typeof visitWorkItems>>; at: Date; line?: InvoiceLine; noCharge?: string }[] = [];
    const medSnapshot: { prescriptionId: string; medicationName: string; dosage: string; frequency: string; instructions: string | null; quantity: number | null }[] = [];
    const dispensedCharges: { chargeId: string; rx: Rx }[] = [];
    let template: NoteTemplate | null = null;
    let noteLength: "short" | "long" = "short";
    let diagnosis = "";
    let charge: "charged" | "no_charge" = "charged";
    let followUp: { appointmentId: string; at: Date } | { dueDate: CalendarDate } | null = null;
    const noteStart = addMinutes(start, 6);
    const finalizedAt = addMinutes(end, rng.int(4, 14));

    const prescribe = (plan: MedicationPlan, written: boolean, refills: number, chronic: boolean, endDate: CalendarDate) => {
      const { rx, chargeId } = createPrescription(pet, plan, vet, appointmentId, date, addMinutes(start, 22), { written, refills, chronic, endDate });
      medSnapshot.push({ prescriptionId: rx.id, medicationName: plan.medicationName, dosage: plan.dosage, frequency: plan.frequency, instructions: plan.instructions, quantity: rx.quantity });
      if (chargeId) dispensedCharges.push({ chargeId, rx });
      else work.push({ source: { prescriptionId: rx.id }, at: addMinutes(start, 22), noCharge: "Written prescription filled outside the clinic." });
      return rx;
    };

    const scheduleRecheck = (days: number, nextKind: VisitKind, nextContext: Booking["context"]) => {
      const target = addDays(date, days);
      const recheck = book(pet, target, nextKind, addMinutes(end, 12), { ...nextContext, previousAppointmentId: appointmentId }, vet);
      if (recheck) {
        followUp = { appointmentId: "", at: at(recheck.date, recheck.minute) };
        pendingFollowUps.push({ booking: recheck, attach: (id) => ((followUp as { appointmentId: string }).appointmentId = id) });
        return true;
      }
      followUp = { dueDate: target };
      return false;
    };

    if (kind === "wellness") {
      noteLength = rng.chance(0.3) ? "long" : "short";
      template = noteLength === "long" ? WELLNESS_NOTES.long : WELLNESS_NOTES.short;
      diagnosis = "Wellness examination; healthy.";
      lines.push(serviceLine(invoiceId, "examWellness", end));
      for (const vaccine of VACCINES[pet.species]) {
        const vaccinationId = ids.uuid();
        const givenAt = addMinutes(start, 15);
        rows.vaccinationRecords.push({
          id: vaccinationId, practiceId, patientId: pet.id, vaccineName: vaccine.name, manufacturer: vaccine.manufacturer,
          lotNumber: `SYN-${rng.int(10000, 99999)}`, administeredBy: staffId[vet], supervisingVeterinarianId: staffId[vet],
          administeredAt: givenAt, nextDueDate: addDays(date, 365), appointmentId, productName: `${vaccine.name} (synthetic)`,
          doseType: "booster", licensedDurationMonths: 12, createdAt: givenAt, updatedAt: givenAt,
        });
        const line = serviceLine(invoiceId, vaccine.service, end);
        lines.push(line);
        work.push({ source: { vaccinationRecordId: vaccinationId }, at: givenAt, line });
      }
      if ((pet.species === "canine" || pet.species === "feline") && rng.chance(0.3)) {
        if (rng.chance(0.75)) {
          const doses = rng.pick([3, 6] as const);
          lines.push(productLine(invoiceId, "fleaTick", doses, end));
          movements.push({ product: "fleaTick", at: end, quantity: doses, kind: "retail" });
        } else {
          lines.push(productLine(invoiceId, "dentalChews", 1, end));
          movements.push({ product: "dentalChews", at: end, quantity: 1, kind: "retail" });
        }
      }
      pet.wellnessDue = addDays(date, 365);
      if (
        pet.species === "canine" &&
        !pet.rxProducts.some((r) => r.product === "carprofen") &&
        scheduler.claim("prescription_only_product_sold_without_prescription", date)
      ) {
        const line = productLine(invoiceId, "carprofen", 14, end);
        lines.push(line);
        movements.push({ product: "carprofen", at: end, quantity: 14, kind: "retail" });
        facts.discrepancies.push({
          type: "prescription_only_product_sold_without_prescription",
          description: "Prescription-only carprofen sold as a retail invoice line; the patient has no carprofen prescription on or before the sale date.",
          records: { invoiceId, invoiceItemId: line.id!, patientId: pet.id, productId: productId.carprofen },
        });
      }
    } else if (kind === "acute") {
      const scenario = context!.acute!;
      noteLength = rng.chance(0.45) ? "long" : "short";
      template = noteLength === "long" ? scenario.longNote : scenario.shortNote;
      diagnosis = scenario.diagnosis;
      lines.push(serviceLine(invoiceId, "examProblem", end));
      if (scenario.diagnostic) lines.push(serviceLine(invoiceId, scenario.diagnostic, end));
      prescribe(scenario.medication, rng.chance(scenario.writtenScriptProbability), 0, false, addDays(date, scenario.medication.days - 1));
      if (rng.chance(scenario.recheckProbability)) {
        scheduleRecheck(rng.int(scenario.recheckDays[0], scenario.recheckDays[1]), "acute_recheck", { acute: scenario });
      }
    } else if (kind === "acute_recheck") {
      template = context!.acute!.recheckNote;
      diagnosis = `${context!.acute!.diagnosis}: recheck`;
      if (rng.chance(0.35)) charge = "no_charge";
      else lines.push(serviceLine(invoiceId, "examRecheck", end));
    } else if (kind === "workup_suspected") {
      const workup = context!.workup!;
      noteLength = "long";
      template = workup.suspectedNote;
      diagnosis = `Suspected ${workup.condition.toLowerCase()}; laboratory confirmation pending.`;
      lines.push(serviceLine(invoiceId, "examProblem", end));
      const truth = context!.forceOutcome ? context!.forceOutcome === "confirmed" : rng.chance(workup.confirmProbability);
      const range = truth ? workup.lab.confirmRange : workup.lab.ruleOutRange;
      const value = round(range[0] + rng.next() * (range[1] - range[0]), workup.lab.decimals);
      const orderedAt = addMinutes(start, 18);
      const lab = labResult(pet, appointmentId, vet, orderedAt, workup.lab.testName, workup.lab.unit, workup.lab.low, workup.lab.high, value, truth ? "abnormal" : "normal");
      const line = serviceLine(invoiceId, workup.lab.service, end);
      lines.push(line);
      work.push({ source: { labResultId: lab.id }, at: orderedAt, line });
      const suspected: SuspectedConditionFact = {
        patientId: pet.id, condition: workup.condition, suspectedAppointmentId: appointmentId, suspectedOn: date,
        labResultId: lab.id, labValue: value, outcome: "pending_after_window", resolvedAppointmentId: null, problemId: null,
      };
      facts.suspectedConditions.push(suspected);
      pet.pendingWorkup = true;
      if (!scheduleRecheck(rng.int(6, 8), "workup_result", { workup, suspected, labTruth: truth })) {
        pet.pendingWorkup = false;
      }
    } else if (kind === "workup_result") {
      const workup = context!.workup!;
      const suspected = context!.suspected!;
      const confirmed = context!.labTruth!;
      noteLength = "long";
      template = confirmed ? workup.confirmedNote : workup.ruledOutNote;
      lines.push(serviceLine(invoiceId, "examRecheck", end));
      suspected.outcome = confirmed ? "confirmed" : "ruled_out";
      suspected.resolvedAppointmentId = appointmentId;
      pet.pendingWorkup = false;
      if (confirmed) {
        diagnosis = `${workup.condition} (confirmed).`;
        const problemId = ids.uuid();
        rows.problemList.push({
          id: problemId, practiceId, patientId: pet.id, description: workup.condition, status: "active",
          onsetDate: suspected.suspectedOn, createdAt: finalizedAt, updatedAt: finalizedAt,
        });
        suspected.problemId = problemId;
        const written = rng.chance(0.2);
        const rx = prescribe(workup.medication, written, workup.refills, true, addDays(date, workup.medication.days * (workup.refills + 1) - 1));
        pet.chronic = { workup, writtenScript: written, rx, nextMonitoring: addDays(date, rng.int(150, 170)) };
      } else {
        diagnosis = `${workup.condition} ruled out.`;
      }
    } else if (kind === "chronic_monitoring") {
      const chronic = pet.chronic!;
      const workup = chronic.workup;
      template = workup.monitoringNote;
      diagnosis = `${workup.condition}: monitoring.`;
      lines.push(serviceLine(invoiceId, "examRecheck", end));
      const controlled: Record<string, readonly [number, number]> = {
        hypothyroidism: [2.0, 3.6], hyperthyroidism: [1.5, 3.6], diabetes_mellitus: [300, 420],
      };
      const range = controlled[workup.key]!;
      const value = round(range[0] + rng.next() * (range[1] - range[0]), workup.lab.decimals);
      const orderedAt = addMinutes(start, 16);
      const lab = labResult(pet, appointmentId, vet, orderedAt, workup.lab.testName, workup.lab.unit, workup.lab.low, workup.lab.high, value, "normal");
      const line = serviceLine(invoiceId, workup.lab.service, end);
      lines.push(line);
      work.push({ source: { labResultId: lab.id }, at: orderedAt, line });
      if (chronic.rx) closeRx(chronic.rx, "completed", addMinutes(start, 21), "Superseded by a new prescription at the monitoring visit.", vet);
      chronic.rx = prescribe(workup.medication, chronic.writtenScript, workup.refills, true, addDays(date, workup.medication.days * (workup.refills + 1) - 1));
      chronic.nextMonitoring = addDays(date, rng.int(150, 170));
    }

    const vars: Record<string, string> = { ...v };
    if (kind === "workup_result") {
      // The result-review note quotes the lab returned after the earlier visit;
      // monitoring notes never quote same-day labs, which arrive the next day.
      const workup = context!.workup!;
      vars.labValue = context!.suspected!.labValue;
      vars.labUnit = workup.lab.unit;
      vars.labRange = `${workup.lab.low}-${workup.lab.high}`;
    }

    // Consultation note (unless this visit carries the missing-note discrepancy).
    const missingNote =
      (kind === "wellness" || kind === "acute") &&
      charge === "charged" &&
      scheduler.claim("billed_visit_without_consultation_note", date);
    if (!missingNote) {
      noteRow(pet, appointmentId, vet, template!, vars, noteStart, finalizedAt);
      fact.note = classifyNoteLength(rows.soapNotes.at(-1)!);
    }

    // Dispensed medicines become invoice lines through their dispense charges.
    const desk = rng.pick(["desk1", "desk2"] as const);
    const issuedAt = addMinutes(finalizedAt, 3);
    for (const { chargeId, rx } of dispensedCharges) {
      const line = productLine(invoiceId, rx.product!, rx.quantity, issuedAt, dispenseDescription(rx), chargeId);
      lines.push(line);
      dispenseResolutions.push({ chargeId, invoiceId, invoiceItemId: line.id!, resolvedBy: staffId[desk], resolvedByName: staffName[desk], resolvedAt: issuedAt });
      work.push({ source: { prescriptionId: rx.id }, at: rx.createdAt, line });
    }

    let invoice: ReturnType<typeof createInvoice> | null = null;
    if (charge === "charged") {
      for (const line of lines) {
        line.createdAt = issuedAt;
        line.updatedAt = issuedAt;
      }
      if (scheduler.claim("price_below_catalog_without_adjustment", date)) {
        const exam = lines[0]!;
        const discounted = centsToMoney(Math.round(moneyToCents(exam.unitPrice) * 0.8));
        exam.unitPrice = discounted;
        exam.total = centsToMoney(quantityLineTotalCents(moneyToCents(discounted), 1));
        facts.discrepancies.push({
          type: "price_below_catalog_without_adjustment",
          description: "Exam fee charged 20% below the catalogue price with no invoice adjustment recorded.",
          records: { invoiceId, invoiceItemId: exam.id!, serviceId: exam.itemId!, catalogPrice: SERVICES[kindExam(kind)].price, chargedPrice: discounted },
        });
      }
      invoice = createInvoice({ pet, appointmentId, issuedAt, issuedOn: date, lines, paymentPlan: choosePaymentPlan(billingRng, false), cashier: desk });
      if (missingNote) {
        facts.discrepancies.push({
          type: "billed_visit_without_consultation_note",
          description: "Checked-out visit was invoiced but has no consultation (SOAP) note.",
          records: { appointmentId, invoiceId, patientId: pet.id },
        });
      }
    }
    for (const item of work) {
      if (item.noCharge || !invoice) {
        workItem(appointmentId, item.source, item.at, { noChargeReason: item.noCharge ?? "Included in a no-charge recheck." }, issuedAt, desk);
      } else {
        workItem(appointmentId, item.source, item.at, { invoiceId: invoice.invoiceId, invoiceItemId: item.line!.id! }, issuedAt, desk);
      }
    }

    // Visit closeout mirrors the clinical handoff and checkout.
    const completedAt = addMinutes(issuedAt, 5);
    const paidAtCheckout = invoice?.paidAt && invoice.paidAt <= completedAt;
    const laterPaid = invoice && !paidAtCheckout && invoice.paidAt;
    const closeoutFollowUp = followUp as { appointmentId: string; at: Date } | { dueDate: CalendarDate } | null;
    const closeout: Insert<typeof visitCloseouts> = {
      id: ids.uuid(), practiceId, appointmentId, status: "completed", diagnosisSummary: diagnosis,
      dischargeInstructions: `${fill(template!.plan, vars)} ${SYNTHETIC_FOOTER}`,
      warningSigns: "Return promptly for lethargy, not eating for 24 hours, repeated vomiting or difficulty breathing.",
      prescriptionDisposition: medSnapshot.length ? "prescribed" : "not_needed", medicationSnapshot: medSnapshot,
      followUpDisposition: closeoutFollowUp ? ("dueDate" in closeoutFollowUp ? "needed" : "scheduled") : "none",
      followUpNotes: closeoutFollowUp ? "Recheck as discussed with the owner." : null,
      followUpDueDate: closeoutFollowUp && "dueDate" in closeoutFollowUp ? closeoutFollowUp.dueDate : null,
      followUpAssignedTo: closeoutFollowUp && "dueDate" in closeoutFollowUp ? staffId.tech1 : null,
      followUpAssigneeName: closeoutFollowUp && "dueDate" in closeoutFollowUp ? staffName.tech1 : null,
      clinicalFinalizedAt: finalizedAt, clinicalFinalizedBy: staffId[vet], clinicalFinalizerName: staffName[vet],
      chargeDisposition: invoice ? (paidAtCheckout || laterPaid ? "paid" : "accounts_receivable") : "no_charge",
      invoiceId: invoice?.invoiceId ?? null, noChargeReason: invoice ? null : "Recheck included in the original visit fee.",
      handoffMethod: rng.pick(["print", "verbal"] as const), completedAt, completedBy: staffId[desk],
      revision: laterPaid ? 2 : 1, createdAt: finalizedAt, updatedAt: laterPaid ? invoice!.paidAt! : completedAt,
    };
    if (closeoutFollowUp && !("dueDate" in closeoutFollowUp)) {
      pendingCloseoutLinks.push({ closeout, followUp: closeoutFollowUp });
    }
    rows.visitCloseouts.push(closeout);
    const apptRow = rows.appointments.at(-1)!;
    apptRow.updatedAt = completedAt;
  }

  function kindExam(kind: VisitKind): ServiceKey {
    return kind === "wellness" ? "examWellness" : kind === "acute" || kind === "workup_suspected" ? "examProblem" : "examRecheck";
  }

  // Follow-up appointment ids are known only when the recheck day runs.
  const pendingFollowUps: { booking: Booking; attach: (id: string) => void }[] = [];
  const pendingCloseoutLinks: { closeout: Insert<typeof visitCloseouts>; followUp: { appointmentId: string; at: Date } }[] = [];
  const bookingAppointmentId = new Map<Booking, string>();

  // -------------------------------------------------------------------------
  // Counter (no-appointment) dispensing and refills
  // -------------------------------------------------------------------------
  function counterBill(pet: Pet, rx: Rx, chargeId: string, when: Date, date: CalendarDate, discrepancyEligible: boolean) {
    if (discrepancyEligible && scheduler.claim("unbilled_dispense", date)) {
      facts.discrepancies.push({
        type: "unbilled_dispense",
        description: "Medication dispensed from clinic stock (stock deducted) but the dispense charge was never invoiced.",
        records: { dispenseChargeId: chargeId, prescriptionId: rx.id, patientId: pet.id, productId: productId[rx.product!] },
      });
      return;
    }
    const desk = billingRng.pick(["desk1", "desk2"] as const);
    const invoiceId = ids.uuid();
    const issuedAt = addMinutes(when, billingRng.int(5, 40));
    const line = productLine(invoiceId, rx.product!, rx.quantity, issuedAt, dispenseDescription(rx), chargeId);
    dispenseResolutions.push({ chargeId, invoiceId, invoiceItemId: line.id!, resolvedBy: staffId[desk], resolvedByName: staffName[desk], resolvedAt: issuedAt });
    createInvoice({ pet, appointmentId: null, issuedAt, issuedOn: date, lines: [line], paymentPlan: choosePaymentPlan(billingRng, true), cashier: desk });
    facts.counterInvoiceIds.push(invoiceId);
  }

  function runRefill(rx: Rx, date: CalendarDate) {
    const pet = petsById.get(rx.patientId)!;
    const when = at(date, clinicalRng.int(10 * 60, 16 * 60));
    if (!inWindow(when) || rx.status !== "active" || rx.refillsRemaining <= 0 || date > rx.endDate) {
      rx.nextRefill = null;
      return;
    }
    const before = rx.refillsRemaining;
    rx.refillsRemaining -= 1;
    rx.lastEventAt = when;
    const eventId = ids.uuid();
    rows.prescriptionEvents.push({
      id: eventId, practiceId, prescriptionId: rx.id, patientId: rx.patientId, productId: rx.product ? productId[rx.product] : null,
      quantity: rx.quantity, eventType: rx.product ? "refill_dispensed" : "refill_authorized", statusBefore: "active", statusAfter: "active",
      refillsBefore: before, refillsAfter: rx.refillsRemaining, reason: rx.product ? null : "Refill authorised for an outside pharmacy.",
      actorId: staffId[rx.prescribedBy], actorName: staffName[rx.prescribedBy], operationId: ids.uuid(), createdAt: when,
    });
    if (rx.product) {
      movements.push({ product: rx.product, at: when, quantity: rx.quantity, kind: "dispensed" });
      const chargeId = ids.uuid();
      rows.dispenseCharges.push({
        id: chargeId, practiceId, prescriptionEventId: eventId, prescriptionId: rx.id, patientId: rx.patientId, clientId: rx.clientId,
        appointmentId: null, productId: productId[rx.product], quantity: rx.quantity, descriptionSnapshot: dispenseDescription(rx),
        unitPriceSnapshot: PRODUCTS[rx.product].unitPrice, status: "pending", createdAt: when, updatedAt: when,
      });
      counterBill(pet, rx, chargeId, when, date, true);
    }
    rx.nextRefill = rx.refillsRemaining > 0 ? addDays(date, rx.plan.days) : null;
  }

  // Established chronic patients recorded at go-live, renewed at the counter.
  const establishedTarget = Math.max(config.discrepanciesPerType + 2, Math.round(pets.length * 0.03));
  const eligibleEstablished = clinicalRng
    .shuffle(pets)
    .filter((pet) => WORKUPS.some((w) => w.species.includes(pet.species) && ageYears(pet.dob, config.startDate) >= w.minAgeYears + 1))
    .slice(0, establishedTarget);
  const counterRenewals = new Map<CalendarDate, Pet[]>();
  for (const pet of eligibleEstablished) {
    const workup = clinicalRng.pick(WORKUPS.filter((w) => w.species.includes(pet.species) && ageYears(pet.dob, config.startDate) >= w.minAgeYears + 1));
    const problemId = ids.uuid();
    const onset = addDays(config.startDate, -clinicalRng.int(200, 1400));
    rows.problemList.push({
      id: problemId, practiceId, patientId: pet.id, description: workup.condition, status: "active",
      onsetDate: onset < pet.dob ? addDays(pet.dob, 365) : onset, createdAt: pet.registeredAt, updatedAt: pet.registeredAt,
    });
    facts.establishedChronicPatients.push({ patientId: pet.id, condition: workup.condition, problemId });
    pet.chronic = { workup, writtenScript: clinicalRng.chance(0.15), rx: null, nextMonitoring: addDays(config.startDate, clinicalRng.int(30, 170)) };
    const renewal = nextOpenDay(addDays(config.startDate, clinicalRng.int(0, Math.min(20, Math.max(0, windowDays.length - 1)))));
    if (renewal <= config.endDate) {
      const list = counterRenewals.get(renewal) ?? [];
      list.push(pet);
      counterRenewals.set(renewal, list);
    }
  }

  function runCounterRenewal(pet: Pet, date: CalendarDate) {
    const chronic = pet.chronic!;
    const vet = pet.lastVet ?? clinicalRng.pick(VET_KEYS.filter((v) => vetWorks(v, date)));
    const when = at(date, clinicalRng.int(9 * 60, 16 * 60));
    const workup = chronic.workup;
    const { rx, chargeId } = createPrescription(pet, workup.medication, vet, null, date, when, {
      written: chronic.writtenScript, refills: workup.refills, chronic: true,
      endDate: addDays(date, workup.medication.days * (workup.refills + 1) - 1),
    });
    chronic.rx = rx;
    if (chargeId) counterBill(pet, rx, chargeId, when, date, true);
  }

  // -------------------------------------------------------------------------
  // Day loop
  // -------------------------------------------------------------------------
  const workupsQueue = config.guaranteedWorkups;
  let guaranteedPlaced = 0;
  let openDayIndex = 0;
  let newHouseholdCursor = 0;

  for (const date of windowDays) {
    // Prescription expiry runs nightly whether or not the clinic is open.
    const expiryAt = at(date, 2 * 60 + 15);
    for (const rx of rxList) {
      if (rx.status === "active" && rx.endDate < date) closeRx(rx, "expired", expiryAt, "Prescription end date elapsed.", null);
    }
    if (!isOpenDay(date)) continue;
    openDayIndex++;

    while (newHouseholdCursor < newHouseholdDays.length && newHouseholdDays[newHouseholdCursor] === date) {
      newHouseholdCursor++;
      const registeredAt = at(date, demandRng.int(9 * 60, 12 * 60));
      for (const pet of createHousehold(registeredAt, date)) {
        pet.wellnessDue = date;
        book(pet, addDays(date, demandRng.int(0, 5)), "wellness", registeredAt, undefined, null);
      }
    }

    const activePets = pets.filter((p) => p.registeredOn <= date);
    const bookedAt = (lead: number, pet: Pet) => {
      const candidate = at(addDays(date, -lead), demandRng.int(9 * 60, 17 * 60));
      return candidate < pet.registeredAt ? addMinutes(pet.registeredAt, 5) : candidate;
    };

    // Guaranteed diagnostic work-ups early in the window, alternating outcomes.
    if (guaranteedPlaced < workupsQueue && openDayIndex >= 2 && openDayIndex % 2 === 0) {
      const workup = WORKUPS[guaranteedPlaced % WORKUPS.length]!;
      const candidate = demandRng
        .shuffle(activePets)
        .find((p) => workup.species.includes(p.species) && !p.chronic && !p.pendingWorkup && !p.hasUpcoming && ageYears(p.dob, date) >= workup.minAgeYears);
      if (candidate) {
        const forceOutcome = guaranteedPlaced % 2 === 0 ? "confirmed" : "ruled_out";
        if (book(candidate, date, "workup_suspected", bookedAt(demandRng.int(1, 4), candidate), { workup, forceOutcome }, null)) guaranteedPlaced++;
      }
    }

    // Wellness demand: due pets book over the following weeks.
    for (const pet of activePets) {
      if (pet.hasUpcoming || pet.wellnessDue > date) continue;
      if (demandRng.chance(0.12 * config.wellnessVisitsPerPetYear)) {
        book(pet, date, "wellness", bookedAt(demandRng.int(2, 21), pet), undefined, pet.lastVet);
      }
    }

    // Sick-visit demand.
    const sickCount = demandRng.poisson((activePets.length * config.sickVisitsPerPetYear) / 252);
    for (let i = 0; i < sickCount; i++) {
      const pet = demandRng.pick(activePets);
      if (pet.hasUpcoming || pet.pendingWorkup) continue;
      const workups = WORKUPS.filter((w) => w.species.includes(pet.species) && ageYears(pet.dob, date) >= w.minAgeYears);
      if (!pet.chronic && workups.length && demandRng.chance(0.12)) {
        book(pet, date, "workup_suspected", bookedAt(demandRng.int(0, 3), pet), { workup: demandRng.pick(workups) }, pet.lastVet);
        continue;
      }
      const scenarios = ACUTE_SCENARIOS.filter((s) => s.species.includes(pet.species));
      if (!scenarios.length) continue;
      book(pet, date, "acute", bookedAt(demandRng.int(0, 2), pet), { acute: demandRng.pick(scenarios) }, pet.lastVet);
    }

    // Chronic monitoring visits.
    for (const pet of activePets) {
      if (pet.chronic && !pet.hasUpcoming && pet.chronic.nextMonitoring <= date) {
        if (book(pet, date, "chronic_monitoring", bookedAt(demandRng.int(5, 14), pet), { workup: pet.chronic.workup }, pet.lastVet)) {
          pet.chronic.nextMonitoring = addDays(date, 400);
        }
      }
    }

    // Run the day's appointments in time order.
    const today = (bookings.get(date) ?? []).sort((a, b) => a.minute - b.minute || (a.vet < b.vet ? -1 : a.vet > b.vet ? 1 : 0));
    for (const booking of today) {
      runVisit(booking);
      const appointmentId = rows.appointments.at(-1)!.id!;
      bookingAppointmentId.set(booking, appointmentId);
      const pending = pendingFollowUps.find((f) => f.booking === booking);
      if (pending) pending.attach(appointmentId);
    }

    for (const pet of counterRenewals.get(date) ?? []) runCounterRenewal(pet, date);
    for (const rx of rxList) if (rx.nextRefill && rx.nextRefill <= date && rx.status === "active") runRefill(rx, date);
  }

  // Link closeouts to the follow-up appointments booked at checkout.
  for (const { closeout, followUp } of pendingCloseoutLinks) {
    closeout.followUpAppointmentId = followUp.appointmentId;
    closeout.followUpScheduledAt = followUp.at;
  }

  const shortfall = scheduler.shortfall();
  if (shortfall.length) {
    throw new Error(
      `Not enough eligible events for the requested discrepancies (${shortfall.join(", ")}). Increase the population or date range, or lower --discrepancies-per-type.`,
    );
  }

  // -------------------------------------------------------------------------
  // Prescriptions (final state), inventory receipts and closing stock
  // -------------------------------------------------------------------------
  for (const rx of rxList) {
    rows.prescriptions.push({
      id: rx.id, practiceId, patientId: rx.patientId, appointmentId: rx.appointmentId, medicationName: rx.plan.medicationName,
      dosage: rx.plan.dosage, frequency: rx.plan.frequency, quantity: rx.quantity, productId: rx.product ? productId[rx.product] : null,
      refillsRemaining: rx.refillsRemaining, prescribedBy: staffId[rx.prescribedBy], startDate: rx.startDate, endDate: rx.endDate,
      status: rx.status, instructions: `${rx.plan.instructions} ${SYNTHETIC_FOOTER}`, operationId: rxOperationId(rx),
      createdAt: rx.createdAt, updatedAt: rx.lastEventAt,
    });
  }

  for (const key of Object.keys(PRODUCTS) as ProductKey[]) {
    const def = PRODUCTS[key];
    let stock = def.openingStock;
    let lastChange = goLiveAt;
    let receipts = 0;
    let dispensed = 0;
    let retail = 0;
    let pendingReceipt: Date | null = null;
    const receive = (when: Date) => {
      stock += def.reorderQuantity;
      receipts += def.reorderQuantity;
      lastChange = when;
      rows.stockAdjustments.push({
        id: ids.uuid(), practiceId, productId: productId[key], operationId: ids.uuid(), adjustment: def.reorderQuantity,
        quantityAfter: stock, reason: "Supplier order received (synthetic).", adjustedBy: staffId.admin, createdAt: when,
      });
    };
    const productMoves = movements.filter((m) => m.product === key).sort((a, b) => a.at.getTime() - b.at.getTime());
    for (const move of productMoves) {
      if (pendingReceipt && pendingReceipt <= move.at) {
        receive(pendingReceipt);
        pendingReceipt = null;
      }
      // Emergency receipt just before the movement, never before the previous one,
      // so recorded quantity_after values stay in time order.
      while (stock < move.quantity) {
        const earliest = Math.max(lastChange.getTime() + 1, addMinutes(move.at, -30).getTime());
        receive(new Date(Math.min(earliest, move.at.getTime())));
      }
      stock -= move.quantity;
      lastChange = move.at;
      if (move.kind === "dispensed") dispensed += move.quantity;
      else retail += move.quantity;
      if (stock < def.reorderPoint && !pendingReceipt) {
        pendingReceipt = at(nextOpenDay(addDays(dateOf(move.at), 1)), 9 * 60);
      }
    }
    if (pendingReceipt && inWindow(pendingReceipt)) receive(pendingReceipt);
    rows.products.push({
      id: productId[key], practiceId, locationId, name: def.name, sku: def.sku, category: def.category, unitPrice: def.unitPrice,
      costPrice: def.costPrice, stockQuantity: stock, reorderPoint: def.reorderPoint, taxable: true, inventoryTracked: true,
      createdAt: goLiveAt, updatedAt: lastChange,
    });
    facts.stock[def.sku] = { productId: productId[key], opening: def.openingStock, receipts, dispensed, retailSold: retail, closing: stock };
  }
  rows.stockAdjustments.sort((a, b) => (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime());

  return { config, practiceId, goLive, asOf, rows, dispenseResolutions, facts, staffEmails };
}
