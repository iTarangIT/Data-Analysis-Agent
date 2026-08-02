import { register } from "node:module";

import { config as loadDotenv } from "dotenv";

/**
 * Manual verification runner for the Portal Service (Milestone 4B).
 *
 *   npm run portal:fetch                    # fleet_overview
 *   npm run portal:fetch -- fleet_overview
 *
 * Performs one real read of a live Intellicar dashboard module and prints the
 * validated JSON. Run it twice: the second run should reuse the stored session
 * and perform no login, and — with the browser now kept warm — should be
 * noticeably faster. That pair is the assertion that proves the warm path, not
 * just a working scrape.
 *
 * ## Deliberately temporary and deliberately outside the architecture
 *
 * Scaffolding for manual verification, exactly as scripts/auth-login.ts is for
 * Milestone 3. It adds no HTTP route, no agent tool and no registry entry, and
 * no application code imports it. It consumes the Portal Service exactly as the
 * Portal Tool does — `fetchPortalModule` and nothing else — so if this runner
 * works, the agent path works for the same reasons.
 *
 * It never touches the Session Manager directly: authentication ownership stays
 * where it is, and this script has no more access to a credential or a cookie
 * than a tool does.
 *
 * Output is the normalised payload only — never raw HTML, never a cookie.
 *
 * ## Why the imports below are dynamic
 *
 * `.env.local` has to be read before the modules load (Next.js does this
 * automatically, a bare `node` process does not), and the `@/*` alias has to be
 * resolvable (scripts/alias-loader.mjs). A static import would hoist above both.
 */

loadDotenv({ path: ".env.local", quiet: true });
register("./alias-loader.mjs", import.meta.url);

const { fetchPortalModule, PORTAL_MODULES } = await import(
  "@/services/portal/portal.service"
);

const requested = process.argv[2] ?? "fleet_overview";
const target = process.argv[3];

if (!(PORTAL_MODULES as readonly string[]).includes(requested)) {
  console.error(`\nUnknown module "${requested}".`);
  console.error(`Known modules: ${PORTAL_MODULES.join(", ")}\n`);
  process.exit(1);
}

// Not named `module`: that identifier is reserved in this lint config, and a
// script is not the place to argue with it.
const portalModule = requested as (typeof PORTAL_MODULES)[number];

console.log(`\nReading ${portalModule} from the live Intellicar portal…\n`);

const startedAt = Date.now();

try {
  const data = await fetchPortalModule({
    module: portalModule,
    ...(target ? { target } : {}),
  });

  console.log(JSON.stringify(data, null, 2));
  console.log(`\nOK — ${portalModule} read in ${Date.now() - startedAt} ms.`);
  console.log(
    "Run it again: the second run should reuse the session and the warm browser.\n"
  );
} catch (error) {
  const code = (error as { code?: string }).code ?? "UNKNOWN";
  console.error(`\nFAILED — ${code}`);
  console.error(`  ${error instanceof Error ? error.message : String(error)}`);

  // The two failures with completely different causes get pointed at the right
  // place, rather than leaving a reader to guess which layer moved.
  if (code === "MODULE_CHANGED") {
    console.error(
      "\n  The dashboard rendered, but not the data this module expects.\n" +
        "  Re-check the selectors in src/services/portal/extractors/, and re-run\n" +
        "  with PLAYWRIGHT_HEADLESS=false to watch."
    );
  } else if (code === "CREDENTIALS_REJECTED" || code === "NOT_CONFIGURED") {
    console.error("\n  This is an authentication failure — see docs/AUTH-SETUP.md.");
  }

  console.error("");
  process.exit(1);
}

// The Portal Service leaves Chromium warm on purpose (CLOSE_BROWSER_AFTER_RUN
// is false from Milestone 4B), which is right for a long-lived server and wrong
// for a one-shot script: the browser would hold the event loop open. Exiting
// explicitly is how this runner stays a runner.
process.exit(0);
