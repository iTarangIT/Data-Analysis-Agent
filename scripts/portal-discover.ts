import { register } from "node:module";

import { config as loadDotenv } from "dotenv";

/**
 * DISCOVERY RUNNER for the Vehicle Summary resolver (P1 — Intellicar retrieval).
 *
 *   npm run portal:discover
 *
 * CLAUDE.md's discovery rule: "Every module starts with a DISCOVERY PASS against
 * the live portal, and the design follows what it finds, not the other way
 * round. Selectors and catalogues are read off the rendered DOM and stamped
 * VERIFIED against the live portal on <date>; never guessed."
 *
 * This runner exists because `vehicle_summary` began failing at its FIRST wait —
 * `.h-controls .hci-count` under a 15s budget — while `fleet_overview`, which
 * waits on the same element under the Portal Service's 20s budget, still
 * succeeds. That is a measurement question, not a design question, so this
 * measures rather than guesses: it reproduces the exact page the resolver runs
 * against, then reports WHEN each candidate readiness signal first becomes
 * visible.
 *
 * ## Why it opens its own page rather than reading through the Portal Service
 *
 * The Portal Service's job is to return validated data or a PortalError; it
 * deliberately surfaces no timing. What has to be measured here is the interval
 * between `page.goto` resolving and each selector appearing, on the SECOND page
 * load of a run — the one `readModule` opens after `probeSession` has already
 * loaded `/` on a page of its own. So this reproduces that sequence exactly:
 * `withAuthenticatedContext` (which runs the probe), then `context.newPage()`,
 * then the same `goto` options `readModule` uses.
 *
 * It NEVER MUTATES. It navigates and observes; it clicks nothing, submits
 * nothing, and issues no device command.
 *
 * ## Deliberately temporary and deliberately outside the architecture
 *
 * Scaffolding for a one-off measurement, exactly as scripts/auth-login.ts and
 * scripts/portal-fetch.ts are for their milestones. No HTTP route, no agent
 * tool, no registry entry; no application code imports it. Output is timings and
 * selector names only — never page content, never a cookie.
 */

loadDotenv({ path: ".env.local", quiet: true });
register("./alias-loader.mjs", import.meta.url);

const { authEnv } = await import("@/lib/env");
const { withAuthenticatedContext } = await import(
  "@/services/session/session-manager"
);

/**
 * Every signal that could plausibly mean "the dashboard can now be driven",
 * measured side by side so the resolver can be built on whichever arrives
 * first and most reliably.
 *
 * `.h-controls .hci-count` is what the resolver waits on today. The LeftPane
 * entries are what it actually NEEDS — the control it is about to click. The
 * table entries tell us whether a restored session lands with the table already
 * open, which is the case `tableHasRows()` exists to skip.
 */
const CANDIDATES = [
  { name: "APP_READY (current)", selector: ".h-controls .hci-count" },
  { name: "header counts (specific)", selector: ".Header .h-controls .hc-item .hci-count" },
  { name: "header count item", selector: "div.hc-item div.hci-count" },
  { name: "LeftPane (container)", selector: ".LeftPane" },
  { name: "LeftPane button", selector: ".LeftPane .lp-button" },
  { name: "LeftPane table icon", selector: ".LeftPane .lp-button i.fa-list" },
  { name: "map search box", selector: "#pac-input" },
  { name: "header search box", selector: "#headersearch" },
  { name: "table container", selector: ".im-tableView .InTable" },
  { name: "table row cell", selector: ".im-tableView .InTable tbody tr td" },
  { name: "pager item", selector: ".it-pagination .itp-item" },
] as const;

/** How long to keep watching before giving up on a candidate. */
const OBSERVE_MS = 180_000;
/** How often to re-check every unresolved candidate. */
const POLL_MS = 250;

console.log("\nDiscovery pass — Vehicle Summary resolver readiness\n");

await withAuthenticatedContext(async (context) => {
  // The probe has already run and already loaded `/` on a page of its own.
  // Everything below reproduces what `readModule` does next.
  const page = await context.newPage();

  // The service sets no per-page timeout; the context default (AUTH_TIMEOUT_MS)
  // governs, exactly as it does for a real read.
  const navigationStartedAt = Date.now();

  await page.goto(`${authEnv().INTELLICAR_BASE_URL}/`, {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });

  const domContentLoadedAt = Date.now() - navigationStartedAt;
  console.log(`goto resolved (domcontentloaded): ${domContentLoadedAt} ms\n`);
  console.log("Watching for each candidate to become visible…\n");

  const firstVisibleAt = new Map<string, number>();

  while (
    Date.now() - navigationStartedAt < OBSERVE_MS &&
    firstVisibleAt.size < CANDIDATES.length
  ) {
    for (const candidate of CANDIDATES) {
      if (firstVisibleAt.has(candidate.name)) continue;

      // `isVisible()` rather than `waitFor()`: it is a point-in-time question
      // and returns immediately, so one slow candidate cannot delay the others.
      const visible = await page
        .locator(candidate.selector)
        .first()
        .isVisible()
        .catch(() => false);

      if (visible) {
        const at = Date.now() - navigationStartedAt;
        firstVisibleAt.set(candidate.name, at);
        console.log(
          `  ${String(at).padStart(6)} ms  ${candidate.name}  (${candidate.selector})`
        );
      }
    }

    await page.waitForTimeout(POLL_MS);
  }

  console.log("\n--- summary ---\n");

  for (const candidate of CANDIDATES) {
    const at = firstVisibleAt.get(candidate.name);
    console.log(
      `  ${at === undefined ? "  never" : String(at).padStart(6) + " ms"}  ` +
        `${candidate.name.padEnd(26)} ${candidate.selector}`
    );
  }

  // How many rows the table holds right now, which decides whether the resolver
  // has to open the Table View at all on a restored session.
  const rowCount = await page
    .locator(".im-tableView .InTable tbody tr")
    .count()
    .catch(() => 0);

  console.log(`\n  table rows currently rendered: ${rowCount}`);
  console.log(`  observation window: ${OBSERVE_MS} ms\n`);

  await page.close().catch(() => {});
});

process.exit(0);
