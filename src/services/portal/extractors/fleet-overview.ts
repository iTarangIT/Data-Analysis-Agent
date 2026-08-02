import { defineCapability, type Extractor } from "../portal.service";
import {
  fleetOverviewSchema,
  normalizeFleetOverview,
  type FleetOverviewRaw,
} from "../normalizers";

/**
 * Fleet Overview extractor (SAD §11 — Milestone 4B).
 *
 * The first live Portal capability, and the one that proves the whole pipeline:
 * Portal Tool → Portal Service → Session Manager → Playwright → this extractor →
 * normalizer → Zod → ToolEnvelope.
 *
 * ## What this file may do, and what it may not
 *
 * It READS a page it is handed. It does not navigate — the Portal Service owns
 * `goto` and the readiness wait, from the constants declared below — and it does
 * not click, fill, or change anything on the customer's dashboard. Tarang is an
 * analyst; a scrape that mutates the thing it is measuring is a defect class
 * this codebase does not intend to have.
 *
 * It also does no parsing. Everything below hands over rendered TEXT; deciding
 * what "1,204" means is the normalizer's job, where it is testable without a
 * browser (see fixtures/fleet-overview.raw.json).
 *
 * ## Why the selectors live here and not in authenticator.ts
 *
 * The Session Manager owns signing in; the Portal Service owns extraction; each
 * owns the portal knowledge its job needs (SAD §19, Milestone 4A). Putting
 * dashboard selectors in the authenticator would mean editing the module that
 * signs in to fix a scrape — and reaching past session-manager.ts, which SAD §8
 * makes that module's only public entry point.
 */

/* -------------------------------------------------------------------------- */
/*  FLEET OVERVIEW CONSTANTS — this module's portal knowledge, and nowhere else */
/* -------------------------------------------------------------------------- */

/**
 * VERIFIED against the live portal on 2026-08-02 (docs/AUTH-SETUP.md §4
 * procedure, applied to a dashboard module). Unlike the Milestone 3 login
 * placeholders, none of these is a guess — each was read off the rendered DOM.
 *
 * The rendered structure this depends on:
 *
 *   <div class="Header">
 *     <div class="h-controls">
 *       <div class="active hc-item">
 *         <span class="hc-classIcon …"/>
 *         <div class="hci-name">All Vehicles</div>
 *         <div class="hci-count">320</div>
 *         <div class="hci-dummy"/>
 *       </div>
 *       … eleven more …
 */
const FLEET_OVERVIEW = {
  /**
   * The Fleet Overview IS the portal's landing view: a live map with the fleet
   * status row across its header. There is no separate route to navigate to.
   */
  PATH: "/",

  /**
   * Readiness, raced candidate by candidate.
   *
   * Every candidate targets a COUNT element rather than a container, because
   * this portal is a client-rendered SPA: the shell, the header and the empty
   * card row all exist long before the numbers arrive, so waiting for a
   * container would reliably extract a dashboard that has not loaded yet.
   *
   * Ordered most- to least-specific. Candidates are raced separately rather
   * than joined into one CSS union, so any Playwright selector engine works and
   * one bad entry costs only itself.
   */
  READY: [
    ".Header .h-controls .hc-item .hci-count",
    ".h-controls .hci-count",
    "div.hc-item div.hci-count",
  ],

  /** One status card. Twelve are rendered. */
  ITEM: ".h-controls .hc-item",
  /** The card's label, e.g. "Non Communicating". */
  ITEM_NAME: ".hci-name",
  /** The card's count, e.g. "320". */
  ITEM_COUNT: ".hci-count",
} as const;

/* -------------------------------------------------------------------------- */
/*  Extraction                                                                */
/* -------------------------------------------------------------------------- */

const extractFleetOverview: Extractor<FleetOverviewRaw> = async (page) => {
  /**
   * One round trip for all twelve cards, and a read-only one: `evaluateAll`
   * runs `querySelector`/`textContent` in the page and returns plain data. The
   * selectors are passed in as an argument because the callback executes in the
   * browser, where this module's scope does not exist.
   */
  const items = await page.locator(FLEET_OVERVIEW.ITEM).evaluateAll(
    (nodes, selectors) =>
      nodes.map((node) => ({
        label: node.querySelector(selectors.name)?.textContent ?? "",
        count: node.querySelector(selectors.count)?.textContent ?? "",
      })),
    { name: FLEET_OVERVIEW.ITEM_NAME, count: FLEET_OVERVIEW.ITEM_COUNT }
  );

  return {
    // Stamped here rather than in the normalizer, which may not read a clock.
    // It is the time of the READING, not a claim the portal made — the portal
    // publishes no "as of" timestamp on this view.
    capturedAt: new Date().toISOString(),

    /**
     * Null: this view renders the whole account and shows no fleet or group
     * label alongside the counts. Reported rather than invented — a fabricated
     * scope would let the model attribute account-wide numbers to one fleet.
     */
    fleet: null,

    items,
  };
};

export const fleetOverviewCapability = defineCapability({
  module: "fleet_overview",
  path: FLEET_OVERVIEW.PATH,
  readySelector: FLEET_OVERVIEW.READY,
  extract: extractFleetOverview,
  normalize: normalizeFleetOverview,
  schema: fleetOverviewSchema,
});
