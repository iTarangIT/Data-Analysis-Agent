import { z } from "zod";

/**
 * Portal normalizers (SAD §11 step 6, §18 — Milestone 4A/4B).
 *
 * PURE PARSING, AND NOTHING ELSE. A normalizer takes the raw structure an
 * extractor read off a page and turns it into the shape the rest of the system
 * agrees on. It performs no I/O, opens no page, reaches no service, holds no
 * state, and reads no clock — given the same raw input it returns the same
 * output, for ever.
 *
 * ## Why purity is a boundary and not a preference
 *
 * Everything hard about scraping lives on the other side of this file. An
 * extractor deals with a live, slow, occasionally-changed dashboard; it can only
 * be exercised against the real portal. A normalizer deals with a value that is
 * already in memory, so it is testable from a fixture, reviewable by reading it,
 * and diagnosable from a failure alone. Keeping the two apart is what makes
 * "Intellicar changed its markup" and "we parsed it wrong" different bugs with
 * different fixes.
 *
 * fixtures/fleet-overview.raw.json is a real capture from the live dashboard,
 * and it is what makes that claim true rather than aspirational: the normalizer
 * below can be run against it with no browser, no session and no network.
 *
 * That is why this module MUST NOT import Playwright. It is enforced
 * mechanically by the Portal zone in eslint.config.mjs, not left to review: a
 * `Page` reaching this file would let a normalizer navigate, and the separation
 * above would quietly stop being true. It is also why the `Extractor` contract
 * lives in portal.service.ts rather than here — that one names a `Page`, and
 * this file may never see the type.
 *
 * ## Zod schemas live here too
 *
 * A schema describes a normalizer's OUTPUT, so the two belong side by side and
 * change together (SAD §11 step 6: "normalise the raw extraction into Zod-typed
 * JSON"). Nothing here calls `parse`: validation is applied once, for every
 * capability, by `defineCapability()` in portal.service.ts — the same reasoning
 * that puts the result envelope in the Tool Registry rather than in each tool,
 * so no capability can forget it.
 */

/* -------------------------------------------------------------------------- */
/*  Shared contract                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Turn one module's raw extraction into its normalised shape.
 *
 * `TRaw` is whatever that module's extractor returns — an implementation detail
 * shared by exactly one extractor and one normalizer, and deliberately never
 * part of the Portal Service's public surface (`defineCapability()` binds the
 * pair and erases the type).
 *
 * A normalizer reports missing data as missing rather than throwing, and never
 * substitutes a zero for an absent measurement (SAD §19, Milestone 2C). A THROW
 * from here means the raw input was not the shape the extractor promised —
 * a genuine fault, not an empty dashboard.
 */
export type Normalizer<TRaw, TOut> = (raw: TRaw) => TOut;

/* -------------------------------------------------------------------------- */
/*  Shared parsing                                                            */
/* -------------------------------------------------------------------------- */

/** Collapse whitespace and trim. Rendered text is full of layout whitespace. */
export function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Read a rendered count.
 *
 * Returns null rather than a number for anything that is not a plain
 * non-negative integer — an empty cell, a dash, a spinner's placeholder. Null
 * becomes `available: false` with a reason; it never becomes 0. A zero and an
 * unknown are different answers about a fleet, and collapsing them is how a
 * dashboard that failed to render reports itself as a fleet with nothing
 * happening (SAD §19, "missing data is reported, not thrown").
 *
 * Thousands separators are tolerated because a 4-digit fleet renders as
 * "1,204" in this portal's locale.
 */
export function parseCount(text: string): number | null {
  const cleaned = squash(text).replace(/,/g, "");
  if (!/^\d+$/.test(cleaned)) return null;

  const value = Number(cleaned);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * Read a rendered decimal measurement.
 *
 * The companion to `parseCount` for quantities that are not counts — a speed, a
 * percentage. Same contract: anything that is not a plain finite number becomes
 * null, which becomes `available: false` with a reason, and never a zero. A
 * stationary vehicle and a vehicle whose speed did not render are different
 * answers.
 */
export function parseDecimal(text: string): number | null {
  const cleaned = squash(text).replace(/,/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;

  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * Read a coordinate pair as this portal renders one: "(25.49601,81.850116)".
 *
 * The Vehicle Summary's Address column carries coordinates rather than a street
 * address on this deployment, so both shapes have to be distinguishable. A
 * failure here is not an error — it means the cell held something else, and the
 * caller reports it as text instead.
 */
export function parseCoordinates(
  text: string
): { lat: number; lon: number } | null {
  const match = /^\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)$/.exec(
    squash(text)
  );
  if (match === null) return null;

  const lat = Number(match[1]);
  const lon = Number(match[2]);

  // Out-of-range values are a parse failure, not a position. Reporting a
  // latitude of 250 would put a vehicle nowhere on Earth while looking precise.
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return null;
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) return null;

  return { lat, lon };
}

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

/**
 * Turn a rendered wall clock — "03-Aug-2026 03:13" — into an ISO instant.
 *
 * ## Why the offset is a parameter
 *
 * The rendered string carries no timezone. This portal is a React SPA that
 * formats dates client-side, so the zone that produced the text is the
 * BROWSER's, which is a property of the machine running the scrape rather than
 * of the data (SAD §19, Milestone 4C). The extractor measures it in the page and
 * hands it over; applying it here keeps this function pure — the offset is an
 * input, not a clock read.
 *
 * `offsetMinutes` follows the `Date.prototype.getTimezoneOffset()` convention:
 * MINUTES TO ADD TO LOCAL TIME TO GET UTC, so IST (UTC+5:30) is -330. That is
 * the convention the extractor reads, and inverting it here rather than there
 * would put the conversion two files away from the measurement.
 *
 * Returns null for anything that is not this exact rendered shape, which the
 * caller reports as unavailable rather than guessing at a date.
 */
export function parseRenderedTimestamp(
  rendered: string,
  offsetMinutes: number
): string | null {
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})[ ,]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(
    squash(rendered)
  );
  if (match === null) return null;
  if (!Number.isFinite(offsetMinutes)) return null;

  const month = MONTHS.indexOf(match[2].toLowerCase());
  if (month < 0) return null;

  const day = Number(match[1]);
  const year = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);

  if (hour > 23 || minute > 59 || second > 59 || day < 1 || day > 31) return null;

  // The rendered fields read as if they were UTC, then shifted by the offset
  // that produced them.
  const asUtc = Date.UTC(year, month, day, hour, minute, second);
  const instant = new Date(asUtc + offsetMinutes * 60_000);

  if (Number.isNaN(instant.getTime())) return null;

  // Date.UTC rolls impossible dates over (31-Feb becomes 3-Mar). A rolled date
  // is a parse failure, not a reading: the day component is checked back to
  // reject it rather than report a date the portal never showed.
  if (new Date(asUtc).getUTCDate() !== day) return null;

  return instant.toISOString();
}

/**
 * The canonical form of a vehicle identifier, for MATCHING only.
 *
 * Whitespace collapsed and upper-cased, so a user typing a stray space or lower
 * case still reaches their vehicle. Applied to both sides of every comparison,
 * so it can never make two different identifiers equal — only two spellings of
 * one identifier. What is REPORTED is always the portal's own rendering, never
 * this form (see `identity.portalLabel`).
 */
export function normalizeVehicleNo(target: string): string {
  return squash(target).toUpperCase();
}

/* -------------------------------------------------------------------------- */
/*  Fleet Overview                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The Fleet Overview catalogue, VERIFIED against the live dashboard on
 * 2026-08-02 (Milestone 4B verification step 1).
 *
 * These twelve are the status counts the portal's own header renders, in the
 * order it renders them, and the catalogue is fixed rather than discovered per
 * call: a card the portal stops rendering must come back as `available: false`
 * with a reason, not as a shorter array that reads like "nothing to report".
 *
 * Deliberately NOT in this catalogue: the SoC and cell/battery temperature
 * distribution buckets rendered further down the same page. They are battery
 * and health analytics, which SAD §11 assigns to the Battery Analytics and
 * Health & Analytics modules — a different capability, not a bigger Fleet
 * Overview.
 */
export const FLEET_OVERVIEW_METRICS = [
  "total_vehicles",
  "running",
  "stopped",
  "immobilized",
  "non_communicating",
  "device_pullout",
  "immobilizer_pullout",
  "mil",
  "rectification_required",
  "panic_button",
  "no_gps_fix",
  "location_never_received",
] as const;

export type FleetOverviewMetricKey = (typeof FLEET_OVERVIEW_METRICS)[number];

/**
 * The label each metric carries on the dashboard, lower-cased for matching.
 *
 * Matching by LABEL rather than by position is the deliberate choice: the
 * portal renders these as an ordered row, and an index-based reader silently
 * reassigns every metric the day a card is inserted. A label that stops
 * matching produces one honest `available: false`, which is a visible,
 * localised failure instead of a plausible wrong number.
 */
const METRIC_LABELS: Record<FleetOverviewMetricKey, string> = {
  total_vehicles: "all vehicles",
  running: "running",
  stopped: "stopped",
  immobilized: "immobilized",
  non_communicating: "non communicating",
  device_pullout: "device pullout",
  immobilizer_pullout: "immob pullout",
  mil: "mil",
  rectification_required: "rectification required",
  panic_button: "panic button",
  no_gps_fix: "no gps fix",
  location_never_received: "location never received",
};

/** Human-readable name carried through to the answer, per metric. */
const METRIC_TITLES: Record<FleetOverviewMetricKey, string> = {
  total_vehicles: "All Vehicles",
  running: "Running",
  stopped: "Stopped",
  immobilized: "Immobilized",
  non_communicating: "Non Communicating",
  device_pullout: "Device Pullout",
  immobilizer_pullout: "Immobilizer Pullout",
  mil: "MIL",
  rectification_required: "Rectification Required",
  panic_button: "Panic Button",
  no_gps_fix: "No GPS Fix",
  location_never_received: "Location Never Received",
};

/**
 * What the Fleet Overview extractor hands over: rendered text, unparsed.
 *
 * Strings on purpose. The extractor's job ends at "this is what the page said";
 * deciding whether "1,204" is a number is parsing, and parsing lives here where
 * it can be tested without a browser.
 */
export interface FleetOverviewRaw {
  /**
   * When the extraction ran, ISO 8601. Stamped by the extractor rather than
   * computed here — reading a clock is exactly the impurity this module is
   * defined by not having.
   */
  capturedAt: string;
  /** The fleet/group label the portal displayed, if it displayed one. */
  fleet: string | null;
  /** One entry per status card, in render order. */
  items: { label: string; count: string }[];
}

const metricSchema = z.discriminatedUnion("available", [
  z.object({
    key: z.enum(FLEET_OVERVIEW_METRICS),
    label: z.string().min(1),
    available: z.literal(true),
    value: z.number().int().nonnegative(),
    unit: z.string().min(1).nullable(),
  }),
  z.object({
    key: z.enum(FLEET_OVERVIEW_METRICS),
    label: z.string().min(1),
    available: z.literal(false),
    /** Safe to show a user, and safe to hand the model. */
    reason: z.string().min(1),
  }),
]);

/**
 * The validated Fleet Overview payload.
 *
 * `.length()` is the load-bearing constraint: the catalogue is fixed, so every
 * key is ALWAYS present. A dashboard that stops rendering a card produces
 * twelve entries with one unavailable and a reason — visible in the answer and
 * in the logs — rather than a silently shorter array.
 *
 * Strict about shape and types, permissive about presence. A changed structure
 * still fails loudly as MALFORMED_DATA; a missing card does not.
 */
export const fleetOverviewSchema = z.object({
  /**
   * The fleet these numbers describe, as the portal labels it.
   *
   * Null means the account-wide view — which is what this deployment's Fleet
   * Overview renders, since the portal shows no per-fleet label there. The
   * field exists so a group-scoped view reports its scope in the data rather
   * than leaving the model to assume one.
   */
  fleet: z.string().min(1).nullable(),
  capturedAt: z.iso.datetime(),
  metrics: z.array(metricSchema).length(FLEET_OVERVIEW_METRICS.length),
});

export type FleetOverview = z.output<typeof fleetOverviewSchema>;

/**
 * Turn a raw Fleet Overview extraction into the validated shape.
 *
 * Pure: same input, same output, no clock and no I/O. Exercisable against
 * fixtures/fleet-overview.raw.json without a portal.
 */
export function normalizeFleetOverview(raw: FleetOverviewRaw): unknown {
  // Built once, so a page rendering an unexpected extra card costs one lookup
  // rather than a scan per metric.
  const byLabel = new Map(
    raw.items.map((item) => [squash(item.label).toLowerCase(), item.count])
  );

  const metrics = FLEET_OVERVIEW_METRICS.map((key) => {
    const label = METRIC_TITLES[key];
    const rendered = byLabel.get(METRIC_LABELS[key]);

    if (rendered === undefined) {
      return {
        key,
        label,
        available: false,
        reason: `The Intellicar dashboard did not show a "${label}" count.`,
      };
    }

    const value = parseCount(rendered);

    if (value === null) {
      return {
        key,
        label,
        available: false,
        reason: `The Intellicar dashboard showed no usable number for "${label}".`,
      };
    }

    return { key, label, available: true, value, unit: null };
  });

  return { fleet: raw.fleet, capturedAt: raw.capturedAt, metrics };
}

/* -------------------------------------------------------------------------- */
/*  Vehicle Summary                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The Vehicle Summary catalogue, VERIFIED against the live dashboard's Table
 * View on 2026-08-03 (Milestone 4C discovery).
 *
 * These are the portal's own table columns, in the order it renders them:
 *
 *   Vehicle No | Device No | Ignition | Model | Variant | Last Talk Time |
 *   Speed | Fuel | Address
 *
 * Three deliberate departures from that list (SAD §19, Milestone 4C):
 *
 *   - VEHICLE NO is not a field. It is the identity of the whole payload and is
 *     carried in `identity`, where it is compared against the request. Repeating
 *     it here would give one fact two homes in the same object.
 *   - IGNITION is excluded. The cell holds no text at all — the state is an icon
 *     whose value lives in a CSS modifier (`fa-power-off -grey`), and only one
 *     value of that vocabulary was observed across all 320 vehicles. Reporting it
 *     would mean guessing at an encoding.
 *   - FUEL keeps the portal's own name. This is an EV fleet and the column reads
 *     0-100, but §19 assigns state of charge to `can_telemetry` as its single
 *     authoritative feed; quietly relabelling a portal column would put two
 *     different quantities behind one word in the same answer.
 *
 * Fixed rather than discovered per call, exactly as FLEET_OVERVIEW_METRICS is: a
 * column the portal stops rendering must come back as `available: false` with a
 * reason, not as a shorter array that reads like "nothing to report".
 */
export const VEHICLE_SUMMARY_FIELDS = [
  "device_no",
  "model",
  "variant",
  "last_talk_time",
  "speed",
  "fuel",
  "location",
] as const;

export type VehicleSummaryFieldKey = (typeof VEHICLE_SUMMARY_FIELDS)[number];

/**
 * How each field is read out of the row, matched by the COLUMN HEADER the
 * portal renders — never by column index.
 *
 * Same reasoning as the Fleet Overview catalogue: the table renders an ordered
 * row, and an index-based reader silently reassigns every field the day a column
 * is inserted. A header that stops matching produces one honest
 * `available: false`.
 *
 * `unit` is the unit the value is REPORTED in, and is stated here rather than
 * parsed from the cell because the cells carry bare numbers. Speed is km/h — the
 * dashboard's own dial panel labels the same quantity "Kmph" — and Fuel is a
 * percentage, which is what a 0-100 column against this portal's SOC filters
 * means. Neither unit is invented from the value's range alone.
 */
const VEHICLE_FIELD_SPECS: Record<
  VehicleSummaryFieldKey,
  {
    /** The column header, lower-cased for matching. */
    header: string;
    /** Human-readable name carried through to the answer. */
    label: string;
    /** How the cell text is interpreted. */
    kind: "text" | "number" | "timestamp" | "position";
    unit: string | null;
  }
> = {
  device_no: { header: "device no", label: "Device No", kind: "text", unit: null },
  model: { header: "model", label: "Model", kind: "text", unit: null },
  variant: { header: "variant", label: "Variant", kind: "text", unit: null },
  last_talk_time: {
    header: "last talk time",
    label: "Last Talk Time",
    kind: "timestamp",
    unit: null,
  },
  speed: { header: "speed", label: "Speed", kind: "number", unit: "km/h" },
  fuel: { header: "fuel", label: "Fuel", kind: "number", unit: "%" },
  location: { header: "address", label: "Location", kind: "position", unit: null },
};

/**
 * What the Vehicle Summary extractor hands over: rendered text, unparsed.
 *
 * Strings on purpose, as everywhere in this file. The one non-string is
 * `renderOffsetMinutes`, which is a MEASUREMENT the extractor takes from the
 * page rather than a parse — see `parseRenderedTimestamp`.
 */
export interface VehicleSummaryRaw {
  /** When the extraction ran, ISO 8601. Stamped by the extractor. */
  capturedAt: string;
  /** The identifier the caller asked for, canonicalised for matching. */
  requested: string;
  /** The Vehicle No cell exactly as the portal rendered it. */
  portalLabel: string;
  /** The fleet/group label the portal displayed, if it displayed one. */
  fleet: string | null;
  /**
   * `Date.prototype.getTimezoneOffset()` as read INSIDE the page: minutes to add
   * to local time to reach UTC. The zone that formatted "Last Talk Time".
   */
  renderOffsetMinutes: number;
  /** The table's column headers, in render order. */
  headers: string[];
  /** The matched row's cells, in the same order as `headers`. */
  cells: string[];
}

/**
 * A field's value, tagged by shape.
 *
 * A vehicle summary is genuinely heterogeneous — an identifier, a speed, an
 * instant, a position — and a bare `string | number` would leave the model to
 * infer whether "100" is a percentage or a name. The tag makes the shape part of
 * the data instead of part of the guess.
 */
const vehicleValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: z.string().min(1) }),
  z.object({ kind: z.literal("number"), number: z.number() }),
  z.object({
    kind: z.literal("timestamp"),
    /** The instant, derived from `rendered` and the page's offset. */
    iso: z.iso.datetime(),
    /** Exactly what the portal displayed. Always carried, never derived. */
    rendered: z.string().min(1),
    /** How `iso` was arrived at, so the derivation is never implicit. */
    basis: z.literal("browser_timezone_offset"),
    offsetMinutes: z.number().int(),
  }),
  z.object({
    kind: z.literal("coordinates"),
    lat: z.number().min(-90).max(90),
    lon: z.number().min(-180).max(180),
  }),
]);

const vehicleFieldSchema = z.discriminatedUnion("available", [
  z.object({
    key: z.enum(VEHICLE_SUMMARY_FIELDS),
    label: z.string().min(1),
    available: z.literal(true),
    value: vehicleValueSchema,
    unit: z.string().min(1).nullable(),
  }),
  z.object({
    key: z.enum(VEHICLE_SUMMARY_FIELDS),
    label: z.string().min(1),
    available: z.literal(false),
    /** Safe to show a user, and safe to hand the model. */
    reason: z.string().min(1),
  }),
]);

/**
 * The validated Vehicle Summary payload.
 *
 * `identity.matched` is `z.literal(true)` deliberately: a vehicle that could not
 * be proven to be the requested one never produces data at all — the Portal
 * Service raises TARGET_NOT_FOUND — so a mismatch is not merely absent from this
 * type, it is unrepresentable in it.
 *
 * `.length()` on `fields` is the same load-bearing constraint the Fleet Overview
 * schema uses, and for the same reason.
 */
export const vehicleSummarySchema = z.object({
  identity: z.object({
    /** What the caller asked for, canonicalised. */
    requested: z.string().min(1),
    /** What the portal rendered, verbatim. */
    portalLabel: z.string().min(1),
    matched: z.literal(true),
  }),
  fleet: z.string().min(1).nullable(),
  capturedAt: z.iso.datetime(),
  fields: z.array(vehicleFieldSchema).length(VEHICLE_SUMMARY_FIELDS.length),
});

export type VehicleSummary = z.output<typeof vehicleSummarySchema>;

/**
 * Turn a raw Vehicle Summary extraction into the validated shape.
 *
 * Pure: same input, same output, no clock and no I/O. Exercisable against
 * fixtures/vehicle-summary.raw.json without a portal.
 */
export function normalizeVehicleSummary(raw: VehicleSummaryRaw): unknown {
  // Header -> cell, built once. Matching by header is what keeps an inserted
  // column from silently reassigning every field.
  const byHeader = new Map<string, string>();
  raw.headers.forEach((header, index) => {
    const key = squash(header).toLowerCase();
    if (key.length > 0 && !byHeader.has(key)) {
      byHeader.set(key, raw.cells[index] ?? "");
    }
  });

  const fields = VEHICLE_SUMMARY_FIELDS.map((key) => {
    const spec = VEHICLE_FIELD_SPECS[key];
    const label = spec.label;
    const unavailable = (reason: string) => ({ key, label, available: false, reason });

    const rendered = byHeader.get(spec.header);

    if (rendered === undefined) {
      return unavailable(
        `The Intellicar dashboard did not show a "${label}" column for this vehicle.`
      );
    }

    const text = squash(rendered);

    if (text.length === 0) {
      return unavailable(
        `The Intellicar dashboard showed no "${label}" value for this vehicle.`
      );
    }

    switch (spec.kind) {
      case "text":
        return {
          key,
          label,
          available: true,
          value: { kind: "text", text },
          unit: spec.unit,
        };

      case "number": {
        const number = parseDecimal(text);
        return number === null
          ? unavailable(
              `The Intellicar dashboard showed no usable number for "${label}".`
            )
          : {
              key,
              label,
              available: true,
              value: { kind: "number", number },
              unit: spec.unit,
            };
      }

      case "timestamp": {
        const iso = parseRenderedTimestamp(text, raw.renderOffsetMinutes);
        return iso === null
          ? unavailable(
              `The Intellicar dashboard showed "${label}" in a format this ` +
                `system does not recognise.`
            )
          : {
              key,
              label,
              available: true,
              value: {
                kind: "timestamp",
                iso,
                rendered: text,
                basis: "browser_timezone_offset",
                offsetMinutes: raw.renderOffsetMinutes,
              },
              unit: spec.unit,
            };
      }

      case "position": {
        // This deployment renders coordinates in the Address column. A cell that
        // genuinely holds a street address is reported as the text it is,
        // rather than failing — both are true answers to "where is it".
        const coordinates = parseCoordinates(text);
        return coordinates === null
          ? {
              key,
              label,
              available: true,
              value: { kind: "text", text },
              unit: spec.unit,
            }
          : {
              key,
              label,
              available: true,
              value: { kind: "coordinates", ...coordinates },
              unit: spec.unit,
            };
      }
    }
  });

  return {
    identity: {
      requested: raw.requested,
      portalLabel: raw.portalLabel,
      matched: true,
    },
    fleet: raw.fleet,
    capturedAt: raw.capturedAt,
    fields,
  };
}
