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
 * The files under fixtures/ are real captures from the live dashboard, and they
 * are what makes that claim true rather than aspirational: every normalizer
 * below can be run against one with no browser, no session and no network.
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

/**
 * The instant range a rendered epoch is allowed to fall in.
 *
 * The guard that makes `parseEpochMillis` unambiguous rather than merely
 * permissive: epoch SECONDS for the same moment is a ten-digit number, and
 * reading one as milliseconds would silently place a 2026 reading in 1970. A
 * seconds value fails both the digit-count test and this range, so the two
 * encodings cannot be confused.
 */
const EPOCH_MS_FLOOR = Date.UTC(2000, 0, 1);
const EPOCH_MS_CEILING = Date.UTC(2100, 0, 1);

/**
 * Read a timestamp the portal rendered as raw epoch MILLISECONDS.
 *
 * ## Why this exists (Milestone 5D-1 discovery)
 *
 * The Table View renders "Last Talk Time" in TWO forms, and which one you get
 * depends on when you look. Measured against the live dashboard on 2026-08-03,
 * across all 320 rows in one pass: 200 rows carried a bare epoch such as
 * `1785744365673`, and 120 carried the formatted `03-Aug-2026 13:53`. The split
 * fell exactly on the pager boundary — the page read first was raw, the page
 * read last was formatted — because this React table formats its timestamps
 * client-side AFTER the row renders. The same vehicle was observed unparseable
 * on a cold read and parseable on a warm one, which is the same finding from the
 * other direction.
 *
 * Before this, a raw row produced `available: false` with "in a format this
 * system does not recognise" — a true statement about the parser and a false
 * impression about the portal, which had in fact reported the time perfectly
 * well. Roughly three fifths of reads were affected.
 *
 * ## Why this is a separate function, not a branch inside parseRenderedTimestamp
 *
 * They parse different things. `parseRenderedTimestamp` turns a WALL CLOCK with
 * no zone into an instant by applying the offset that produced it. An epoch is
 * already an instant: it needs no offset, cannot be misread by a browser in the
 * wrong timezone, and is strictly better evidence. Folding it into the other
 * function would give that function two contracts and force a meaningless offset
 * on a value that has none — which is why the payload records WHICH of the two
 * produced a value (see `basis`) rather than hiding the difference.
 *
 * Returns null for anything that is not a plausible epoch, which the caller then
 * tries to read as a rendered wall clock instead.
 */
export function parseEpochMillis(rendered: string): string | null {
  const text = squash(rendered);

  // Twelve digits is year 2001; fourteen is far beyond the ceiling below. Ten
  // digits — epoch seconds — is deliberately outside this range.
  if (!/^\d{12,14}$/.test(text)) return null;

  const value = Number(text);
  if (!Number.isSafeInteger(value)) return null;
  if (value < EPOCH_MS_FLOOR || value >= EPOCH_MS_CEILING) return null;

  const instant = new Date(value);
  return Number.isNaN(instant.getTime()) ? null : instant.toISOString();
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
    /** The instant, derived from `rendered` as `basis` describes. */
    iso: z.iso.datetime(),
    /** Exactly what the portal displayed. Always carried, never derived. */
    rendered: z.string().min(1),
    /**
     * How `iso` was arrived at, so the derivation is never implicit.
     *
     * TWO forms, because the portal renders two (Milestone 5D-1 discovery —
     * see `parseEpochMillis`). They are not interchangeable and the difference
     * is worth carrying: `epoch_milliseconds` is an absolute instant that needed
     * no interpretation, while `browser_timezone_offset` is a wall clock read
     * through the scraping browser's zone and is therefore only as correct as
     * that zone. A consumer weighing how much to trust an instant can tell them
     * apart; one that does not care reads `iso` and ignores this.
     */
    basis: z.enum(["epoch_milliseconds", "browser_timezone_offset"]),
    /**
     * The offset applied, or null when none was — an epoch carries its own zone.
     *
     * Nullable rather than optional so the epoch case must be stated rather than
     * left out, and so a reader cannot mistake "no offset was needed" for "the
     * offset was forgotten".
     */
    offsetMinutes: z.number().int().nullable(),
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
        // Epoch FIRST, because it is unambiguous and needs no offset: a value
        // that parses here is an instant the portal stated outright, rather than
        // one inferred through the scraping browser's timezone. The wall-clock
        // reader is the fallback for rows the portal has already formatted.
        const epoch = parseEpochMillis(text);

        if (epoch !== null) {
          return {
            key,
            label,
            available: true,
            value: {
              kind: "timestamp",
              iso: epoch,
              rendered: text,
              basis: "epoch_milliseconds",
              offsetMinutes: null,
            },
            unit: spec.unit,
          };
        }

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

/* -------------------------------------------------------------------------- */
/*  Battery Analytics                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The Battery Analytics catalogue, VERIFIED against the live dashboard on
 * 2026-08-03 (Milestone 4D discovery).
 *
 * ## Why this module is account-wide, and what discovery actually found
 *
 * Milestone 4D was proposed as a TARGETED per-vehicle battery readout. Discovery
 * against the live portal found no such view, and the milestone was amended:
 *
 *   - None of the sixteen LeftPane controls opens a battery view.
 *   - Selecting a vehicle leaves the URL unchanged and opens no battery panel;
 *     the RightPane dial set is ICE-oriented (Speed, RPM, Engine Temp, Fuel
 *     Level) and renders no battery quantity at all.
 *   - The `.InGraphControl` panel that carries "Start SOC" / "End SOC" is a TRIP
 *     PLAYBACK control, not a live readout: it was byte-identical before any
 *     selection and after selecting each of two different vehicles — same device
 *     id, every value "No Data". Those two figures are trip aggregates that need
 *     a trip and a date range, which is historical work, not live telemetry.
 *
 * What the portal does render live is three FLEET-WIDE distributions, on the
 * landing view, beneath the status counts — the same buckets Milestone 4B
 * deliberately excluded from Fleet Overview and assigned to this module. So this
 * is the Battery Analytics module SAD §11 always named, and it is account-wide.
 *
 * ## Why `state_of_charge` is the portal's own word here
 *
 * Milestone 4C refused to relabel the Table View's `Fuel` column as state of
 * charge, because renaming a portal column would put two quantities behind one
 * word. This is the opposite case and the same rule: the portal itself titles
 * this row "SoC", so the name is READ rather than reinterpreted.
 *
 * These are LIVE PORTAL readings and they do NOT amend §19's authoritative-feed
 * table, which governs which of the three historical feeds answers a quantity. A
 * live fleet distribution and a historical CAN signal are different source
 * classes, kept apart by the envelope's `origin` rather than by wording.
 */
export const BATTERY_ANALYTICS_DISTRIBUTIONS = [
  "state_of_charge",
  "battery_temperature",
  "cell_temperature",
] as const;

export type BatteryDistributionKey =
  (typeof BATTERY_ANALYTICS_DISTRIBUTIONS)[number];

/**
 * Every bucket key any distribution can carry.
 *
 * The union of the two band vocabularies below. One flat enum rather than a key
 * type per distribution: the schema validates a single bucket shape, and the
 * per-distribution catalogue is what decides which keys actually appear.
 */
export const BATTERY_BUCKET_KEYS = [
  "no_reading",
  "below_0",
  "at_0",
  "1_25",
  "25_50",
  "50_75",
  "above_75",
  "1_15",
  "15_30",
  "30_45",
  "above_45",
] as const;

/** How many buckets each distribution renders. Both vocabularies carry seven. */
export const BATTERY_BUCKET_COUNT = 7;

/**
 * One band, matched by the LABEL the portal renders — never by position.
 *
 * `match` is that label squashed and lower-cased; `label` is what is carried
 * through to the answer. Matching is exact string equality, so the neighbouring
 * bands cannot collide: "0%" never matches "<0%" or ">75%".
 */
interface BatteryBucketSpec {
  key: (typeof BATTERY_BUCKET_KEYS)[number];
  match: string;
  label: string;
}

/** The SoC bands, exactly as the portal renders them. */
const SOC_BUCKETS: readonly BatteryBucketSpec[] = [
  { key: "no_reading", match: "no soc", label: "No SoC" },
  { key: "below_0", match: "<0%", label: "<0%" },
  { key: "at_0", match: "0%", label: "0%" },
  { key: "1_25", match: "1-25%", label: "1-25%" },
  { key: "25_50", match: "25-50%", label: "25-50%" },
  { key: "50_75", match: "50-75%", label: "50-75%" },
  { key: "above_75", match: ">75%", label: ">75%" },
];

/**
 * The temperature bands, shared by the Battery Temp and Cell Temp rows — the
 * portal renders the same seven for both.
 */
const TEMP_BUCKETS: readonly BatteryBucketSpec[] = [
  { key: "no_reading", match: "no temp", label: "No Temp" },
  { key: "below_0", match: "<0°c", label: "<0°C" },
  { key: "at_0", match: "0°c", label: "0°C" },
  { key: "1_15", match: "1-15°c", label: "1-15°C" },
  { key: "15_30", match: "15-30°c", label: "15-30°C" },
  { key: "30_45", match: "30-45°c", label: "30-45°C" },
  { key: "above_45", match: ">45°c", label: ">45°C" },
];

/**
 * How each distribution is found, matched by the ROW TITLE the portal renders.
 *
 * `rowName` is that title lower-cased. Matching by title rather than by the
 * container's class is deliberate: the three rows carry the classes
 * `newSocSwitch`, `newTempSwitch` and `newswitch`, and the last is generic
 * enough that a future unrelated row could take it. A title that stops matching
 * produces one honest `available: false`.
 *
 * `unit` is the unit of the BANDS, not of the counts — the counts are vehicles.
 */
const BATTERY_DISTRIBUTION_SPECS: Record<
  BatteryDistributionKey,
  {
    rowName: string;
    label: string;
    unit: string;
    buckets: readonly BatteryBucketSpec[];
  }
> = {
  state_of_charge: {
    rowName: "soc",
    label: "State of Charge",
    unit: "%",
    buckets: SOC_BUCKETS,
  },
  battery_temperature: {
    rowName: "battery temp",
    label: "Battery Temperature",
    unit: "°C",
    buckets: TEMP_BUCKETS,
  },
  cell_temperature: {
    rowName: "cell temp",
    label: "Cell Temperature",
    unit: "°C",
    buckets: TEMP_BUCKETS,
  },
};

/**
 * What the Battery Analytics extractor hands over: rendered text, unparsed.
 *
 * Strings on purpose, as everywhere in this file. The extractor's job ends at
 * "this is what the page said".
 */
export interface BatteryAnalyticsRaw {
  /** When the extraction ran, ISO 8601. Stamped by the extractor. */
  capturedAt: string;
  /** The fleet/group label the portal displayed, if it displayed one. */
  fleet: string | null;
  /** One entry per rendered distribution row, in render order. */
  rows: { name: string; buckets: { label: string; count: string }[] }[];
}

const batteryBucketSchema = z.discriminatedUnion("available", [
  z.object({
    key: z.enum(BATTERY_BUCKET_KEYS),
    label: z.string().min(1),
    available: z.literal(true),
    /** Vehicles in this band. A count, not a measurement. */
    count: z.number().int().nonnegative(),
  }),
  z.object({
    key: z.enum(BATTERY_BUCKET_KEYS),
    label: z.string().min(1),
    available: z.literal(false),
    /** Safe to show a user, and safe to hand the model. */
    reason: z.string().min(1),
  }),
]);

const batteryDistributionSchema = z.discriminatedUnion("available", [
  z.object({
    key: z.enum(BATTERY_ANALYTICS_DISTRIBUTIONS),
    label: z.string().min(1),
    available: z.literal(true),
    /** The unit of the BANDS. The bucket counts are vehicles. */
    unit: z.string().min(1),
    buckets: z.array(batteryBucketSchema).length(BATTERY_BUCKET_COUNT),
    /**
     * Vehicles across all bands, or null if any band failed to read.
     *
     * Null rather than a partial sum: a total assembled from six of seven bands
     * would look like a fleet size and be one. It is deliberately NOT assumed to
     * equal the Fleet Overview vehicle count either — on the live dashboard the
     * Battery Temp row summed to 317 while the fleet was 320, because a vehicle
     * reporting no battery temperature at all is in none of these bands.
     */
    total: z.number().int().nonnegative().nullable(),
  }),
  z.object({
    key: z.enum(BATTERY_ANALYTICS_DISTRIBUTIONS),
    label: z.string().min(1),
    available: z.literal(false),
    reason: z.string().min(1),
  }),
]);

/**
 * The validated Battery Analytics payload.
 *
 * The `.length()` constraints are the same load-bearing ones the other two
 * modules use: three distributions, seven bands each, always. A row the portal
 * stops rendering comes back as one `available: false` with a reason, never as a
 * shorter array that reads like "nothing to report".
 */
export const batteryAnalyticsSchema = z.object({
  /**
   * The fleet these distributions describe, as the portal labels it.
   *
   * Null means the account-wide view, which is what this deployment renders —
   * the same finding as Fleet Overview, and reported rather than invented.
   */
  fleet: z.string().min(1).nullable(),
  capturedAt: z.iso.datetime(),
  distributions: z
    .array(batteryDistributionSchema)
    .length(BATTERY_ANALYTICS_DISTRIBUTIONS.length),
});

export type BatteryAnalytics = z.output<typeof batteryAnalyticsSchema>;

/**
 * Turn a raw Battery Analytics extraction into the validated shape.
 *
 * Pure: same input, same output, no clock and no I/O. Exercisable against
 * fixtures/battery-analytics.raw.json without a portal.
 */
export function normalizeBatteryAnalytics(raw: BatteryAnalyticsRaw): unknown {
  // Row title -> its bands, built once. A page rendering an unexpected extra
  // row costs one lookup rather than a scan per distribution.
  const byRowName = new Map<string, { label: string; count: string }[]>();
  for (const row of raw.rows) {
    const key = squash(row.name).toLowerCase();
    if (key.length > 0 && !byRowName.has(key)) byRowName.set(key, row.buckets);
  }

  const distributions = BATTERY_ANALYTICS_DISTRIBUTIONS.map((key) => {
    const spec = BATTERY_DISTRIBUTION_SPECS[key];
    const label = spec.label;
    const rendered = byRowName.get(spec.rowName);

    if (rendered === undefined) {
      return {
        key,
        label,
        available: false,
        reason: `The Intellicar dashboard did not show a "${label}" distribution.`,
      };
    }

    const byLabel = new Map<string, string>();
    for (const bucket of rendered) {
      const bandKey = squash(bucket.label).toLowerCase();
      if (bandKey.length > 0 && !byLabel.has(bandKey)) {
        byLabel.set(bandKey, bucket.count);
      }
    }

    // Tracked while mapping so a partial read can never be totalled: one
    // unreadable band makes the whole total null rather than plausibly small.
    let complete = true;
    let total = 0;

    const buckets = spec.buckets.map((bucket) => {
      const text = byLabel.get(bucket.match);

      if (text === undefined) {
        complete = false;
        return {
          key: bucket.key,
          label: bucket.label,
          available: false,
          reason:
            `The Intellicar dashboard did not show a "${bucket.label}" band ` +
            `for "${label}".`,
        };
      }

      const count = parseCount(text);

      if (count === null) {
        complete = false;
        return {
          key: bucket.key,
          label: bucket.label,
          available: false,
          reason:
            `The Intellicar dashboard showed no usable number for the ` +
            `"${bucket.label}" band of "${label}".`,
        };
      }

      total += count;
      return { key: bucket.key, label: bucket.label, available: true, count };
    });

    return {
      key,
      label,
      available: true,
      unit: spec.unit,
      buckets,
      total: complete ? total : null,
    };
  });

  return { fleet: raw.fleet, capturedAt: raw.capturedAt, distributions };
}
