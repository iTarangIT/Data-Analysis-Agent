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
