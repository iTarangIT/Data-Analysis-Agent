import type { Page } from "playwright";

import {
  PortalError,
  defineCapability,
  waitForAnySelector,
  type Extractor,
  type IdentityAssertion,
  type Resolver,
} from "../portal.service";
import {
  normalizeVehicleNo,
  normalizeVehicleSummary,
  vehicleSummarySchema,
  type VehicleSummaryRaw,
} from "../normalizers";

/**
 * Vehicle Summary extractor (SAD §11 — Milestone 4C).
 *
 * The first TARGETED capability: it reports one vehicle named by the request,
 * where Fleet Overview reports a whole account. That difference is the whole of
 * this milestone, because the portal exposes no per-vehicle route — selecting a
 * vehicle leaves the URL at `/` unchanged — so the vehicle has to be reached
 * in-page before anything can be read.
 *
 * ## What this file may do, and what it may not
 *
 * `resolve` NAVIGATES: it opens the dashboard's Table View and pages the table
 * until the requested vehicle's row is showing. `extract` READS that row and
 * nothing else. The rule both obey is NEVER MUTATE (SAD §19, Milestone 4C):
 * opening a view and paging a table change what this session is looking at,
 * never the customer's data. Nothing here submits a form, saves a setting or
 * issues a device command — the Device Settings, Command History and Update
 * Location controls on this dashboard are deliberately untouched.
 *
 * Parsing is still the normalizer's job. Everything below hands over rendered
 * TEXT; deciding what "03-Aug-2026 03:13" means happens where it is testable
 * without a browser (see fixtures/vehicle-summary.raw.json).
 *
 * ## Why the row is found by scanning and not by searching
 *
 * The dashboard has two search boxes and BOTH were measured unusable for
 * identifying one vehicle (SAD §19, Milestone 4C):
 *
 *   - `#headersearch` filters the map and the header counts — an absent vehicle
 *     correctly drives All Vehicles to 0 — but leaves the table showing all 200
 *     rows of the current page.
 *   - The table's own search box is a loose token match. Every identifier in
 *     this fleet shares the `TK` and `51105` tokens, so an EXACT vehicle number
 *     still returns 200 rows, while a nonsense identifier returns 0.
 *
 * A control that answers "0 or everything" cannot isolate a vehicle. Scanning
 * for an exact Vehicle No cell is deterministic instead, and it cannot select a
 * near neighbour — which is why TARGET_AMBIGUOUS does not exist.
 */

/* -------------------------------------------------------------------------- */
/*  VEHICLE SUMMARY CONSTANTS — this module's portal knowledge, and nowhere else */
/* -------------------------------------------------------------------------- */

/**
 * VERIFIED against the live portal on 2026-08-03, and the readiness signals
 * RE-VERIFIED AND TIMED on 2026-08-11 (`npm run portal:discover`, after the P1
 * intermittent-retrieval failure). None of these is a guess — each was read off
 * the rendered DOM, and every budget below is measured rather than chosen.
 *
 * The rendered structure this depends on:
 *
 *   <div class="LeftPane">
 *     <div class="lp-button"><div class="lpb-icon"><i class="fa fa-list"/>
 *       <div class="lpbi-name">Table View</div>
 *   <div class="im-tableView">
 *     <div class="InTable -white">
 *       <div class="it-no-data">No Data</div>
 *       <table>
 *         <thead><tr><th>Vehicle No</th><th>Device No</th>…</tr></thead>
 *         <tbody><tr><td>TK-51105-05GY-112507</td>…</tr>… 200 rows …</tbody>
 *       <div class="it-pagination">
 *         <input placeholder="Search"/>
 *         <div class="itp-item"><div class="active itpi-name">1</div></div>
 *         <div class="itp-item"><div class="itpi-name">2</div></div>
 */
const VEHICLE_SUMMARY = {
  /**
   * The dashboard's landing view, exactly as Fleet Overview uses. There is no
   * vehicle route to navigate to; the vehicle is reached by `resolve` below.
   */
  PATH: "/",

  /**
   * Proof that the APPLICATION has booted, waited for before any control is
   * touched.
   *
   * A LIST, raced candidate by candidate, for the same reason the Portal
   * Service races `readySelector` and the authenticator races its indicators:
   * portal markup is discovered rather than specified, and a single selector
   * makes readiness all-or-nothing — one stale guess reports a working
   * dashboard as unreachable. That is not hypothetical here; it is what this
   * module was doing.
   *
   * The LeftPane entries lead, because they are what this resolver is about to
   * CLICK. The header counts follow as corroboration: they are an API-driven
   * number, so they prove the application talked to the server, and they are
   * the signal Fleet Overview waits on. Both families were measured arriving
   * together (below), so leading with the control costs nothing and means
   * readiness is about the thing that has to be actionable.
   *
   * `#pac-input` is deliberately NOT here even though it appears at 1.1s. It is
   * the map's search box; it renders long before the LeftPane exists, so
   * waiting on it would return to a page whose table control cannot yet be
   * clicked — the same class of mistake as waiting on `.im-tableView` while it
   * still holds "No Data".
   */
  APP_READY: [
    ".LeftPane .lp-button i.fa-list",
    ".LeftPane .lp-button",
    ".h-controls .hci-count",
    ".Header .h-controls .hc-item .hci-count",
  ],

  /**
   * Readiness for THIS module: a populated table cell.
   *
   * A cell rather than the table, the tbody, or `.im-tableView` — all three
   * exist, sized and `display: block`, while the map view is showing and the
   * table holds nothing but a "No Data" placeholder. Waiting on any of them
   * would extract an empty dashboard and normalise it into confident absences.
   */
  READY: [
    ".im-tableView .InTable tbody tr td",
    ".im-tableView table tbody tr td",
  ],

  /** The LeftPane control that opens the table, identified by its icon. */
  TABLE_BUTTON: ".LeftPane .lp-button",
  TABLE_BUTTON_ICON: "i.fa-list",

  TABLE: ".im-tableView .InTable",
  HEADER_CELL: "thead th",
  ROW: "tbody tr",
  CELL: "td",

  /** One clickable page number in the table's pager. */
  PAGE_ITEM: ".it-pagination .itp-item",
  /** The marker the pager puts on the page currently being shown. */
  PAGE_ACTIVE: ".active",

  /**
   * How long to wait for the APPLICATION to boot, before any control is touched.
   *
   * Separate from STEP_TIMEOUT_MS, and much larger, because it bounds a
   * different thing: a cold client-rendered SPA fetching its own shell, rather
   * than an in-page interaction on an application that is already running.
   * Sharing one number was the P1 defect — the resolver was giving a cold boot
   * the same budget as a table click.
   *
   * MEASURED against the live portal on 2026-08-11 (`npm run portal:discover`,
   * on the second page load of a run, which is the one this resolver sees).
   * THREE samples within one hour, reported as the interval AFTER `goto`
   * resolves, because that is the interval this budget actually bounds:
   *
   *     sample   goto      LeftPane button     shell after goto
   *     1        6,735 ms   20,828 ms            14,093 ms
   *     2      ~21,800 ms   89,346 ms          ~67,500 ms
   *     3       13,974 ms   26,001 ms            12,027 ms
   *
   * The old budget was 15s, so sample 1 cleared it by about one second and
   * sample 2 missed it more than fourfold — which is exactly the reported
   * symptom: the same vehicle read correctly in one request and "did not exist"
   * in the next.
   *
   * WHAT IS SLOW IS THE PORTAL, not the navigation and not the markup. The map
   * (`#pac-input`) and the empty table container render 1-2s after `goto` in
   * every sample; the LeftPane, the header counts and the header search all
   * arrive together, tens of seconds later. They share a dependency the map does
   * not have — the account-wide fleet status over 320 vehicles — and that call
   * is what varies by a factor of five. No selector can be chosen to avoid it:
   * the table this module reads is populated by the same data.
   *
   * 90s is ~1.3x the worst observation. Sized from the WORST rather than the
   * median deliberately — the median already worked, and it is the tail that
   * produced a wrong answer. It is a CEILING and not a delay: samples 1 and 3
   * resolve in twelve to fourteen seconds and pay nothing for the headroom.
   */
  APP_READY_TIMEOUT_MS: 90_000,

  /**
   * How long to wait for the table to populate after opening it or paging.
   *
   * Its own budget rather than the service's readiness budget: this is a
   * SUB-OPERATION inside resolution, and the service's PORTAL_READY_TIMEOUT_MS
   * still governs the module's overall readiness afterwards. A stricter internal
   * SLA over an operation the module understands is exactly what SAD §19 allows
   * a service to keep alongside the outer ceiling.
   *
   * Unchanged at 15s: it bounds an interaction with an application that is
   * already running, which the discovery pass above shows is a different scale
   * of wait from the boot APP_READY_TIMEOUT_MS covers.
   */
  STEP_TIMEOUT_MS: 15_000,

  /**
   * Most pages the resolver will visit before reporting the vehicle absent.
   *
   * The live fleet is 320 vehicles across two 200-row pages. The cap is a
   * runaway guard, not a fleet size: it bounds the work when a pager renders
   * something unexpected, and it is stated rather than implied so a fleet that
   * outgrows it fails loudly instead of scanning forever inside a tool budget.
   */
  MAX_PAGES: 25,
} as const;

/* -------------------------------------------------------------------------- */
/*  Resolution — reaching the vehicle                                         */
/* -------------------------------------------------------------------------- */

/**
 * Whether the table currently shows any populated row.
 *
 * This, rather than an `active` class on the toggle, is what decides whether the
 * table needs opening. It is the state that actually matters, it cannot be
 * wrong-footed by a class name changing, and it makes the resolver idempotent:
 * a session that restored with the table already open is never toggled shut.
 */
async function tableHasRows(page: Page): Promise<boolean> {
  return (
    (await page
      .locator(`${VEHICLE_SUMMARY.TABLE} ${VEHICLE_SUMMARY.ROW}`)
      .count()
      .catch(() => 0)) > 0
  );
}

/** The Vehicle No cells currently rendered, canonicalised for comparison. */
async function vehiclesOnPage(page: Page): Promise<string[]> {
  return await page
    .locator(`${VEHICLE_SUMMARY.TABLE} ${VEHICLE_SUMMARY.ROW}`)
    .evaluateAll((rows, cell) =>
      rows.map((row) =>
        (row.querySelector(cell)?.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .toUpperCase()
      )
    , VEHICLE_SUMMARY.CELL);
}

const resolveVehicle: Resolver = async (page, request) => {
  const target = normalizeVehicleNo(request.target ?? "");

  // The application has to be up before any control can be clicked. Waiting on
  // the shell is what separates "the document arrived" from "the app ran".
  //
  // Raced through the service's own primitive rather than a single `waitFor`,
  // so a candidate that Intellicar renames costs only itself. A timeout here
  // means the application did not finish booting — which is NOT a statement
  // about the vehicle, and the message says so, because this used to surface as
  // an unreachable portal and then as "the vehicle does not exist".
  try {
    await waitForAnySelector(
      page,
      VEHICLE_SUMMARY.APP_READY,
      VEHICLE_SUMMARY.APP_READY_TIMEOUT_MS
    );
  } catch (error) {
    throw new PortalError(
      "MODULE_CHANGED",
      `The Intellicar dashboard did not finish loading in time, so ` +
        `${request.target} could not be looked up. The vehicle's status is ` +
        `unknown; this is not a finding about the vehicle.`,
      { cause: error }
    );
  }

  // Open the table only if it is not already showing data.
  if (!(await tableHasRows(page))) {
    await page
      .locator(VEHICLE_SUMMARY.TABLE_BUTTON, {
        has: page.locator(VEHICLE_SUMMARY.TABLE_BUTTON_ICON),
      })
      .first()
      .click({ timeout: VEHICLE_SUMMARY.STEP_TIMEOUT_MS });

    await page
      .locator(`${VEHICLE_SUMMARY.TABLE} ${VEHICLE_SUMMARY.ROW} ${VEHICLE_SUMMARY.CELL}`)
      .first()
      .waitFor({ state: "visible", timeout: VEHICLE_SUMMARY.STEP_TIMEOUT_MS });
  }

  const pager = page.locator(`${VEHICLE_SUMMARY.TABLE} ${VEHICLE_SUMMARY.PAGE_ITEM}`);
  const pageCount = Math.min(
    Math.max(await pager.count().catch(() => 1), 1),
    VEHICLE_SUMMARY.MAX_PAGES
  );

  for (let index = 0; index < pageCount; index += 1) {
    if ((await vehiclesOnPage(page)).includes(target)) return;

    // Not on this page — advance, unless this was the last one.
    if (index + 1 >= pageCount) break;

    const next = pager.nth(index + 1);
    await next.click({ timeout: VEHICLE_SUMMARY.STEP_TIMEOUT_MS });

    // The pager re-renders in place, so "the click worked" is the new page
    // carrying the active marker — not a navigation, which never happens here.
    await next
      .locator(VEHICLE_SUMMARY.PAGE_ACTIVE)
      .first()
      .waitFor({ state: "visible", timeout: VEHICLE_SUMMARY.STEP_TIMEOUT_MS })
      .catch(() => {
        // A pager that does not mark its active page is not a failure to find
        // the vehicle; the scan below is still authoritative.
      });

    await page
      .locator(`${VEHICLE_SUMMARY.TABLE} ${VEHICLE_SUMMARY.ROW} ${VEHICLE_SUMMARY.CELL}`)
      .first()
      .waitFor({ state: "visible", timeout: VEHICLE_SUMMARY.STEP_TIMEOUT_MS });
  }

  // Every page was inspected and no row carried this identifier. A normal,
  // reportable answer — the vehicle is not in this account — not a fault, and
  // the message says so without inviting a retry.
  throw new PortalError(
    "TARGET_NOT_FOUND",
    `The Intellicar portal does not list a vehicle with the identifier ` +
      `${request.target}.`
  );
};

/* -------------------------------------------------------------------------- */
/*  Identity                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Read back the Vehicle No the located row is showing, VERBATIM.
 *
 * The service compares it against the request; this only reports what is on
 * screen. Returns null when no row matches, which the service turns into
 * TARGET_NOT_FOUND.
 */
const assertVehicleIdentity: IdentityAssertion = async (page, request) => {
  const target = normalizeVehicleNo(request.target ?? "");

  return await page
    .locator(`${VEHICLE_SUMMARY.TABLE} ${VEHICLE_SUMMARY.ROW}`)
    .evaluateAll(
      (rows, options) => {
        for (const row of rows) {
          const rendered = (row.querySelector(options.cell)?.textContent ?? "")
            .replace(/\s+/g, " ")
            .trim();
          if (rendered.toUpperCase() === options.target) return rendered;
        }
        return null;
      },
      { cell: VEHICLE_SUMMARY.CELL, target }
    );
};

/* -------------------------------------------------------------------------- */
/*  Extraction                                                                */
/* -------------------------------------------------------------------------- */

const extractVehicleSummary: Extractor<VehicleSummaryRaw> = async (
  page,
  request
) => {
  const target = normalizeVehicleNo(request.target ?? "");

  /**
   * One round trip for the headers, the row and the page's timezone offset, and
   * a read-only one: the callback runs `querySelector`/`textContent` in the page
   * and returns plain data. The selectors are passed in as an argument because
   * the callback executes in the browser, where this module's scope does not
   * exist.
   */
  const read = await page.locator(VEHICLE_SUMMARY.TABLE).first().evaluate(
    (root, options) => {
      const text = (node: Element | null) =>
        (node?.textContent ?? "").replace(/\s+/g, " ").trim();

      const headers = [...root.querySelectorAll(options.header)].map((node) =>
        text(node)
      );

      let cells: string[] = [];
      let portalLabel = "";

      for (const row of root.querySelectorAll(options.row)) {
        const values = [...row.querySelectorAll(options.cell)].map((node) =>
          text(node)
        );
        if ((values[0] ?? "").toUpperCase() !== options.target) continue;
        cells = values;
        portalLabel = values[0] ?? "";
        break;
      }

      return {
        headers,
        cells,
        portalLabel,
        /**
         * Minutes to ADD to local time to reach UTC — the standard
         * `getTimezoneOffset` convention. Measured here rather than assumed
         * because this portal formats its timestamps client-side, so the zone
         * belongs to the browser running the scrape, not to the data.
         */
        renderOffsetMinutes: new Date().getTimezoneOffset(),
      };
    },
    {
      header: VEHICLE_SUMMARY.HEADER_CELL,
      row: VEHICLE_SUMMARY.ROW,
      cell: VEHICLE_SUMMARY.CELL,
      target,
    }
  );

  return {
    // Stamped here rather than in the normalizer, which may not read a clock.
    // It is the time of the READING; the portal publishes no "as of" timestamp.
    capturedAt: new Date().toISOString(),

    requested: target,
    portalLabel: read.portalLabel,

    /**
     * Null: the table renders no group or fleet column, and the account-wide
     * view it belongs to shows no scope label either. Reported rather than
     * invented — a fabricated scope would let the model attribute this vehicle
     * to a fleet the portal never named.
     */
    fleet: null,

    renderOffsetMinutes: read.renderOffsetMinutes,
    headers: read.headers,
    cells: read.cells,
  };
};

export const vehicleSummaryCapability = defineCapability({
  module: "vehicle_summary",
  targeted: true,
  path: VEHICLE_SUMMARY.PATH,
  readySelector: VEHICLE_SUMMARY.READY,
  resolve: resolveVehicle,
  assertIdentity: assertVehicleIdentity,
  extract: extractVehicleSummary,
  normalize: normalizeVehicleSummary,
  schema: vehicleSummarySchema,
});
