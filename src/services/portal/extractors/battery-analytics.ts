import { defineCapability, type Extractor } from "../portal.service";
import {
  batteryAnalyticsSchema,
  normalizeBatteryAnalytics,
  type BatteryAnalyticsRaw,
} from "../normalizers";

/**
 * Battery Analytics extractor (SAD §11 — Milestone 4D).
 *
 * An ACCOUNT-WIDE capability, structurally the same shape as Fleet Overview: it
 * navigates nowhere, reaches for no entity, and reads three fleet distributions
 * off the landing view. It declares no `resolve` and no `assertIdentity` because
 * there is no target — `defineCapability`'s untargeted arm is the whole contract.
 *
 * ## Why account-wide, when the milestone began as a per-vehicle readout
 *
 * Milestone 4D was proposed as targeted Battery Telemetry. Live discovery found
 * the portal has no per-vehicle battery view at all (recorded in full on
 * BATTERY_ANALYTICS_DISTRIBUTIONS in ../normalizers): no LeftPane control opens
 * one, selecting a vehicle opens no battery panel and leaves the URL unchanged,
 * and the "Start SOC" / "End SOC" figures belong to a trip-playback control that
 * does not track the selected vehicle. What the portal renders live is these
 * three fleet-wide distributions — the buckets Milestone 4B set aside for this
 * module — so the milestone was amended to build the module SAD §11 named.
 *
 * ## What this file may do, and what it may not
 *
 * It READS a page it is handed. The Portal Service owns `goto` and the readiness
 * wait, from the constants below. Nothing here clicks, fills, filters or changes
 * anything on the customer's dashboard — this capability does not even need the
 * Table View, so it touches no control at all.
 *
 * It also does no parsing. Everything below hands over rendered TEXT; deciding
 * what "30-45°C" and "304" mean is the normalizer's job, where it is testable
 * without a browser (see fixtures/battery-analytics.raw.json).
 */

/* -------------------------------------------------------------------------- */
/*  BATTERY ANALYTICS CONSTANTS — this module's portal knowledge, and nowhere else */
/* -------------------------------------------------------------------------- */

/**
 * VERIFIED against the live portal on 2026-08-03 (docs/AUTH-SETUP.md §4
 * procedure, applied to a dashboard module). Each value was read off the
 * rendered DOM.
 *
 * The rendered structure this depends on — three sibling rows, one per
 * distribution, each titled by its own `.bucket-name`:
 *
 *   <div class="newSocSwitch">
 *     <div class="bucket-name"><span>SoC</span></div>
 *     <div class="switchbtn"><div style="color: …">No SoC</div><div>0</div></div>
 *     <div class="switchbtn"><div style="color: …">&lt;0%</div><div>0</div></div>
 *     … five more …
 *   <div class="newTempSwitch">
 *     <div class="bucket-name"><span>Battery Temp</span></div>
 *     <div class="switchbtn"><div style="color: …">No Temp</div><div>0</div></div>
 *     … six more …
 *   <div class="newswitch">
 *     <div class="bucket-name"><span>Cell Temp</span></div>
 *     … seven …
 */
const BATTERY_ANALYTICS = {
  /**
   * The distributions render on the portal's landing view, below the fleet
   * status counts — the same page Fleet Overview reads. There is no separate
   * Battery route to navigate to; discovery confirmed none exists.
   */
  PATH: "/",

  /**
   * Readiness, raced candidate by candidate.
   *
   * The first two candidates target a BAND — a rendered count — rather than a
   * container, because this portal is a client-rendered SPA whose shell exists
   * long before its numbers. `.bucket-name` is last and least specific: it
   * proves the rows are on the page, which is the weakest of the three signals
   * and is kept only so one renamed container class cannot fail the module.
   *
   * Candidates are raced separately rather than joined into one CSS union, so
   * any Playwright selector engine works and one bad entry costs only itself.
   */
  READY: [
    ".newSocSwitch .switchbtn",
    ".newTempSwitch .switchbtn",
    ".bucket-name",
  ],

  /**
   * The title of one distribution row. This is the anchor for the whole
   * extraction: rows are found by their RENDERED TITLE, and the container is
   * reached upward from it, so the three container classes — one of which is
   * the generic `newswitch` — never have to be named here.
   */
  ROW_NAME: ".bucket-name",

  /** One band within a row: a coloured label div followed by a count div. */
  BUCKET: ".switchbtn",
} as const;

/* -------------------------------------------------------------------------- */
/*  Extraction                                                                */
/* -------------------------------------------------------------------------- */

const extractBatteryAnalytics: Extractor<BatteryAnalyticsRaw> = async (page) => {
  /**
   * One round trip for all three rows, and a read-only one: `evaluateAll` runs
   * `querySelectorAll`/`textContent` in the page and returns plain data. The
   * selector is passed in as an argument because the callback executes in the
   * browser, where this module's scope does not exist.
   *
   * The row container is reached as the title's PARENT rather than by a class,
   * so a renamed container costs nothing as long as the portal still titles its
   * rows. The two band cells are read positionally WITHIN one band — label then
   * count — which is the portal's own two-child structure and not a position in
   * a list of rows; which band it is comes from its label, in the normalizer.
   */
  const rows = await page.locator(BATTERY_ANALYTICS.ROW_NAME).evaluateAll(
    (nodes, selectors) =>
      nodes.map((node) => {
        const container = node.parentElement;
        const cells = container?.querySelectorAll(selectors.bucket) ?? [];

        return {
          name: node.textContent ?? "",
          buckets: [...cells].map((cell) => ({
            label: cell.children[0]?.textContent ?? "",
            count: cell.children[1]?.textContent ?? "",
          })),
        };
      }),
    { bucket: BATTERY_ANALYTICS.BUCKET }
  );

  return {
    // Stamped here rather than in the normalizer, which may not read a clock.
    // It is the time of the READING, not a claim the portal made — the portal
    // publishes no "as of" timestamp on these rows.
    capturedAt: new Date().toISOString(),

    /**
     * Null: these rows describe the whole account and the view shows no fleet
     * or group label alongside them. Reported rather than invented — a
     * fabricated scope would let the model attribute account-wide distributions
     * to one fleet.
     */
    fleet: null,

    rows,
  };
};

export const batteryAnalyticsCapability = defineCapability({
  module: "battery_analytics",
  path: BATTERY_ANALYTICS.PATH,
  readySelector: BATTERY_ANALYTICS.READY,
  extract: extractBatteryAnalytics,
  normalize: normalizeBatteryAnalytics,
  schema: batteryAnalyticsSchema,
});
