import { addDays, diffDays, isCalendarDate, type CalendarDate } from "./time";

export const GENERATOR_VERSION = "1.0.0";

export type SyntheticConfig = {
  /** Stable dataset identifier; also scopes staff emails and the reset. */
  datasetId: string;
  /** Any string; the same seed + config reproduces the dataset exactly. */
  seed: string;
  startDate: CalendarDate;
  endDate: CalendarDate;
  /** Households registered when the clinic goes live on OpenVPM. */
  households: number;
  /** New households registering per 30 days during the window. */
  newHouseholdsPerMonth: number;
  /** Mean annual visit demand per patient. */
  wellnessVisitsPerPetYear: number;
  sickVisitsPerPetYear: number;
  /** Diagnostic work-ups guaranteed early in the window (suspected → outcome). */
  guaranteedWorkups: number;
  /** Instances of each deliberate discrepancy type. */
  discrepanciesPerType: number;
  practiceName: string;
  timezone: string;
  taxRatePercent: string;
};

export const PRESETS: Record<string, SyntheticConfig> = {
  "sample-1m": {
    datasetId: "sample-1m",
    seed: "openvpm-synthetic-sample-1m",
    startDate: "2026-10-01",
    endDate: "2026-10-31",
    households: 150,
    newHouseholdsPerMonth: 4,
    wellnessVisitsPerPetYear: 1,
    sickVisitsPerPetYear: 1.6,
    guaranteedWorkups: 4,
    discrepanciesPerType: 2,
    practiceName: "Harborview Animal Clinic (Synthetic)",
    timezone: "America/New_York",
    taxRatePercent: "8.00",
  },
  "three-year": {
    datasetId: "three-year",
    seed: "openvpm-synthetic-three-year",
    startDate: "2023-11-01",
    endDate: "2026-10-31",
    households: 300,
    newHouseholdsPerMonth: 5,
    wellnessVisitsPerPetYear: 1,
    sickVisitsPerPetYear: 1.6,
    guaranteedWorkups: 4,
    discrepanciesPerType: 6,
    practiceName: "Harborview Animal Clinic (Synthetic, 3-year)",
    timezone: "America/New_York",
    taxRatePercent: "8.00",
  },
};

export type Command = "generate" | "validate" | "reset" | "plan";

export type ParsedSyntheticArgs = {
  command: Command;
  config: SyntheticConfig;
  /** Replace an existing dataset with the same id (scoped reset first). */
  replace: boolean;
  /** Reset requires the dataset id to be typed back. */
  confirm?: string;
  outDir: string;
  allowRemoteDatabase: boolean;
};

const DATASET_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,39}$/;

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`--${name} needs a value`);
  }
  return value;
}

function positiveNumber(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a non-negative number`);
  return value;
}

export function validateConfig(config: SyntheticConfig, today: CalendarDate): void {
  if (!DATASET_ID_PATTERN.test(config.datasetId)) {
    throw new Error("Dataset id must be 3-40 lowercase letters, digits or hyphens.");
  }
  if (!config.seed.trim()) throw new Error("Seed must not be empty.");
  if (!isCalendarDate(config.startDate) || !isCalendarDate(config.endDate)) {
    throw new Error("Start and end dates must be valid YYYY-MM-DD dates.");
  }
  if (config.startDate > config.endDate) throw new Error("Start date must not be after end date.");
  if (config.endDate >= today) {
    // Historical generation only: future events would have to be invented as
    // already-completed, and "as of" would no longer mean the end date.
    throw new Error(`End date must be before today (${today}); this generator only writes history.`);
  }
  if (diffDays(config.endDate, config.startDate) > 366 * 4) {
    throw new Error("Date range is limited to four years.");
  }
  if (!Number.isInteger(config.households) || config.households < 10 || config.households > 5000) {
    throw new Error("Households must be an integer between 10 and 5000.");
  }
  if (config.newHouseholdsPerMonth > 200) throw new Error("New households per month is limited to 200.");
  if (config.discrepanciesPerType > 50) throw new Error("Discrepancies per type is limited to 50.");
  if (!/^\d{1,2}\.\d{2}$/.test(config.taxRatePercent)) throw new Error("Tax rate must look like 8.00.");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: config.timezone });
  } catch {
    throw new Error(`Unknown timezone: ${config.timezone}`);
  }
}

export function parseSyntheticArgs(args: string[], today: CalendarDate): ParsedSyntheticArgs {
  const command = args[0] as Command;
  if (!["generate", "validate", "reset", "plan"].includes(command)) {
    throw new Error("Usage: synthetic <generate|plan|validate|reset> --preset <name> [options]");
  }
  const presetName = flag(args, "preset") ?? "sample-1m";
  const preset = PRESETS[presetName];
  if (!preset) {
    throw new Error(`Unknown preset "${presetName}". Available: ${Object.keys(PRESETS).join(", ")}`);
  }
  const config: SyntheticConfig = {
    ...preset,
    datasetId: flag(args, "dataset") ?? preset.datasetId,
    seed: flag(args, "seed") ?? preset.seed,
    startDate: flag(args, "start") ?? preset.startDate,
    endDate: flag(args, "end") ?? preset.endDate,
    households: positiveNumber(flag(args, "households"), "households", preset.households),
    newHouseholdsPerMonth: positiveNumber(
      flag(args, "new-households-per-month"),
      "new-households-per-month",
      preset.newHouseholdsPerMonth,
    ),
    discrepanciesPerType: positiveNumber(
      flag(args, "discrepancies-per-type"),
      "discrepancies-per-type",
      preset.discrepanciesPerType,
    ),
  };
  validateConfig(config, today);
  return {
    command,
    config,
    replace: args.includes("--replace"),
    confirm: flag(args, "confirm"),
    outDir: flag(args, "out") ?? `synthetic-output/${config.datasetId}`,
    allowRemoteDatabase: args.includes("--allow-remote-db"),
  };
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "postgres"]);

/**
 * Synthetic data must never land in a hosted or shared database by accident.
 * Only local hosts are accepted unless the operator opts in explicitly.
 */
export function assertSafeDatabaseTarget(
  databaseUrl: string | undefined,
  env: Record<string, string | undefined>,
  allowRemote: boolean,
): void {
  if (!databaseUrl) throw new Error("DATABASE_URL is not set (copy .env.example to .env).");
  if (env.VERCEL || env.NODE_ENV === "production" || env.HOSTED_BILLING_ENABLED === "true") {
    throw new Error("Refusing to run against a production or hosted environment.");
  }
  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    throw new Error("DATABASE_URL is not a valid URL.");
  }
  if (!LOCAL_HOSTS.has(host) && !allowRemote) {
    throw new Error(
      `Refusing to write synthetic data to non-local database host "${host}". Pass --allow-remote-db if this is an isolated sandbox.`,
    );
  }
}

/** Calendar day after which no generated event may occur. */
export function asOfDate(config: SyntheticConfig): CalendarDate {
  return config.endDate;
}

export function goLiveDate(config: SyntheticConfig): CalendarDate {
  return addDays(config.startDate, -14);
}
