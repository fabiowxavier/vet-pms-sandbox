/**
 * Fictional reference data for the synthetic clinic: staff, owners, patients,
 * price list, formulary, and template-driven clinical scenarios. Nothing here
 * describes a real person, clinic, or patient.
 */

export type Species = "canine" | "feline" | "rabbit" | "avian" | "reptile";

/**
 * Only companion species with individual-animal workflows are generated.
 * Production and herd species (bovine, ovine, caprine, porcine, poultry,
 * camelid) exist in the species enum, but OpenVPM records every patient as an
 * individual animal: there is no herd/flock entity, group treatment, batch
 * dispensing, or withdrawal-period tracking. See docs/synthetic-data.md.
 */
export const SPECIES_WEIGHTS: readonly (readonly [Species, number])[] = [
  ["canine", 55],
  ["feline", 36],
  ["rabbit", 5],
  ["avian", 2],
  ["reptile", 2],
];

export const STAFF = [
  { key: "admin", name: "Jordan Ellis", role: "admin", license: null },
  { key: "vet1", name: "Dr. Priya Raman", role: "veterinarian", license: "VET-SYN-10421" },
  { key: "vet2", name: "Dr. Owen Castellano", role: "veterinarian", license: "VET-SYN-11873" },
  { key: "vet3", name: "Dr. Mei Lindqvist", role: "veterinarian", license: "VET-SYN-12905" },
  { key: "tech1", name: "Rosa Delgado", role: "technician", license: "LVT-SYN-3310" },
  { key: "tech2", name: "Caleb Nwosu", role: "technician", license: "LVT-SYN-3478" },
  { key: "desk1", name: "Hannah Brooks", role: "front_desk", license: null },
  { key: "desk2", name: "Diego Ferreira", role: "front_desk", license: null },
] as const;

export type StaffKey = (typeof STAFF)[number]["key"];

/** Weekdays (1=Mon … 5=Fri) each veterinarian consults. */
export const VET_SCHEDULE: Record<"vet1" | "vet2" | "vet3", readonly number[]> = {
  vet1: [1, 2, 3, 4, 5],
  vet2: [1, 2, 3, 4, 5],
  vet3: [1, 3, 5],
};

export const OWNER_FIRST_NAMES = [
  "Avery", "Blake", "Camille", "Dana", "Elliot", "Farah", "Gavin", "Helena", "Isaac", "Jasmine",
  "Kendall", "Leon", "Marisol", "Nolan", "Odette", "Pascal", "Quinn", "Rhea", "Silas", "Tamsin",
  "Ulric", "Vera", "Wesley", "Xiomara", "Yusuf", "Zara", "Anika", "Bruno", "Celeste", "Desmond",
  "Esme", "Felix", "Greta", "Hugo", "Ingrid", "Jonah", "Kira", "Lucian", "Mira", "Niall",
  "Orla", "Percy", "Rosalind", "Soren", "Thea", "Valentin", "Willa", "Yara", "Adair", "Briony",
] as const;

export const OWNER_LAST_NAMES = [
  "Ashdown", "Blackwood", "Calloway", "Draycott", "Everly", "Fairbanks", "Galloway", "Hartwell",
  "Ingersoll", "Jessop", "Kingsley", "Lockridge", "Marlowe", "Northcott", "Oakhurst", "Pemberton",
  "Quarles", "Ravenscroft", "Sutherland", "Thornbury", "Underhill", "Vance", "Whitlock", "Yardley",
  "Abernathy", "Brightwater", "Coldwell", "Dunmore", "Elsworth", "Fenwick", "Greaves", "Holloway",
  "Ivers", "Juniper", "Kestrel", "Langford", "Merriweather", "Nettleship", "Osgood", "Penhallow",
] as const;

export const STREETS = [
  "Tidewater Lane", "Beacon Hill Road", "Saltmarsh Way", "Lighthouse Drive", "Anchor Street",
  "Gull Point Road", "Harbor View Terrace", "Driftwood Court", "Seawall Avenue", "Compass Row",
] as const;

export const TOWNS = [
  { city: "Harborview", zip: "09901" },
  { city: "East Harborview", zip: "09902" },
  { city: "Saltmarsh", zip: "09905" },
] as const;

export const PET_NAMES = [
  "Biscuit", "Juniper", "Pepper", "Moose", "Olive", "Rufus", "Clementine", "Waffles", "Nova", "Ziggy",
  "Hazel", "Otis", "Poppy", "Bandit", "Maple", "Gizmo", "Willow", "Tank", "Luna", "Pickle",
  "Sprout", "Mochi", "Barnaby", "Tofu", "Indigo", "Rocket", "Fig", "Bramble", "Sable", "Kiwi",
  "Nugget", "Pip", "Winston", "Daisy", "Copper", "Marbles", "Ember", "Basil", "Quill", "Sunny",
  "Truffle", "Echo", "Dottie", "Jasper", "Nimbus", "Paprika", "Remy", "Saffron", "Tinker", "Yuki",
] as const;

export const BREEDS: Record<Species, readonly string[]> = {
  canine: [
    "Labrador Retriever", "Golden Retriever", "German Shepherd", "Beagle", "Border Collie",
    "Dachshund", "Boxer", "Cavalier King Charles Spaniel", "Mixed breed", "Shih Tzu",
    "Australian Shepherd", "Miniature Schnauzer", "Pit Bull mix", "Pembroke Welsh Corgi",
  ],
  feline: [
    "Domestic Shorthair", "Domestic Shorthair", "Domestic Longhair", "Maine Coon", "Siamese",
    "Ragdoll", "Bengal", "British Shorthair",
  ],
  rabbit: ["Holland Lop", "Netherland Dwarf", "Mini Rex", "Lionhead"],
  avian: ["Cockatiel", "Budgerigar", "Green-cheeked Conure"],
  reptile: ["Bearded Dragon", "Leopard Gecko", "Ball Python"],
};

export const COLORS: Record<Species, readonly string[]> = {
  canine: ["Black", "Yellow", "Chocolate", "Tricolor", "Brindle", "Red", "Black and tan", "White"],
  feline: ["Grey tabby", "Orange tabby", "Black", "Tortoiseshell", "Calico", "Seal point", "White"],
  rabbit: ["Agouti", "Black", "Broken orange", "White"],
  avian: ["Grey", "Green", "Lutino", "Pied"],
  reptile: ["Normal", "Hypo", "Tangerine"],
};

/** Adult body-weight range (kg) used to generate a plausible patient weight. */
export const WEIGHT_KG: Record<Species, readonly [number, number]> = {
  canine: [6, 38],
  feline: [3.2, 6.4],
  rabbit: [1.2, 2.6],
  avian: [0.04, 0.13],
  reptile: [0.06, 1.8],
};

export type ServiceDef = {
  code: string;
  name: string;
  category: string;
  price: string;
};

/** Professional services are not taxed; retail and dispensed products are. */
export const SERVICES = {
  examWellness: { code: "SYN-EXAM-WELL", name: "Wellness examination", category: "Exam", price: "68.00" },
  examProblem: { code: "SYN-EXAM-SICK", name: "Problem examination", category: "Exam", price: "74.00" },
  examRecheck: { code: "SYN-EXAM-RECHK", name: "Recheck examination", category: "Exam", price: "45.00" },
  vaxRabies: { code: "SYN-VAX-RAB", name: "Rabies vaccine", category: "Vaccine", price: "28.00" },
  vaxDhpp: { code: "SYN-VAX-DHPP", name: "DHPP vaccine", category: "Vaccine", price: "32.00" },
  vaxLepto: { code: "SYN-VAX-LEPTO", name: "Leptospirosis vaccine", category: "Vaccine", price: "30.00" },
  vaxBord: { code: "SYN-VAX-BORD", name: "Bordetella vaccine", category: "Vaccine", price: "26.00" },
  vaxFvrcp: { code: "SYN-VAX-FVRCP", name: "FVRCP vaccine", category: "Vaccine", price: "30.00" },
  vaxFelv: { code: "SYN-VAX-FELV", name: "FeLV vaccine", category: "Vaccine", price: "32.00" },
  vaxRhdv2: { code: "SYN-VAX-RHDV2", name: "RHDV2 vaccine", category: "Vaccine", price: "45.00" },
  labChem: { code: "SYN-LAB-CHEM", name: "Chemistry panel and CBC", category: "Lab", price: "145.00" },
  labT4: { code: "SYN-LAB-T4", name: "Total T4", category: "Lab", price: "62.00" },
  labFructosamine: { code: "SYN-LAB-FRUC", name: "Fructosamine", category: "Lab", price: "58.00" },
  labUrinalysis: { code: "SYN-LAB-UA", name: "Urinalysis", category: "Lab", price: "55.00" },
  cytologyEar: { code: "SYN-CYTO-EAR", name: "Ear cytology", category: "Diagnostic", price: "38.00" },
  cytologySkin: { code: "SYN-CYTO-SKIN", name: "Skin cytology", category: "Diagnostic", price: "38.00" },
  radiographs: { code: "SYN-RAD-2V", name: "Radiographs (2 views)", category: "Imaging", price: "185.00" },
} as const satisfies Record<string, ServiceDef>;

export type ServiceKey = keyof typeof SERVICES;

export type ProductDef = {
  sku: string;
  name: string;
  category: "Medication" | "Preventive" | "Retail";
  unitPrice: string;
  costPrice: string;
  openingStock: number;
  reorderPoint: number;
  reorderQuantity: number;
  /** Prescription-only: may only be supplied against a prescription. */
  prescriptionOnly: boolean;
};

export const PRODUCTS = {
  amoxClav: { sku: "SYN-AMXCL250", name: "Amoxicillin-clavulanate 250 mg tablet", category: "Medication", unitPrice: "1.10", costPrice: "0.32", openingStock: 600, reorderPoint: 150, reorderQuantity: 500, prescriptionOnly: true },
  cephalexin: { sku: "SYN-CEPH500", name: "Cephalexin 500 mg capsule", category: "Medication", unitPrice: "0.95", costPrice: "0.25", openingStock: 600, reorderPoint: 150, reorderQuantity: 500, prescriptionOnly: true },
  carprofen: { sku: "SYN-CARP75", name: "Carprofen 75 mg tablet", category: "Medication", unitPrice: "1.35", costPrice: "0.40", openingStock: 500, reorderPoint: 120, reorderQuantity: 400, prescriptionOnly: true },
  meloxicam: { sku: "SYN-MELOX15", name: "Meloxicam 1.5 mg/mL oral suspension (per mL)", category: "Medication", unitPrice: "0.85", costPrice: "0.20", openingStock: 1000, reorderPoint: 200, reorderQuantity: 800, prescriptionOnly: true },
  maropitant: { sku: "SYN-MARO16", name: "Maropitant 16 mg tablet", category: "Medication", unitPrice: "6.50", costPrice: "2.10", openingStock: 120, reorderPoint: 30, reorderQuantity: 100, prescriptionOnly: true },
  metronidazole: { sku: "SYN-METRO250", name: "Metronidazole 250 mg tablet", category: "Medication", unitPrice: "0.45", costPrice: "0.10", openingStock: 600, reorderPoint: 150, reorderQuantity: 500, prescriptionOnly: true },
  oticOintment: { sku: "SYN-OTIC15", name: "Otic antibiotic-steroid ointment 15 g", category: "Medication", unitPrice: "24.00", costPrice: "7.50", openingStock: 60, reorderPoint: 15, reorderQuantity: 50, prescriptionOnly: true },
  ophthalmicOintment: { sku: "SYN-OPHT35", name: "Ophthalmic antibiotic ointment 3.5 g", category: "Medication", unitPrice: "22.00", costPrice: "6.00", openingStock: 40, reorderPoint: 10, reorderQuantity: 40, prescriptionOnly: true },
  prednisolone: { sku: "SYN-PRED5", name: "Prednisolone 5 mg tablet", category: "Medication", unitPrice: "0.30", costPrice: "0.06", openingStock: 800, reorderPoint: 200, reorderQuantity: 600, prescriptionOnly: true },
  levothyroxine: { sku: "SYN-LEVO05", name: "Levothyroxine 0.5 mg tablet", category: "Medication", unitPrice: "0.40", costPrice: "0.09", openingStock: 600, reorderPoint: 150, reorderQuantity: 500, prescriptionOnly: true },
  methimazole: { sku: "SYN-METHI5", name: "Methimazole 5 mg tablet", category: "Medication", unitPrice: "0.55", costPrice: "0.12", openingStock: 600, reorderPoint: 150, reorderQuantity: 500, prescriptionOnly: true },
  benazepril: { sku: "SYN-BENAZ25", name: "Benazepril 2.5 mg tablet", category: "Medication", unitPrice: "0.60", costPrice: "0.14", openingStock: 600, reorderPoint: 150, reorderQuantity: 500, prescriptionOnly: true },
  insulin: { sku: "SYN-INSUL10", name: "Veterinary insulin 10 mL vial", category: "Medication", unitPrice: "95.00", costPrice: "42.00", openingStock: 20, reorderPoint: 5, reorderQuantity: 15, prescriptionOnly: true },
  fleaTick: { sku: "SYN-FLEA1", name: "Flea and tick chewable (1 dose)", category: "Preventive", unitPrice: "22.00", costPrice: "9.50", openingStock: 300, reorderPoint: 60, reorderQuantity: 240, prescriptionOnly: false },
  dentalChews: { sku: "SYN-DENT30", name: "Dental chews (30 count)", category: "Retail", unitPrice: "14.00", costPrice: "6.00", openingStock: 80, reorderPoint: 20, reorderQuantity: 60, prescriptionOnly: false },
} as const satisfies Record<string, ProductDef>;

export type ProductKey = keyof typeof PRODUCTS;

export type VaccineDef = {
  service: ServiceKey;
  name: string;
  manufacturer: string;
};

export const VACCINES: Record<Species, readonly VaccineDef[]> = {
  canine: [
    { service: "vaxRabies", name: "Rabies", manufacturer: "Synthetic Biologics" },
    { service: "vaxDhpp", name: "DHPP", manufacturer: "Synthetic Biologics" },
    { service: "vaxLepto", name: "Leptospirosis (4-way)", manufacturer: "Fictional Animal Health" },
  ],
  feline: [
    { service: "vaxRabies", name: "Rabies (feline)", manufacturer: "Synthetic Biologics" },
    { service: "vaxFvrcp", name: "FVRCP", manufacturer: "Fictional Animal Health" },
  ],
  rabbit: [{ service: "vaxRhdv2", name: "RHDV2", manufacturer: "Fictional Animal Health" }],
  avian: [],
  reptile: [],
};

export type NoteTemplate = {
  subjective: string;
  objective: string;
  assessment: string;
  plan: string;
};

export type MedicationPlan = {
  product: ProductKey;
  medicationName: string;
  dosage: string;
  frequency: string;
  /** Units dispensed for one course or one 30-day supply. */
  quantity: number;
  days: number;
  instructions: string;
};

export type AcuteScenario = {
  key: string;
  species: readonly Species[];
  diagnosis: string;
  diagnostic?: ServiceKey;
  medication: MedicationPlan;
  /** Probability the medicine is a written script filled elsewhere (no dispense). */
  writtenScriptProbability: number;
  recheckProbability: number;
  recheckDays: readonly [number, number];
  shortNote: NoteTemplate;
  longNote: NoteTemplate;
  recheckNote: NoteTemplate;
};

const VITALS = "T {temp} F, HR {hr}, RR {rr}. Weight {weight} kg. BCS {bcs}/9.";

export const ACUTE_SCENARIOS: readonly AcuteScenario[] = [
  {
    key: "otitis_externa",
    species: ["canine", "feline"],
    diagnosis: "Otitis externa",
    diagnostic: "cytologyEar",
    medication: { product: "oticOintment", medicationName: "Otic antibiotic-steroid ointment", dosage: "4 drops in affected ear", frequency: "Twice daily", quantity: 1, days: 10, instructions: "Clean the ear before applying. Complete the full course." },
    writtenScriptProbability: 0.05,
    recheckProbability: 0.55,
    recheckDays: [10, 14],
    shortNote: {
      subjective: "Head shaking and scratching at the right ear for 4 days.",
      objective: `${VITALS} Right ear canal erythematous with brown discharge. Cytology: cocci and yeast.`,
      assessment: "Otitis externa, right ear.",
      plan: "Ear cleaned in clinic. Topical otic ointment dispensed. Recheck in 2 weeks.",
    },
    longNote: {
      subjective: "Owner reports {pet} has been shaking the head and scratching at the right ear for about 4 days, worse at night. No change in appetite or energy. One similar episode last summer resolved with drops. No recent swimming or grooming.",
      objective: `${VITALS} Bright and alert. Right vertical ear canal erythematous and mildly stenotic with moderate brown waxy discharge and malodour; tympanic membrane visualised and intact after cleaning. Left ear within normal limits. Ear cytology (right): many cocci, moderate Malassezia, no rods seen. Mild pain on manipulation of the pinna.`,
      assessment: "Bacterial and yeast otitis externa, right ear. Tympanic membrane intact. Possible underlying atopy given recurrence; monitor.",
      plan: "Right ear flushed in clinic. Dispensed otic antibiotic-steroid ointment, 4 drops twice daily for 10 days after cleaning. Discussed ear-cleaning technique with owner. Recheck with repeat cytology in 10 to 14 days. If recurrent, discuss allergy work-up.",
    },
    recheckNote: {
      subjective: "Owner reports much less head shaking. Medication completed.",
      objective: `${VITALS} Right ear canal mildly pink, minimal discharge. Repeat cytology: rare yeast only.`,
      assessment: "Otitis externa, resolving.",
      plan: "Continue weekly ear cleaning. Recheck if signs recur.",
    },
  },
  {
    key: "gastroenteritis",
    species: ["canine", "feline"],
    diagnosis: "Acute gastroenteritis",
    medication: { product: "metronidazole", medicationName: "Metronidazole 250 mg", dosage: "1 tablet", frequency: "Twice daily", quantity: 10, days: 5, instructions: "Give with food. Bland diet for 3 days." },
    writtenScriptProbability: 0.1,
    recheckProbability: 0.2,
    recheckDays: [5, 7],
    shortNote: {
      subjective: "Two days of soft stool, one episode of vomiting yesterday. Still eating.",
      objective: `${VITALS} Mild abdominal discomfort, no masses palpated. Hydration adequate.`,
      assessment: "Acute gastroenteritis, likely dietary indiscretion.",
      plan: "Bland diet 3 days. Metronidazole dispensed. Call if vomiting continues.",
    },
    longNote: {
      subjective: "{pet} has had soft to liquid stool for two days with one episode of vomiting yesterday evening (food, no blood). Appetite reduced but still eating small meals; drinking normally. Got into the kitchen bin three days ago. Vaccinations current. No toxins known.",
      objective: `${VITALS} Quiet but responsive. Mucous membranes pink and moist, CRT under 2 seconds. Mild discomfort on cranial abdominal palpation, no masses or foreign material palpable, no gas distension. Rectal exam: soft brown faeces, no melena.`,
      assessment: "Acute gastroenteritis, most consistent with dietary indiscretion. Foreign body considered less likely given normal palpation and continued appetite. Hydration adequate.",
      plan: "Bland diet in small frequent meals for 3 days, then transition back. Metronidazole dispensed for 5 days. Discussed warning signs: repeated vomiting, lethargy, blood in stool, not eating; if any occur, return for radiographs and fluids.",
    },
    recheckNote: {
      subjective: "Stool normal for 3 days. Eating well.",
      objective: `${VITALS} Abdomen soft and non-painful.`,
      assessment: "Gastroenteritis resolved.",
      plan: "Return to regular diet. No further treatment.",
    },
  },
  {
    key: "pyoderma",
    species: ["canine"],
    diagnosis: "Superficial pyoderma",
    diagnostic: "cytologySkin",
    medication: { product: "cephalexin", medicationName: "Cephalexin 500 mg", dosage: "1 capsule", frequency: "Twice daily", quantity: 42, days: 21, instructions: "Give with food. Finish every capsule." },
    writtenScriptProbability: 0.1,
    recheckProbability: 0.6,
    recheckDays: [18, 24],
    shortNote: {
      subjective: "Itchy red spots on the belly for a week.",
      objective: `${VITALS} Papules and epidermal collarettes on ventral abdomen. Cytology: neutrophils with intracellular cocci.`,
      assessment: "Superficial bacterial pyoderma.",
      plan: "Cephalexin for 21 days. Recheck in 3 weeks.",
    },
    longNote: {
      subjective: "Owner noticed red bumps and scabs on {pet}'s belly about a week ago, now spreading to the inner thighs. Moderately itchy, licking more at night. On monthly flea prevention. No diet change. No other pets affected.",
      objective: `${VITALS} Multifocal erythematous papules, pustules and epidermal collarettes over the ventral abdomen and medial thighs. No alopecia elsewhere; ears clean. No fleas or flea dirt found. Impression cytology: degenerate neutrophils with intracellular cocci.`,
      assessment: "Superficial bacterial pyoderma. Underlying allergic skin disease possible; flea allergy unlikely with current prevention.",
      plan: "Cephalexin twice daily for 21 days. Chlorhexidine bathing twice weekly recommended. Recheck in 3 weeks before stopping antibiotics; if not resolved, culture and susceptibility.",
    },
    recheckNote: {
      subjective: "Itching much improved. No new spots.",
      objective: `${VITALS} Residual hyperpigmentation only; no active lesions.`,
      assessment: "Pyoderma resolved clinically.",
      plan: "Finish remaining antibiotic doses. Recheck if lesions recur.",
    },
  },
  {
    key: "soft_tissue_lameness",
    species: ["canine"],
    diagnosis: "Soft-tissue lameness",
    medication: { product: "carprofen", medicationName: "Carprofen 75 mg", dosage: "1 tablet", frequency: "Once daily", quantity: 7, days: 7, instructions: "Give with food. Stop and call if vomiting or dark stool." },
    writtenScriptProbability: 0.05,
    recheckProbability: 0.45,
    recheckDays: [12, 16],
    shortNote: {
      subjective: "Limping on the left hind since a run at the park yesterday.",
      objective: `${VITALS} Grade 2/5 left pelvic limb lameness. Mild pain on stifle extension; drawer test negative.`,
      assessment: "Suspected soft-tissue strain, left hind.",
      plan: "Strict rest 2 weeks. Carprofen 7 days. Recheck if not improving.",
    },
    longNote: {
      subjective: "{pet} started limping on the left hind leg after chasing a ball at the park yesterday. Toe-touching at first, now partially weight-bearing. Eating and drinking normally. No previous orthopaedic problems.",
      objective: `${VITALS} Grade 2/5 weight-bearing lameness of the left pelvic limb. Mild discomfort on full extension of the left stifle and on palpation of the medial thigh musculature. Cranial drawer and tibial thrust negative under conscious exam; no effusion palpable. Hip range of motion comfortable. Paws and nails normal.`,
      assessment: "Soft-tissue strain of the left pelvic limb suspected. Early cruciate ligament injury not excluded; radiographs declined for now.",
      plan: "Strict lead-walk-only rest for 2 weeks. Carprofen once daily with food for 7 days. Discussed NSAID side effects. Recheck in 2 weeks; if lameness persists, sedated radiographs and orthopaedic exam.",
    },
    recheckNote: {
      subjective: "No limping for the last week.",
      objective: `${VITALS} Sound at walk and trot. Stifle stable and non-painful.`,
      assessment: "Soft-tissue strain resolved.",
      plan: "Gradual return to exercise over 2 weeks.",
    },
  },
  {
    key: "conjunctivitis",
    species: ["canine", "feline", "rabbit"],
    diagnosis: "Conjunctivitis",
    medication: { product: "ophthalmicOintment", medicationName: "Ophthalmic antibiotic ointment", dosage: "1/4 inch strip", frequency: "Three times daily", quantity: 1, days: 7, instructions: "Apply to the affected eye. Do not touch the tip to the eye." },
    writtenScriptProbability: 0.05,
    recheckProbability: 0.25,
    recheckDays: [7, 10],
    shortNote: {
      subjective: "Left eye red and weepy for 2 days.",
      objective: `${VITALS} Left conjunctival hyperaemia with mucoid discharge. Fluorescein stain negative.`,
      assessment: "Conjunctivitis, left eye.",
      plan: "Ophthalmic ointment 7 days. Recheck if not improving in 3 days.",
    },
    longNote: {
      subjective: "Owner noticed {pet}'s left eye was red and watery two days ago; discharge now thicker. Squinting slightly in bright light. No known trauma. Eating normally.",
      objective: `${VITALS} Left eye: moderate conjunctival hyperaemia and chemosis, mucoid discharge at the medial canthus, mild blepharospasm. Fluorescein stain negative; no foreign body under the third eyelid. Menace and pupillary light reflexes normal both eyes. Right eye normal.`,
      assessment: "Conjunctivitis, left eye, no corneal ulceration.",
      plan: "Ophthalmic antibiotic ointment three times daily for 7 days. E-collar if rubbing. Recheck promptly if squinting worsens or the eye looks cloudy.",
    },
    recheckNote: {
      subjective: "Eye looks normal. Treatment finished.",
      objective: `${VITALS} Left eye quiet, no discharge.`,
      assessment: "Conjunctivitis resolved.",
      plan: "No further treatment.",
    },
  },
  {
    key: "upper_respiratory",
    species: ["feline"],
    diagnosis: "Feline upper respiratory infection",
    medication: { product: "amoxClav", medicationName: "Amoxicillin-clavulanate 250 mg", dosage: "1/2 tablet", frequency: "Twice daily", quantity: 7, days: 7, instructions: "Give with a small meal. Steam therapy in the bathroom twice daily." },
    writtenScriptProbability: 0.1,
    recheckProbability: 0.2,
    recheckDays: [7, 10],
    shortNote: {
      subjective: "Sneezing and nasal discharge for 3 days.",
      objective: `${VITALS} Bilateral mucopurulent nasal discharge. Lungs clear.`,
      assessment: "Upper respiratory infection.",
      plan: "Amoxicillin-clavulanate 7 days. Supportive care.",
    },
    longNote: {
      subjective: "{pet} has been sneezing for 3 days with thick nasal discharge since yesterday. Eating less but still interested in strong-smelling food. Indoor cat; a new kitten joined the household two weeks ago.",
      objective: `${VITALS} Bilateral mucopurulent nasal discharge, mild serous ocular discharge, no oral ulcers. Submandibular lymph nodes mildly enlarged. Thoracic auscultation: clear lung fields, no crackles. Hydration adequate.`,
      assessment: "Upper respiratory infection, likely viral with secondary bacterial component. No evidence of pneumonia.",
      plan: "Amoxicillin-clavulanate for 7 days. Steam therapy, warmed food, keep nostrils clean. Separate from the new kitten where possible. Return if not eating for 24 hours or breathing becomes laboured.",
    },
    recheckNote: {
      subjective: "Sneezing much less. Eating normally.",
      objective: `${VITALS} Minimal serous nasal discharge.`,
      assessment: "URI resolving.",
      plan: "Finish antibiotics.",
    },
  },
];

export type LabTest = {
  service: ServiceKey;
  testName: string;
  unit: string;
  low: string;
  high: string;
  /** Result range when the suspected condition is present / absent. */
  confirmRange: readonly [number, number];
  ruleOutRange: readonly [number, number];
  decimals: number;
};

export type Workup = {
  key: string;
  condition: string;
  species: readonly Species[];
  minAgeYears: number;
  lab: LabTest;
  confirmProbability: number;
  medication: MedicationPlan;
  refills: number;
  suspectedNote: NoteTemplate;
  confirmedNote: NoteTemplate;
  ruledOutNote: NoteTemplate;
  monitoringNote: NoteTemplate;
};

export const WORKUPS: readonly Workup[] = [
  {
    key: "hypothyroidism",
    condition: "Hypothyroidism",
    species: ["canine"],
    minAgeYears: 5,
    lab: { service: "labT4", testName: "Total T4", unit: "ug/dL", low: "1.0", high: "4.0", confirmRange: [0.3, 0.8], ruleOutRange: [1.6, 3.2], decimals: 1 },
    confirmProbability: 0.6,
    medication: { product: "levothyroxine", medicationName: "Levothyroxine 0.5 mg", dosage: "1 tablet", frequency: "Twice daily", quantity: 60, days: 30, instructions: "Give at the same times each day, ideally apart from meals." },
    refills: 5,
    suspectedNote: {
      subjective: "Owner reports {pet} has gained weight over several months despite no diet change, seems tired on walks, and the coat has thinned over the flanks and tail. Seeks warm spots in the house. Drinking and urinating normally.",
      objective: `${VITALS} Dull, dry coat with bilateral symmetrical truncal hypotrichosis and thinning of the tail ('rat tail'). Mild bradycardia for size. No pruritus. Remainder of physical exam unremarkable. Blood drawn for total T4.`,
      assessment: "SUSPECTED hypothyroidism (weight gain, lethargy, endocrine alopecia). Differentials: hyperadrenocorticism, obesity alone. Diagnosis NOT yet confirmed; pending total T4.",
      plan: "Total T4 submitted. Recheck in 1 week to review results and decide on treatment. No medication started until results confirm.",
    },
    confirmedNote: {
      subjective: "Here to review thyroid results. No change at home: still lethargic, weight stable.",
      objective: `${VITALS} Coat changes unchanged. Total T4 {labValue} {labUnit} (reference {labRange}), below range.`,
      assessment: "CONFIRMED hypothyroidism: compatible clinical signs with low total T4.",
      plan: "Start levothyroxine twice daily (30-day supply dispensed, refills authorised). Recheck T4 4 to 6 hours post-pill in 4 to 6 weeks. Added to problem list.",
    },
    ruledOutNote: {
      subjective: "Here to review thyroid results.",
      objective: `${VITALS} Total T4 {labValue} {labUnit} (reference {labRange}), within range.`,
      assessment: "Hypothyroidism RULED OUT (normal total T4). Weight gain attributed to diet and reduced activity.",
      plan: "Weight-loss plan: reduce daily food by 15%, increase walks. Weigh monthly. No medication.",
    },
    monitoringNote: {
      subjective: "Thyroid monitoring visit. Owner reports better energy and coat regrowth.",
      objective: `${VITALS} Coat regrowing. Blood drawn 4 hours post-pill for total T4 monitoring; result to follow.`,
      assessment: "Hypothyroidism, clinically well controlled on levothyroxine.",
      plan: "Continue current dose pending T4 result. New prescription issued. Next monitoring in 6 months.",
    },
  },
  {
    key: "hyperthyroidism",
    condition: "Hyperthyroidism",
    species: ["feline"],
    minAgeYears: 9,
    lab: { service: "labT4", testName: "Total T4", unit: "ug/dL", low: "0.8", high: "4.7", confirmRange: [6.2, 11.5], ruleOutRange: [1.4, 3.8], decimals: 1 },
    confirmProbability: 0.65,
    medication: { product: "methimazole", medicationName: "Methimazole 5 mg", dosage: "1/2 tablet", frequency: "Twice daily", quantity: 30, days: 30, instructions: "Wear gloves when handling tablets. Report vomiting or facial itching." },
    refills: 5,
    suspectedNote: {
      subjective: "Owner reports {pet} is losing weight despite a ravenous appetite, vocalising at night, and vomiting occasionally. Drinking more than usual.",
      objective: `${VITALS} Thin with palpable left thyroid nodule. Tachycardia with a soft systolic murmur. Unkempt coat. Blood drawn for total T4 and chemistry.`,
      assessment: "SUSPECTED hyperthyroidism (weight loss with polyphagia, palpable thyroid nodule, tachycardia). Not yet confirmed; pending total T4.",
      plan: "Total T4 submitted. Recheck in 1 week to discuss results and treatment options.",
    },
    confirmedNote: {
      subjective: "Results review. Still losing weight, appetite high.",
      objective: `${VITALS} Total T4 {labValue} {labUnit} (reference {labRange}), above range.`,
      assessment: "CONFIRMED hyperthyroidism.",
      plan: "Start methimazole twice daily (30-day supply dispensed, refills authorised). Recheck T4 and kidney values in 3 weeks. Discussed radioiodine as definitive option. Added to problem list.",
    },
    ruledOutNote: {
      subjective: "Results review.",
      objective: `${VITALS} Total T4 {labValue} {labUnit} (reference {labRange}), within range.`,
      assessment: "Hyperthyroidism RULED OUT. Weight loss under investigation; dental disease and IBD considered.",
      plan: "Dietary trial and weigh-in in 4 weeks. No medication.",
    },
    monitoringNote: {
      subjective: "Thyroid monitoring. Weight stable, vomiting resolved.",
      objective: `${VITALS} Weight stable since last visit. Blood drawn for total T4 monitoring; result to follow.`,
      assessment: "Hyperthyroidism, clinically controlled on methimazole.",
      plan: "Continue methimazole. New prescription issued. Recheck in 6 months.",
    },
  },
  {
    key: "diabetes_mellitus",
    condition: "Diabetes mellitus",
    species: ["canine", "feline"],
    minAgeYears: 6,
    lab: { service: "labFructosamine", testName: "Fructosamine", unit: "umol/L", low: "190", high: "365", confirmRange: [520, 760], ruleOutRange: [230, 340], decimals: 0 },
    confirmProbability: 0.55,
    medication: { product: "insulin", medicationName: "Veterinary insulin (40 IU/mL)", dosage: "Per glucose curve", frequency: "Twice daily with meals", quantity: 1, days: 30, instructions: "Store in the fridge. Roll gently, do not shake. Feed before injecting." },
    refills: 5,
    suspectedNote: {
      subjective: "Owner reports marked increase in drinking and urination over 3 weeks, with weight loss despite good appetite.",
      objective: `${VITALS} Mild dehydration, otherwise unremarkable exam. In-clinic glucose elevated. Blood drawn for fructosamine; urine glucose positive on dipstick.`,
      assessment: "SUSPECTED diabetes mellitus (polyuria, polydipsia, weight loss, hyperglycaemia, glucosuria). Stress hyperglycaemia not excluded; pending fructosamine.",
      plan: "Fructosamine submitted. Recheck in 1 week. Discussed what treatment would involve if confirmed.",
    },
    confirmedNote: {
      subjective: "Results review. Still drinking a lot.",
      objective: `${VITALS} Fructosamine {labValue} {labUnit} (reference {labRange}), above range.`,
      assessment: "CONFIRMED diabetes mellitus.",
      plan: "Start insulin twice daily with meals (vial dispensed, refills authorised). Injection technique demonstrated. Glucose curve in 7 days. Added to problem list.",
    },
    ruledOutNote: {
      subjective: "Results review. Drinking slightly less.",
      objective: `${VITALS} Fructosamine {labValue} {labUnit} (reference {labRange}), within range.`,
      assessment: "Diabetes mellitus RULED OUT; earlier hyperglycaemia attributed to stress. Urinalysis advised to investigate drinking.",
      plan: "Monitor water intake at home. Recheck if signs persist.",
    },
    monitoringNote: {
      subjective: "Diabetes monitoring. Drinking normalised.",
      objective: `${VITALS} Hydration normal. Blood drawn for fructosamine monitoring; result to follow.`,
      assessment: "Diabetes mellitus, clinically controlled.",
      plan: "Continue insulin. New prescription issued. Recheck in 3 to 6 months.",
    },
  },
];

export type WellnessNotes = { short: NoteTemplate; long: NoteTemplate };

export const WELLNESS_NOTES: WellnessNotes = {
  short: {
    subjective: "Annual wellness visit. No concerns at home.",
    objective: `${VITALS} Physical exam within normal limits.`,
    assessment: "Healthy {species}.",
    plan: "Vaccines as due. Continue parasite prevention. Next wellness in 12 months.",
  },
  long: {
    subjective: "Annual wellness visit for {pet}. Owner reports good appetite, normal energy, normal stool and urination. Indoor/outdoor lifestyle unchanged. On monthly parasite prevention. No coughing, vomiting or diarrhoea. Owner asked about dental care and diet.",
    objective: `${VITALS} Bright, alert, responsive. Eyes, ears and nose clear. Mild tartar on upper premolars (grade 1). Heart and lungs auscultate normally. Abdomen soft and non-painful. Lymph nodes normal size. Skin and coat healthy. Musculoskeletal exam normal.`,
    assessment: "Healthy adult {species}. Grade 1 dental tartar.",
    plan: "Vaccines as due today. Discussed home dental care (daily brushing, dental chews). Continue current diet and parasite prevention. Next wellness exam in 12 months; dental cleaning to be considered next year.",
  },
};

/** Appended to every generated free-text field that a clinician would read. */
export const SYNTHETIC_FOOTER = "[Synthetic record: fictional patient generated for testing.]";
