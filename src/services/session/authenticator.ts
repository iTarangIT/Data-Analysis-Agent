// TODO(debug): mkdir/join are used only by the temporary failure-capture block.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

// TODO(debug): `Response` is type-only and used solely by traceProbeNetwork.
// Aliased because `Response` is also a global type in this runtime.
import type {
  BrowserContext,
  Locator,
  Page,
  Response as PlaywrightResponse,
} from "playwright";

import { authEnv } from "@/lib/env";
import { childLogger } from "@/lib/logger";
import type { IntellicarCredential } from "@/services/credentials/credential-manager";

/**
 * Intellicar login flow (SAD §10, Milestone 3).
 *
 * Does exactly four things: open the login page, submit credentials, wait for
 * an authenticated state, and report the result. It does not decide when to log
 * in, does not read credentials (they are handed to it), does not persist
 * anything, and does not scrape.
 *
 * ## Every Intellicar-specific fact lives in the constants block below
 *
 * URLs, selectors and the authenticated-element selector are all in `INTELLICAR`
 * and nowhere else in the codebase. When the portal's markup changes, this one
 * block changes. Anything marked TODO(intellicar) is an UNVERIFIED PLACEHOLDER —
 * see docs/AUTH-SETUP.md for the replacement procedure.
 *
 * ## Errors are values, faults are exceptions
 *
 * `authenticate` returns a discriminated outcome instead of throwing for the
 * failures that are expected to happen: wrong credentials, an unreachable
 * portal, a changed page. This mirrors the convention already settled in this
 * codebase (`Extraction` in src/tools/analysis.tool.ts, SAD §19 "missing data
 * is reported, not thrown") and it matters here because each code drives a
 * different recovery: retry, back off, or stop and ask for new credentials.
 *
 * Outcomes carry a CODE and never a free-text detail from the page or the
 * browser. Playwright's own message travels as `cause` to the logger only. A
 * login failure message is a plausible place for a form value or a redirect URL
 * to appear, and the Tool Registry copies error text into the model's context
 * (src/agent/tool-registry.ts) — so nothing from this file is allowed to travel
 * outward as prose.
 */

const log = childLogger("authenticator");

/* -------------------------------------------------------------------------- */
/*  INTELLICAR CONSTANTS — the only portal-specific knowledge in the system    */
/* -------------------------------------------------------------------------- */

/**
 * Every value here is UNVERIFIED against the live portal. They are informed
 * guesses at conventional markup, written so that each is a single named
 * constant to replace once the real login page can be inspected.
 *
 * Verification procedure, and what each constant must become, are documented in
 * docs/AUTH-SETUP.md § "Replacing the portal placeholders".
 */
const INTELLICAR = {
  /**
   * TODO(intellicar): confirm the login path.
   * Assumed to be `/login` under INTELLICAR_BASE_URL. If the portal instead
   * serves the form at `/`, set this to "/" — the flow is otherwise unchanged.
   */
  // LOGIN_PATH: "/login",
  LOGIN_PATH: "/",

  /**
   * TODO(intellicar): confirm the post-login landing path.
   * Used as the probe target for an existing session: it must be a page that
   * requires authentication and that redirects to the login page when the
   * session has expired. A heavy dashboard works but is slow; the lightest
   * authenticated page is the better choice once one is known.
   */
  // DASHBOARD_PATH: "/ceo/intellicar",
  DASHBOARD_PATH: "/",

  /**
   * Path fragments that mean "we are looking at the login screen".
   * Used both to detect a redirect back to login and as a negative check on a
   * claimed successful authentication.
   */
  LOGIN_URL_MARKERS: ["/login", "/signin", "/sign-in"],

  /**
   * The two auth-host steps, as glob patterns for `waitForURL`.
   *
   * Host-agnostic on purpose: the auth host (`auth.intellicar.in`) is a
   * different origin from INTELLICAR_BASE_URL and is not configured anywhere,
   * so matching on the path alone keeps the flow working if that host moves.
   */
  IDENTIFIER_URL: "**/signin/identifier**",
  CHALLENGE_URL: "**/signin/challenge**",

  /**
   * The control on the landing page that starts the login flow.
   *
   * The portal no longer serves a form at LOGIN_PATH: the landing page carries a
   * Login button that redirects to the separate auth host, so this click is the
   * first step of the flow rather than a convenience.
   */
  LOGIN_BUTTON: ['button:has-text("Login")', "text=Login"],

  /**
   * The identifier (email/username) field on `/signin/identifier`.
   *
   * `input[type="text"]` is deliberately last-resort broad: the field is
   * rendered as a plain text input in some builds. It is raced alongside the
   * narrower candidates, so a page exposing `name="identifier"` still matches
   * on its own terms.
   */
  EMAIL_INPUT: [
    'input[type="email"]',
    'input[name="identifier"]',
    'input[placeholder*="Email"]',
    'input[name="email"]',
    'input[name="username"]',
    'input[type="text"]',
    "#email",
    "#username",
  ],

  /** The password field on `/signin/challenge`. */
  PASSWORD_INPUT: ['input[type="password"]', 'input[name="password"]', "#password"],

  /**
   * The control that advances each step of the two-step form. Both steps use
   * the same button ("Next"), so one array serves the identifier and challenge
   * pages alike.
   */
  SUBMIT_BUTTON: [
    'button:has-text("Next")',
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Log in")',
    'button:has-text("Sign in")',
  ],

  /**
   * The single most important constant in the file: the positive proof of
   * authentication, used by both the login verdict and the session probe.
   *
   * Every entry MUST be an element that appears ONLY when authenticated. A logo,
   * a footer, or anything also rendered on the login page would make a failed
   * login indistinguishable from a successful one — which is the failure mode
   * this whole design exists to prevent.
   *
   * ## The first two are VALIDATED against the live portal
   *
   *   1. `#pac-input` — the dashboard's places-autocomplete input. It does not
   *      exist in the DOM before login, and it is created only once the
   *      dashboard has initialised, so it cannot match a half-booted shell.
   *   2. `#intellicarSSODropWidget .ICSSOprofileDropdown` — the profile dropdown
   *      inside the SSO widget. The widget populates from the authenticated
   *      identity, so the descendant exists only after authentication; the
   *      wrapper is required in the selector because the container itself may be
   *      present, and empty, earlier.
   *
   * Two rather than one, deliberately. They come from different subsystems — the
   * map bundle and the SSO widget — so a change to either one leaves the other
   * standing, and the race settles on whichever renders first.
   *
   * ## Everything below them is a legacy placeholder, kept as a fallback
   *
   * TODO(intellicar): the entries from `#headersearch` down were never verified
   * against the portal and are ordered last on purpose. They are retained only so
   * that a markup change to the two validated selectors degrades to the previous
   * behaviour instead of to no behaviour at all. Delete them once the validated
   * pair has held across a few real sessions — a stale candidate that starts
   * matching something else is a liability, not insurance.
   *
   * Order is documentation, not priority: `firstVisible` races every candidate
   * concurrently and takes whichever becomes visible first, so a fallback that
   * still matches costs nothing and an unverified one that never matches costs
   * nothing either.
   */
  AUTHENTICATED_INDICATOR: [
    // Validated against the live portal.
    "#pac-input",
    // Legacy placeholders — unverified, retained as fallbacks only.
    "#headersearch",
    '[data-testid="nav-intellicar"]',
    'a:has-text("Intellicar Dashboard")',
    'nav a:has-text("Dashboard")',
    '[data-testid="user-menu"]',
    'button:has-text("Logout")',
    'a:has-text("Logout")',
  ],

  /**
   * Messages that ARE the error. A text selector cannot match an empty element,
   * so presence alone is proof.
   *
   * TODO(intellicar): add the portal's real rejection wording once seen. Do not
   * be tempted into a loose pattern like /invalid|incorrect/i — a login page
   * carrying help text ("if your credentials are incorrect, contact support")
   * would then report every attempt as rejected.
   */
  LOGIN_ERROR_TEXT: ['text="Invalid credentials"', 'text="Incorrect password"'],

  /**
   * CONTAINERS that hold an error when there is one. These are matched only if
   * they contain non-empty visible text, because an always-rendered, empty error
   * container is the norm rather than the exception.
   *
   * `[role="alert"]` excludes `#__next-route-announcer__` explicitly. A
   * Next.js-based portal always renders that announcer with `role="alert"`, and
   * it is 1px rather than `display:none` — so Playwright counts it as visible
   * and it won an empty-text race against the real verdict, reporting every
   * login as rejected. That was the observed failure.
   *
   * Excluding it by id is NOT redundant with the non-empty-text requirement.
   * The announcer's whole job is to announce the new page title after a route
   * change, so on a SUCCESSFUL login it becomes a visible `role="alert"` element
   * containing text — and a text check alone would then misreport the success.
   *
   * TODO(intellicar): replace `[data-testid="login-error"]` with the portal's
   * real error container if it exposes one.
   */
  LOGIN_ERROR_CONTAINER: [
    '[role="alert"]:not(#__next-route-announcer__)',
    ".alert-danger",
    ".error-message",
    '[data-testid="login-error"]',
  ],

  /**
   * TODO(intellicar): believed not to exist.
   *
   * The Milestone 3 brief states there is no MFA, OTP or CAPTCHA. This check is
   * a safety net, not a feature: if any of these ever appears, the flow reports
   * CHALLENGE_REQUIRED instead of silently timing out on a form it cannot fill.
   * Silent re-authentication (SAD §10) is IMPOSSIBLE if a challenge exists, so
   * this must surface loudly rather than be mistaken for a broken selector.
   *
   * ## A loaded CAPTCHA is not a CAPTCHA challenge
   *
   * `/signin/identifier` carries reCAPTCHA on every visit, badge and all, and
   * scores the session silently — no human is ever asked anything. The former
   * `iframe[src*='recaptcha']` and `.g-recaptcha` entries matched that badge
   * and failed EVERY login with CHALLENGE_REQUIRED before the email field was
   * even filled. That was the observed failure.
   *
   * So these two selectors ask "is the user being asked to solve something",
   * not "is the CAPTCHA library present":
   *
   *   - `...api2/bframe` is the challenge overlay — the image grid. Google
   *     always renders it, inside a wrapper carrying `visibility: hidden`
   *     until a challenge is actually demanded. Playwright honours an
   *     ancestor's visibility, so requiring the VISIBLE state is exactly the
   *     "user must solve this" test.
   *   - `...api2/anchor` is the widget itself, which is the v2 checkbox a user
   *     must tick — but is also the passive badge in the invisible and v3
   *     variants. Those carry `size=invisible` in the frame URL, so excluding
   *     it keeps the tickable checkbox and drops the badge.
   *
   * The consequence to accept knowingly: a CAPTCHA that is neither of these —
   * a non-Google widget, say — is no longer detected here. It would surface as
   * UNEXPECTED_PAGE after the verdict timeout instead, which is the correct
   * failure but a slower and less specific one. That is the right trade against
   * a check that previously rejected 100% of legitimate logins.
   */
  CHALLENGE_INDICATOR: [
    'input[name="otp"]',
    'input[autocomplete="one-time-code"]',
    'text="Verify your identity"',
    'iframe[src*="recaptcha"][src*="bframe"]',
    'iframe[src*="recaptcha"][src*="anchor"]:not([src*="size=invisible"])',
  ],

  /**
   * How long to wait for a post-submit verdict. Kept below AUTH_TIMEOUT_MS so
   * the indicator race resolves before the overall action timeout fires.
   */
  VERDICT_TIMEOUT_MS: 15_000,

  /**
   * The application's own session-verification call: the request the portal's
   * SPA issues during startup to decide whether the restored cookies still
   * identify a signed-in user.
   *
   * This is the portal's answer to the exact question the probe asks, which is
   * why the probe now waits for it instead of guessing from a render. Matched as
   * a substring of the lowercased PATH, so a mount under `/api/sso/verifytoken`
   * still matches while a query string cannot affect it.
   *
   * Method-agnostic on purpose. The temporary debug tracer narrows this to POST
   * because it is describing one observed run; the readiness gate cares that the
   * endpoint answered, not how the SPA chose to ask.
   */
  SESSION_VERIFY_PATH: "/sso/verifytoken",

  /**
   * How long to wait for the authenticated indicator when probing an existing
   * session — measured from the moment the application's startup sequence
   * settles, NOT from DOMContentLoaded. `waitForAppStartup` is what moves the
   * start of this clock.
   *
   * Short on purpose, and it can now afford to be: by the time it starts, the
   * app has verified the session and fetched its startup data, so the only thing
   * left to wait for is a render. It is NOT a budget for booting a SPA — that
   * was the mistake this one value used to absorb, and absorbing it is what made
   * a live session look expired.
   */
  PROBE_TIMEOUT_MS: 8_000,
} as const;

/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/*  TEMPORARY DEBUG CAPTURE — remove after the first successful real login     */
/*                                                                            */
/*  Diagnoses the placeholder selectors against the live portal. Delete this   */
/*  block — `captureFailureDiagnostics`, `captureChallengeDiagnostics`,        */
/*  `captureProbeCookies`, `captureExpiredProbeDiagnostics`,                   */
/*  `traceProbeNetwork`, `traceProbeTiming`, `traceStep`, `traceSelector` and  */
/*  their helpers — plus the call sites in `authenticate`, `probeSession`,     */
/*  `fillField` and `clickControl` (each marked TODO(debug)), and the optional */
/*  trailing debug parameters on `isAuthenticated` and `firstVisible`, to      */
/*  revert. Nothing else depends on it, and no call site affects control flow. */
/* -------------------------------------------------------------------------- */

/** Set to false to silence the capture without deleting it. */
const DEBUG_CAPTURE_LOGIN_FAILURE = true;

/**
 * Set to false to silence the step-by-step flow trace without deleting it.
 *
 * Logged at `info` because LOG_LEVEL defaults to "info" — at `debug` these
 * lines would not appear without also changing the environment.
 */
const DEBUG_TRACE_LOGIN_FLOW = true;

/**
 * Set to false to silence the pre-probe cookie dump without deleting it.
 *
 * Separate from DEBUG_TRACE_LOGIN_FLOW because it diagnoses a different
 * question: not "did the login flow reach its steps" but "did the restored
 * storageState still carry a usable session when the probe started".
 */
const DEBUG_TRACE_PROBE_COOKIES = true;

/**
 * Set to false to silence the per-response probe network trace.
 *
 * Worth its own flag rather than riding on DEBUG_TRACE_LOGIN_FLOW because it is
 * by far the noisiest thing in this file: it emits ONE LINE PER RESPONSE, and a
 * single portal page load is routinely a hundred of them. Turn it off once the
 * redirect question is answered.
 */
// Set to false so the one-line probe timeline is not drowned: this emits a line
// per document/xhr/fetch response, which is exactly the scattered output the
// timeline replaces. Flip back to true when the per-response detail — notably
// the auth-host redirect attribution, which the timeline does not carry — is
// what is wanted.
const DEBUG_TRACE_PROBE_NETWORK = false;

/**
 * Statuses called out separately in the probe trace.
 *
 * 401 and 403 are the portal saying the restored session is not authenticated.
 * 302 is how that verdict usually ARRIVES — a bounce to the auth host — and it
 * is the one the probe's own logic is blind to, since `page.goto` follows
 * redirects silently and reports only the final status.
 */
const DEBUG_HIGHLIGHT_STATUSES = new Set([401, 403, 302]);

/**
 * Resource types that earn a line on their own merits, whatever their status.
 *
 * `document` is the navigation itself plus every redirect hop it passes
 * through — the probe's own question. `xhr` and `fetch` are where a SPA
 * discovers it is signed out, which is the failure mode this probe exists to
 * detect and the one `page.goto`'s single status cannot see.
 *
 * Everything else — images, stylesheets, fonts, media, scripts — cannot
 * distinguish an authenticated session from an anonymous one. A highlighted
 * status still rescues them, so a 302 on a script is not lost.
 */
const DEBUG_LOGGED_RESOURCE_TYPES = new Set(["document", "xhr", "fetch"]);

/**
 * Hosts dropped from the trace even when they answer with a highlighted status.
 *
 * Map tiles and analytics are the precise reason the highlight rule needs an
 * exception rather than being absolute: a tile server 403 and an ad-blocked
 * analytics 302 are routine, say nothing about the Intellicar session, and
 * would otherwise be the loudest thing in the trace. Matched as a substring of
 * the HOSTNAME, so `www.google-analytics.com` and `region1.google-analytics.com`
 * both match a single entry.
 *
 * Nothing is silently lost: suppressed responses are counted, and a suppressed
 * response carrying a 302/401/403 is counted SEPARATELY and reported in the
 * summary. If that number is not zero and matters, widen the trace rather than
 * guessing — the entry that hid it is in this list.
 *
 * A starting list, not an exhaustive one. Extend it when a run shows a noisy
 * third party this misses.
 */
const DEBUG_IGNORED_HOST_PATTERNS = [
  // Analytics, product telemetry, error reporting.
  "google-analytics.com",
  "googletagmanager.com",
  "doubleclick.net",
  "segment.io",
  "segment.com",
  "sentry.io",
  "hotjar.com",
  "mixpanel.com",
  "amplitude.com",
  "clarity.ms",
  "newrelic.com",
  "datadoghq.com",
  "intercom.io",
  "fullstory.com",
  // Basemap and tile providers — a fleet-tracking portal is full of these.
  "tile.openstreetmap.org",
  "tiles.",
  "basemaps.",
  "mapbox.com",
  "maptiler.com",
  "arcgisonline.com",
  "maps.googleapis.com",
] as const;

/**
 * The auth origin the probe must not end up on.
 *
 * Portal-specific knowledge that by convention belongs in the `INTELLICAR`
 * block above; parked here because it is temporary and self-deleting, and
 * because it is a diagnostic threshold rather than a value the flow acts on.
 * Note the flow ALREADY encodes this host path-only (IDENTIFIER_URL and
 * friends) precisely so the host can move — so treat a miss here as "the host
 * changed", not as "no redirect happened".
 */
const DEBUG_AUTH_HOST = "auth.intellicar.in";

/** Set to false to silence the probe readiness timing without deleting it. */
const DEBUG_TRACE_PROBE_TIMING = true;

/**
 * The session-verification call whose 200 marks "the app knows it is signed
 * in". Matched as a substring of the lowercased PATH, so a mount under
 * `/api/sso/verifytoken` still matches while a query string cannot affect it.
 */
const DEBUG_VERIFY_TOKEN_PATH = "/sso/verifytoken";

/**
 * The origin whose XHR/fetch traffic counts as "authenticated API activity"
 * once the session has been verified.
 *
 * Named explicitly rather than derived from INTELLICAR_BASE_URL: the timeline
 * is answering a question about THIS host, and silently following a change of
 * base URL would alter what the timeline reports without altering what it says
 * it reports.
 */
const DEBUG_API_HOST = "track.intellicar.in";

/**
 * Ceiling on `api-response` entries in one timeline.
 *
 * A booting SPA can issue a great many calls, and a single log line carrying
 * hundreds of entries stops being readable — which is the entire point of
 * collapsing to one timeline. Overflow is COUNTED and reported, never dropped
 * silently.
 */
const DEBUG_TIMELINE_API_LIMIT = 50;

/** Set to false to silence the expired-probe DOM capture without deleting it. */
const DEBUG_CAPTURE_PROBE_EXPIRED = true;

const DEBUG_PROBE_SCREENSHOT_FILENAME = "probe-expired.png";

/**
 * The indicator asked about by name in the expired-probe capture.
 *
 * Spelled out rather than read from `AUTHENTICATED_INDICATOR[0]`: the capture
 * answers a specific question about THIS selector, and silently following a
 * reordering of that array would change what the diagnostic reports without
 * changing what it claims to report. Updating it is therefore a deliberate act —
 * it moved from the legacy `#headersearch` to the validated primary when the
 * indicator list was verified against the live portal.
 */
const DEBUG_PRIMARY_INDICATOR = "#pac-input";

/**
 * Phrases whose visible presence means "the app is still working on it", which
 * would make an expired verdict a readiness artefact rather than a real one.
 */
const DEBUG_READINESS_PHRASES = ["Loading", "Authenticating", "Please wait"] as const;

/**
 * How many matches per phrase are checked for visibility.
 *
 * An unquoted `text=` match hits every ancestor of the matching node as well as
 * the node itself, so an unbounded scan on a busy page is a lot of round trips
 * to learn one boolean. The first visible match settles the question anyway.
 */
const DEBUG_READINESS_SCAN_LIMIT = 5;

const DEBUG_SCREENSHOT_FILENAME = "login-failure.png";

/** Longest snippet of portal text worth putting in a log line. */
const DEBUG_TEXT_LIMIT = 300;

/**
 * A URL safe to put in a log line: origin and path in full, every query value
 * and the fragment replaced.
 *
 * Not `page.url()` verbatim, and the difference matters on exactly this flow.
 * An identity-provider round trip is the canonical place for a one-time code,
 * a state parameter or a session token to ride in the query string or the
 * fragment, and Pino's redaction matches field paths — it cannot see inside a
 * URL string. Parameter NAMES are kept, since "the callback arrived with no
 * `code`" is the kind of thing this trace exists to show.
 */
function safeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);

    const names = [...url.searchParams.keys()];
    const query =
      names.length > 0 ? `?${names.map((name) => `${name}=[redacted]`).join("&")}` : "";
    const fragment = url.hash.length > 1 ? "#[redacted]" : "";

    return `${url.origin}${url.pathname}${query}${fragment}`;
  } catch {
    return "[unparseable]";
  }
}

/**
 * Record where the browser is at one named point in the login flow.
 *
 * Tolerates a closed page: the auth popup closes as part of the happy path, and
 * a trace call must never be the thing that throws.
 */
function traceStep(page: Page, step: string): void {
  if (!DEBUG_TRACE_LOGIN_FLOW) return;

  const url = page.isClosed() ? "[closed]" : safeUrl(page.url());
  log.info({ step, url }, "DEBUG: login flow step.");
}

/**
 * Record which candidate selector won the race for a control.
 *
 * The selector, never the value typed into it — `target` is a field NAME
 * ("email"), not its contents.
 */
function traceSelector(target: string, selector: string): void {
  if (!DEBUG_TRACE_LOGIN_FLOW) return;

  log.info({ target, selector }, "DEBUG: selector matched.");
}

/**
 * Remove email-shaped substrings from captured portal text.
 *
 * A rejection message can name the account ("No user found for a@b.com"), and
 * the configured email is half of the credential. The message is what we need
 * for debugging; the address is not.
 */
function stripEmails(text: string): string {
  return text.replace(/[\w.+-]+@[\w.-]+\.\w+/g, "[email]");
}

/**
 * Which Playwright selector engine a candidate string uses.
 *
 * Worth reporting because the engines fail differently. A CSS attribute
 * selector matching something unexpected is a markup surprise; a `text=`
 * selector matching is a CONTENT surprise, and `text="..."` is substring-ish
 * enough that a longer sentence containing the phrase also matches. Knowing
 * which kind fired says which of those two problems this is.
 */
function selectorEngine(selector: string): string {
  if (selector.startsWith("text=")) return "text";
  if (selector.startsWith("xpath=") || selector.startsWith("//")) return "xpath";
  if (selector.includes(":has-text(")) return "css+text";
  return "css";
}

/**
 * Report every CHALLENGE_INDICATOR candidate's state at the moment the check
 * tripped, to settle whether the challenge is real or a false positive.
 *
 * Enumerates ALL candidates rather than just the race winner: "one selector
 * matched an invisible node" and "three selectors match" are different faults.
 * The DOM is re-queried after the race has already resolved, so a genuinely
 * transient element could show `visible: false` here — treat a row with
 * `count > 0, visible: false` as "present but not what tripped the race".
 *
 * Text is email-stripped and truncated, as everywhere else in this block.
 */
async function captureChallengeDiagnostics(page: Page): Promise<void> {
  if (!DEBUG_TRACE_LOGIN_FLOW) return;

  try {
    const candidates: Array<{
      selector: string;
      engine: string;
      count: number;
      visible: boolean;
      text: string;
    }> = [];

    for (const selector of INTELLICAR.CHALLENGE_INDICATOR) {
      const all = page.locator(selector);
      // -1 distinguishes "the selector itself is invalid" from "matched nothing".
      const count = await all.count().catch(() => -1);
      if (count === 0) continue;

      const first = all.first();
      const visible = await first.isVisible().catch(() => false);
      // innerText on an <input> or <iframe> is empty by nature; that is itself
      // informative, so it is reported rather than skipped.
      const text = visible ? (await first.innerText().catch(() => "")).trim() : "";

      candidates.push({
        selector,
        engine: selectorEngine(selector),
        count,
        visible,
        text: stripEmails(text).slice(0, DEBUG_TEXT_LIMIT),
      });
    }

    log.error(
      { url: safeUrl(page.url()), candidates },
      "DEBUG: challenge detection tripped — candidates matching now."
    );
  } catch (error) {
    log.warn({ err: error }, "DEBUG: failed to capture challenge detection state.");
  }
}

/** One line per page the verdict race is about to watch, and why. */
function traceVerdictWatch(portal: Page, auth: Page | null): void {
  if (!DEBUG_TRACE_LOGIN_FLOW) return;

  const describe = (page: Page) => ({
    url: page.isClosed() ? "[closed]" : safeUrl(page.url()),
    closed: page.isClosed(),
  });

  log.error(
    {
      portal: describe(portal),
      auth:
        auth === null
          ? { present: false, watched: false }
          : { present: true, watched: !auth.isClosed(), ...describe(auth) },
    },
    "DEBUG: verdict race — pages being watched."
  );
}

/**
 * The outcome of ONE selector's `waitFor({ state: "visible" })`.
 *
 * `count` is read only on a timeout, and is what separates the two very
 * different failures behind an identical timeout: `count: 0` means the element
 * was never in the DOM (wrong selector, or the page never got there), while
 * `count > 0` means it was there all along but Playwright judged it not
 * visible — zero-sized, `display:none`, or behind a hidden ancestor.
 *
 * Expect lines to arrive AFTER the verdict is decided. `Promise.any` settles on
 * the first winner but does not cancel the losers, so the rest keep waiting and
 * report their own timeouts later — by which point the pages may be closed, and
 * `reason` will say so. A late line is not evidence about the verdict; read
 * `elapsedMs` to place it.
 */
async function traceCandidate(
  scope: string,
  page: Page,
  code: string,
  selector: string,
  outcome: "visible" | "timeout",
  elapsedMs: number,
  error?: unknown
): Promise<void> {
  if (!DEBUG_TRACE_LOGIN_FLOW) return;

  try {
    const count =
      outcome === "timeout" ? await page.locator(selector).count().catch(() => -1) : undefined;

    log.error(
      {
        scope,
        code,
        selector,
        outcome,
        elapsedMs,
        count,
        page: page.isClosed() ? "[closed]" : safeUrl(page.url()),
        // Playwright's own message names selectors and timeouts, never typed
        // values — safe to log, truncated because the full text is a paragraph.
        reason:
          error instanceof Error ? stripEmails(error.message).split("\n")[0].slice(0, 160) : undefined,
      },
      "DEBUG: verdict candidate evaluated."
    );
  } catch {
    // Diagnostics must never change the outcome being diagnosed.
  }
}

/** Why the race across all pages produced no verdict. */
function traceNoVerdict(scope: string, error: unknown): void {
  if (!DEBUG_TRACE_LOGIN_FLOW) return;

  // Promise.any rejects with an AggregateError carrying one entry per page, in
  // the order the pages were passed. That list IS the answer to "why null".
  const reasons =
    error instanceof AggregateError
      ? error.errors.map((entry: unknown) =>
          entry instanceof Error ? stripEmails(entry.message).split("\n")[0].slice(0, 160) : String(entry)
        )
      : [error instanceof Error ? error.message : String(error)];

  log.error({ scope, reasons }, "DEBUG: verdict race produced no match.");
}

/**
 * Report what the page actually looked like when a login failed.
 *
 * Answers the question the failure codes cannot: WHICH selector matched, and
 * did it match something that was on the page all along? A login page carrying
 * a permanent `[role="alert"]` banner — a cookie notice, a maintenance note —
 * would win the verdict race instantly and make every login, including a
 * correct one, report INVALID_CREDENTIALS.
 *
 * Deliberately never captures a credential, cookie or storageState: text is
 * email-stripped and truncated, and the screenshot masks the email and password
 * fields so the typed address is not photographed.
 */
async function captureFailureDiagnostics(
  page: Page,
  verdict: string
): Promise<void> {
  if (!DEBUG_CAPTURE_LOGIN_FAILURE) return;

  try {
    const url = new URL(page.url());

    // Which candidates match RIGHT NOW, and what they say. Every candidate is
    // checked, not just the race winner, because "three alert selectors match"
    // and "one does" point at different problems.
    const matches: Array<{ selector: string; text: string; counts: boolean }> = [];

    for (const selector of [
      ...INTELLICAR.LOGIN_ERROR_TEXT,
      ...INTELLICAR.LOGIN_ERROR_CONTAINER,
    ]) {
      const locator = page.locator(selector).first();
      // Already-settled page: no waiting, just ask.
      if (!(await locator.isVisible().catch(() => false))) continue;

      const text = (await locator.innerText().catch(() => "")).trim();
      matches.push({
        selector,
        text: stripEmails(text).slice(0, DEBUG_TEXT_LIMIT),
        // Whether this match would actually be treated as a rejection: a
        // container with no text is now ignored. Distinguishes "matched" from
        // "counted" in the next diagnosis.
        counts: text.length > 0,
      });
    }

    const indicators: string[] = [];
    for (const selector of INTELLICAR.AUTHENTICATED_INDICATOR) {
      if (await page.locator(selector).first().isVisible().catch(() => false)) {
        indicators.push(selector);
      }
    }

    log.error(
      {
        verdict,
        // Path only — a full URL can carry tokens in its query string.
        path: url.pathname,
        stillOnLoginPage: isLoginUrl(page.url()),
        title: stripEmails(await page.title().catch(() => "")).slice(0, 120),
        errorSelectorsMatched: matches,
        authenticatedSelectorsMatched: indicators,
        passwordFieldStillPresent: await page
          .locator(INTELLICAR.PASSWORD_INPUT[0])
          .first()
          .isVisible()
          .catch(() => false),
      },
      "DEBUG: login failure page state."
    );

    const directory = authEnv().SESSION_STORE_DIR;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, DEBUG_SCREENSHOT_FILENAME);

    await page.screenshot({
      path,
      fullPage: true,
      // Paints a box over the credential fields, so the typed email is not in
      // the image. Masking beats clearing the fields: it does not mutate the
      // page, so the error being diagnosed is still visible.
      mask: [
        page.locator(INTELLICAR.EMAIL_INPUT.join(", ")),
        page.locator(INTELLICAR.PASSWORD_INPUT.join(", ")),
      ],
    });

    log.error({ path }, "DEBUG: login failure screenshot saved.");
  } catch (error) {
    // Diagnostics must never change the outcome being diagnosed.
    log.warn({ err: error }, "DEBUG: failed to capture login failure state.");
  }
}

/**
 * Report what the restored storageState actually put in the cookie jar, before
 * the probe navigates anywhere.
 *
 * Answers the question the three-state ProbeResult cannot: when a probe reports
 * `expired`, was the context anonymous before it ever left the process, or did
 * it carry live cookies that the portal or the AUTHENTICATED_INDICATOR race
 * then rejected? Playwright silently DROPS cookies whose `expires` is already
 * past when rehydrating a storageState, so an empty or short jar here means the
 * session died on disk, while a full jar points at the probe target or the
 * selectors instead.
 *
 * ## No cookie value is read, and the field is not called `cookies`
 *
 * `value` is never touched — a session cookie's value IS the session (rule 1 in
 * src/lib/logger.ts). Only metadata is logged.
 *
 * The payload field is `cookieSummary` rather than the obvious `cookies`
 * because `cookies` is a redacted path in src/lib/logger.ts: logging under that
 * name would censor the whole array to "[redacted]" and quietly produce a
 * useless diagnostic. The name is deliberately outside the redaction list AND
 * deliberately value-free, so the guard is not being evaded — there is simply
 * nothing secret in it to hide.
 */
async function captureProbeCookies(context: BrowserContext): Promise<void> {
  if (!DEBUG_TRACE_PROBE_COOKIES) return;

  try {
    const cookies = await context.cookies();

    log.info(
      {
        probeUrl: safeUrl(probeUrl()),
        cookieCount: cookies.length,
        cookieSummary: cookies.map((cookie) => ({
          name: cookie.name,
          domain: cookie.domain,
          // Playwright reports seconds since the epoch, and -1 for a
          // session cookie. Rendered as well as raw: the whole point of this
          // dump is spotting an expiry, and eyeballing a Unix timestamp
          // against "now" is exactly where that goes wrong.
          expires: cookie.expires,
          expiresIso:
            cookie.expires > 0
              ? new Date(cookie.expires * 1000).toISOString()
              : "session",
          httpOnly: cookie.httpOnly,
          secure: cookie.secure,
        })),
      },
      "DEBUG: restored session cookies before probe navigation."
    );
  } catch (error) {
    // Diagnostics must never change the outcome being diagnosed.
    log.warn({ err: error }, "DEBUG: failed to read restored session cookies.");
  }
}

/** Whether a URL is served by the auth host. Parse failures are not matches. */
function isAuthHostUrl(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).hostname === DEBUG_AUTH_HOST;
  } catch {
    return false;
  }
}

/**
 * Whether a URL belongs to a host this trace deliberately ignores.
 *
 * An unparseable URL is NOT treated as ignorable: `data:` and `blob:` URLs land
 * here, and silently dropping something unrecognised is exactly how a trace
 * ends up missing the one response that mattered.
 */
function isIgnoredHostUrl(rawUrl: string): boolean {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return DEBUG_IGNORED_HOST_PATTERNS.some((pattern) => host.includes(pattern));
  } catch {
    return false;
  }
}

/**
 * Log the network responses that can say something about the session, and call
 * out the ones that mean "not authenticated".
 *
 * ## Why this exists
 *
 * `probeSession` sees exactly one status — `response.status()` from `page.goto`
 * — and `goto` follows redirects silently, so that status is the status of the
 * FINAL hop. A probe that was 302'd to the auth host and then served a
 * perfectly good 200 login page is, to the existing code, a 200. Every
 * intermediate hop is invisible, which is precisely where the answer lives.
 *
 * ## Which responses get a line
 *
 * A response is logged when it is a `document`, `xhr` or `fetch`, OR when it
 * carries a 302/401/403 — so a redirect on a resource type that is otherwise
 * ignored is still seen. Two exceptions to that, both deliberate:
 *
 *   - Ignored hosts (analytics, basemap tiles) are dropped even when
 *     highlighted, because they are the specific source of routine 302s and
 *     403s that have nothing to do with this session.
 *   - The auth-host attribution below runs before any filtering at all.
 *
 * Suppression is counted, never silent: `suppressed` and `suppressedHighlighted`
 * appear in the summary, so "nothing else was interesting" is a number rather
 * than an assumption.
 *
 * ## What is logged, and what is deliberately not
 *
 * URL, method, status, resource type. No headers, no bodies, no post data, no
 * cookies. URLs go
 * through `safeUrl`, so query VALUES are redacted while parameter names survive
 * — an auth redirect carries its state and code in the query string, and
 * "the bounce carried a `code`" is exactly the kind of thing worth seeing while
 * the code itself is not.
 *
 * ## Attribution of the auth-host navigation
 *
 * Two distinct one-time lines, because two different things can be true:
 *
 *   - the response that REDIRECTED to the auth host, found via
 *     `request.redirectedTo()` — Playwright's own redirect chain, so no header
 *     needs to be read to establish it; and
 *   - the first response SERVED BY the auth host, which is the fallback signal
 *     when the navigation was client-side and therefore caused by no response
 *     at all.
 *
 * If the second appears without the first, the bounce was JavaScript, not a
 * 3xx — a materially different finding.
 *
 * Returns a detach function. The listener is bound to the probe's own page and
 * removed when the probe ends, so this observes the probe and nothing else.
 */
function traceProbeNetwork(page: Page): () => void {
  if (!DEBUG_TRACE_PROBE_NETWORK) return () => {};

  let seen = 0;
  let logged = 0;
  let highlighted = 0;
  let suppressed = 0;
  let suppressedHighlighted = 0;
  let redirectReported = false;
  let authHostReported = false;

  const onResponse = (response: PlaywrightResponse) => {
    try {
      const request = response.request();
      const status = response.status();
      const method = request.method();
      const rawUrl = response.url();
      const url = safeUrl(rawUrl);
      const resourceType = request.resourceType();
      const highlight = DEBUG_HIGHLIGHT_STATUSES.has(status);

      seen += 1;

      // Auth-host attribution runs BEFORE the noise filter, deliberately. The
      // bounce to the auth host is the one line this trace must never drop, and
      // deciding it is noise because of how it happens to be classified would
      // discard the answer while reporting a tidy summary.
      const redirectedTo = request.redirectedTo()?.url();
      if (!redirectReported && redirectedTo !== undefined && isAuthHostUrl(redirectedTo)) {
        redirectReported = true;
        log.error(
          { url, method, status, resourceType, redirectedTo: safeUrl(redirectedTo) },
          "DEBUG: first probe response redirecting to the auth host."
        );
      }

      if (!authHostReported && isAuthHostUrl(rawUrl)) {
        authHostReported = true;
        log.error(
          { url, method, status, resourceType, viaRedirect: redirectReported },
          "DEBUG: first probe response served by the auth host."
        );
      }

      // Ignored hosts lose even their highlighted statuses — a tile 403 and an
      // ad-blocked analytics 302 are the noise this filter exists for. Counted
      // so the suppression is visible in the summary rather than assumed.
      if (isIgnoredHostUrl(rawUrl)) {
        suppressed += 1;
        if (highlight) suppressedHighlighted += 1;
        return;
      }

      // Everything else: interesting by type, or interesting by status.
      if (!highlight && !DEBUG_LOGGED_RESOURCE_TYPES.has(resourceType)) {
        suppressed += 1;
        return;
      }

      logged += 1;
      if (highlight) highlighted += 1;

      const payload = { url, method, status, resourceType, highlight };

      // Highlighted responses go to `warn` so they stand out without a second
      // pass, and survive a level that would drown the rest.
      if (highlight) {
        log.warn(payload, "DEBUG: probe response — 302/401/403.");
      } else {
        log.info(payload, "DEBUG: probe response.");
      }
    } catch {
      // Diagnostics must never change the outcome being diagnosed.
    }
  };

  page.on("response", onResponse);

  return () => {
    try {
      page.off("response", onResponse);

      // Read in the probe's `finally`, before the page closes — so this is the
      // URL the probe actually ended on, after every redirect `page.goto`
      // followed silently. On the unreachable path the navigation never landed,
      // and this reports whatever the page was left showing.
      const finalUrl = page.isClosed() ? null : page.url();

      log.info(
        {
          seen,
          logged,
          highlighted,
          suppressed,
          suppressedHighlighted,
          finalUrl: finalUrl === null ? "[closed]" : safeUrl(finalUrl),
          // The two facts the probe's own verdict turns on, stated plainly.
          onAuthHost: finalUrl !== null && isAuthHostUrl(finalUrl),
          onLoginUrl: finalUrl !== null && isLoginUrl(finalUrl),
          redirectedToAuthHost: redirectReported,
          reachedAuthHost: authHostReported,
        },
        "DEBUG: probe network summary."
      );
    } catch {
      // Never let teardown of a diagnostic break the probe's own teardown.
    }
  };
}

/**
 * Readiness timing for one probe.
 *
 * Every method is a no-op when DEBUG_TRACE_PROBE_TIMING is false, so the call
 * sites need no flag checks of their own and the disabled cost is a few
 * function calls that return immediately.
 */
interface ProbeTimingRecorder {
  /** Called once `page.goto` resolves. */
  markDomContentLoaded(): void;
  /** Watch a page for the session-verification response. */
  attach(page: Page): void;
  /** What ended the wait for the application's startup sequence. */
  markStartupSettled(signal: string): void;
  /** The winning AUTHENTICATED_INDICATOR selector, or null on timeout. */
  onIndicatorSettled(selector: string | null): void;
  /** Identity: records the probe's verdict and hands it straight back. */
  result(value: ProbeResult): ProbeResult;
  /** Detach and emit the single summary. */
  finish(): void;
}

/**
 * Measure how long the probe's readiness signals actually take to arrive.
 *
 * ## The question this answers
 *
 * This measured the fault it is now measuring the fix for. `probeSession` used
 * to navigate with `domcontentloaded` and immediately ask `isAuthenticated`,
 * whose indicator race is capped at PROBE_TIMEOUT_MS. For an SPA,
 * `domcontentloaded` fires before the bundle has executed — so that cap had to
 * cover bundle execution, the session-verification round trip, AND render. It
 * did not: the verifytoken 200 and the authenticated XHRs after it landed while
 * the indicator race was still running, and the probe reported a live session as
 * expired.
 *
 * `waitForAppStartup` now sits between the two, and the `startup-settled` entry
 * is where the timeline shows it working: on a healthy reuse it should appear
 * shortly after the last `api-response`, with `indicator-visible` close behind
 * it rather than an `indicator-timeout` in its place.
 *
 * ## Observation only
 *
 * Nothing here waits, retries, or changes a timeout. `result()` is an identity
 * function — it records the verdict and returns exactly what it was handed —
 * which is what lets the summary name the outcome without restructuring the
 * probe's returns into a variable.
 *
 * Timestamps are absolute ISO for correlating against other logs, with elapsed
 * milliseconds alongside because "1.2s after DOMContentLoaded" is the form the
 * question is actually asked in.
 */
function traceProbeTiming(): ProbeTimingRecorder {
  if (!DEBUG_TRACE_PROBE_TIMING) {
    return {
      markDomContentLoaded() {},
      attach() {},
      markStartupSettled() {},
      onIndicatorSettled() {},
      result: (value) => value,
      finish() {},
    };
  }

  const startedAt = Date.now();

  /** One entry per recorded moment, appended as it happens. */
  const events: Array<{ at: number; event: string } & Record<string, unknown>> = [];

  let domContentLoadedAt: number | null = null;
  let verifyToken200At: number | null = null;
  let startupSignal: string | null = null;
  let indicatorRaceRan = false;
  let probeResult: ProbeResult | null = null;
  let apiRecorded = 0;
  let apiDropped = 0;

  let watchedPage: Page | null = null;
  let onResponse: ((response: PlaywrightResponse) => void) | null = null;

  const record = (event: string, detail: Record<string, unknown> = {}): void => {
    events.push({ at: Date.now(), event, ...detail });
  };

  record("probe-start");

  return {
    markDomContentLoaded() {
      if (domContentLoadedAt !== null) return;
      domContentLoadedAt = Date.now();
      record("goto-resolved-domcontentloaded");
    },

    attach(page: Page) {
      onResponse = (response: PlaywrightResponse) => {
        try {
          const request = response.request();
          const status = response.status();
          const url = new URL(response.url());
          // PATH ONLY — never the query string. An authenticated API call is a
          // plausible place for a token or an id to ride in the query, and a
          // path answers "which endpoint, when" on its own.
          const path = url.pathname;

          // The first successful verification, which is the moment the app
          // knows it is signed in. A SPA may verify repeatedly; it is the first
          // success that gates the render this probe is waiting on.
          if (
            verifyToken200At === null &&
            request.method() === "POST" &&
            status === 200 &&
            path.toLowerCase().includes(DEBUG_VERIFY_TOKEN_PATH)
          ) {
            verifyToken200At = Date.now();
            record("verifytoken-200", { method: request.method(), status, path });
            return;
          }

          // Authenticated API activity means AFTER verification, on the portal
          // host, and issued by the application rather than by the document —
          // so a navigation or a subresource cannot masquerade as one.
          if (verifyToken200At === null) return;
          if (url.hostname !== DEBUG_API_HOST) return;

          const resourceType = request.resourceType();
          if (resourceType !== "xhr" && resourceType !== "fetch") return;

          if (apiRecorded >= DEBUG_TIMELINE_API_LIMIT) {
            apiDropped += 1;
            return;
          }

          apiRecorded += 1;
          record("api-response", {
            method: request.method(),
            status,
            path,
            resourceType,
          });
        } catch {
          // Diagnostics must never change the outcome being diagnosed.
        }
      };

      watchedPage = page;
      page.on("response", onResponse);
    },

    markStartupSettled(signal: string) {
      startupSignal = signal;
      record("startup-settled", { signal });
    },

    onIndicatorSettled(selector: string | null) {
      indicatorRaceRan = true;

      if (selector === null) {
        record("indicator-timeout", {
          probeTimeoutMs: INTELLICAR.PROBE_TIMEOUT_MS,
          candidates: INTELLICAR.AUTHENTICATED_INDICATOR.length,
        });
        return;
      }

      record("indicator-visible", { selector, engine: selectorEngine(selector) });
    },

    result(value: ProbeResult) {
      probeResult = value;
      return value;
    },

    finish() {
      try {
        if (watchedPage !== null && onResponse !== null) {
          watchedPage.off("response", onResponse);
        }

        record("probe-finished", {
          result: probeResult ?? "not recorded",
          // What the readiness gate settled on, restated at the end so the
          // verdict and the reason the probe started looking sit together.
          startupSignal: startupSignal ?? "not recorded",
          // Absent BOTH indicator entries, this says why: false means
          // `isAuthenticated` short-circuited on the login-URL guard and the
          // race never ran, so a missing indicator is not a slow render.
          indicatorRaceRan,
        });

        // Sorted rather than trusted: response events arrive from a listener,
        // and append order is only chronological if nothing ever interleaves.
        // The sort is stable, so equal timestamps keep their arrival order.
        const timeline = events
          .slice()
          .sort((first, second) => first.at - second.at)
          .map(({ at, ...rest }) => ({ atMs: at - startedAt, ...rest }));

        log.info(
          {
            startedAt: new Date(startedAt).toISOString(),
            probeTimeoutMs: INTELLICAR.PROBE_TIMEOUT_MS,
            totalMs: Date.now() - startedAt,
            apiResponsesDropped: apiDropped,
            timeline,
          },
          "DEBUG: probe timeline."
        );
      } catch {
        // Never let teardown of a diagnostic break the probe's own teardown.
      }
    },
  };
}

/**
 * Photograph the page at the instant the probe decides the session is expired.
 *
 * ## Why here and not after the fact
 *
 * The probe closes its page in a `finally`, so by the time a caller sees
 * `"expired"` the evidence is gone. This runs while the page is still open and
 * still holds whatever state produced the verdict — a half-rendered shell, a
 * spinner, a login form, or a fully rendered dashboard whose header simply does
 * not match the selector.
 *
 * ## Presence and visibility are asked separately
 *
 * `#headersearch` in the DOM but not visible is a RENDERING answer — the app got
 * there, the element exists, and PROBE_TIMEOUT_MS expired before it became
 * visible. Not in the DOM at all is a WRONG-PAGE or wrong-selector answer, which
 * no amount of waiting fixes. The two land in the same `"expired"`, and cost
 * completely different work.
 *
 * Read alongside the `startupSignal` in the timeline. A rendering answer paired
 * with `startup-complete` means the app finished starting and STILL did not show
 * the header within the budget — the one case where the budget itself is the
 * suspect. Paired with `unknown`, the readiness gate never got its signal, and
 * the endpoint in SESSION_VERIFY_PATH is what to check first.
 *
 * ## What crosses back from the page
 *
 * Booleans and counts. The body-text check is evaluated INSIDE the page so only
 * its result returns — the text of a portal page is exactly what must not reach
 * a log. The title is email-stripped and truncated; the screenshot masks the
 * credential fields, in case the probe landed on a login form.
 */
async function captureExpiredProbeDiagnostics(page: Page): Promise<void> {
  if (!DEBUG_CAPTURE_PROBE_EXPIRED) return;

  try {
    const rawUrl = page.url();

    // `count()` sees hidden nodes; `isVisible()` is what the indicator race
    // actually required. Asking both is the whole point.
    const indicator = page.locator(DEBUG_PRIMARY_INDICATOR);
    // -1 distinguishes "the selector itself failed" from "matched nothing".
    const indicatorCount = await indicator.count().catch(() => -1);
    const indicatorVisible =
      indicatorCount > 0
        ? await indicator.first().isVisible().catch(() => false)
        : false;

    // Case-sensitive `includes("Login")`, as specified. A page rendering
    // "LOGIN" or "log in" therefore reports false — read a false here as
    // "not this exact word", not as "no login screen".
    const bodyContainsLogin = await page
      .evaluate(() => (document.body?.innerText ?? "").includes("Login"))
      .catch(() => null);

    const readiness: Array<{ phrase: string; count: number; visible: boolean }> = [];

    for (const phrase of DEBUG_READINESS_PHRASES) {
      // Unquoted `text=` is a case-insensitive SUBSTRING match, which is what
      // "any element saying Loading" means. It also matches ancestors of the
      // matching node, so `count` is an upper bound rather than an element
      // tally — `visible` is the field to read.
      const all = page.locator(`text=${phrase}`);
      const count = await all.count().catch(() => -1);

      let visible = false;
      const scan = Math.min(Math.max(count, 0), DEBUG_READINESS_SCAN_LIMIT);

      for (let index = 0; index < scan; index += 1) {
        if (await all.nth(index).isVisible().catch(() => false)) {
          visible = true;
          break;
        }
      }

      readiness.push({ phrase, count, visible });
    }

    log.error(
      {
        title: stripEmails(await page.title().catch(() => "")).slice(0, DEBUG_TEXT_LIMIT),
        url: safeUrl(rawUrl),
        stillOnLoginUrl: isLoginUrl(rawUrl),
        onAuthHost: isAuthHostUrl(rawUrl),
        bodyContainsLogin,
        // Named for the role, not the selector: the primary indicator is a
        // constant that can change, and a field called `headersearch` reporting
        // on `#pac-input` would be a diagnostic that lies about itself.
        indicator: DEBUG_PRIMARY_INDICATOR,
        indicatorInDom: indicatorCount > 0,
        indicatorCount,
        indicatorVisible,
        readiness,
      },
      "DEBUG: probe about to report expired — DOM state."
    );

    const directory = authEnv().SESSION_STORE_DIR;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, DEBUG_PROBE_SCREENSHOT_FILENAME);

    await page.screenshot({
      path,
      fullPage: true,
      // Same masking as the login-failure capture: if the probe landed on a
      // form, the fields must not be photographed.
      mask: [
        page.locator(INTELLICAR.EMAIL_INPUT.join(", ")),
        page.locator(INTELLICAR.PASSWORD_INPUT.join(", ")),
      ],
    });

    log.error({ path }, "DEBUG: expired-probe screenshot saved.");
  } catch (error) {
    // Diagnostics must never change the outcome being diagnosed.
    log.warn({ err: error }, "DEBUG: failed to capture the expired-probe DOM state.");
  }
}

/* --------------------------- end temporary block -------------------------- */

/** Result of attempting a login. */
export type AuthOutcome =
  | { ok: true }
  | { ok: false; code: AuthFailureCode; cause?: unknown };

export type AuthFailureCode =
  /** The portal rejected the credentials. Do not retry until they change. */
  | "INVALID_CREDENTIALS"
  /** MFA/OTP/CAPTCHA present. Silent authentication is impossible. */
  | "CHALLENGE_REQUIRED"
  /** The portal could not be reached: DNS, TLS, timeout, 5xx. Retryable. */
  | "PORTAL_UNREACHABLE"
  /** The page loaded but did not match any known state — likely a changed selector. */
  | "UNEXPECTED_PAGE";

/** Outcome of probing an already-stored session. */
export type ProbeResult = "valid" | "expired" | "unreachable";

function loginUrl(): string {
  return `${authEnv().INTELLICAR_BASE_URL}${INTELLICAR.LOGIN_PATH}`;
}

function probeUrl(): string {
  return `${authEnv().INTELLICAR_BASE_URL}${INTELLICAR.DASHBOARD_PATH}`;
}

function isLoginUrl(url: string): boolean {
  return INTELLICAR.LOGIN_URL_MARKERS.some((marker) => url.includes(marker));
}

/**
 * "We are back on the portal itself, not on the auth host."
 *
 * The final step of the login flow is a redirect from the auth origin back to
 * INTELLICAR_BASE_URL; both conditions are required because the auth host also
 * serves paths under its own origin that would otherwise satisfy the first.
 */
function isPortalUrl(url: string): boolean {
  return url.startsWith(authEnv().INTELLICAR_BASE_URL) && !isLoginUrl(url);
}

/**
 * Wait for whichever of several candidate elements appears first, and return the
 * locator that won.
 *
 * Each selector is raced INDEPENDENTLY rather than joined into one
 * comma-separated selector. That is deliberate and was a bug once: Playwright's
 * `text="..."` and `xpath=...` forms are separate selector engines, not CSS, so
 * joining them into a CSS union produces an invalid selector that fails as a
 * whole — silently turning a rejected login into "no recognisable outcome".
 *
 * Racing separately means every entry in the constants block may use ANY
 * Playwright selector syntax, and a single bad entry costs only itself instead
 * of disabling its whole group. That matters for a block designed to be edited
 * by whoever has the real portal in front of them.
 *
 * `Promise.any` settles on the first FULFILLED promise and ignores rejections,
 * so candidates that time out neither decide the race nor surface as unhandled
 * rejections.
 */
/**
 * Build the locator for one candidate selector.
 *
 * With `requireText`, only elements holding non-empty visible text qualify. The
 * filter is applied BEFORE `.first()` on purpose: filtering after it would take
 * the first matching element and then reject it, so a page whose first
 * `[role="alert"]` is empty would never see a later, real one.
 */
function candidateLocator(
  page: Page,
  selector: string,
  requireText: boolean
): Locator {
  const all = page.locator(selector);
  // /\S/ — at least one non-whitespace character.
  return (requireText ? all.filter({ hasText: /\S/ }) : all).first();
}

/**
 * As `firstVisible`, but also reports WHICH selector won the race.
 *
 * `firstVisible` is a wrapper over this, so the two can never disagree about
 * which element was chosen. The winning selector is used for the temporary
 * debug trace only; nothing branches on it.
 */
async function firstVisibleMatch(
  page: Page,
  selectors: readonly string[],
  timeout: number,
  requireText = false
): Promise<{ locator: Locator; selector: string } | null> {
  try {
    return await Promise.any(
      selectors.map(async (selector) => {
        const locator = candidateLocator(page, selector, requireText);
        await locator.waitFor({ state: "visible", timeout });
        return { locator, selector };
      })
    );
  } catch {
    // AggregateError: nothing appeared within the timeout.
    return null;
  }
}

async function firstVisible(
  page: Page,
  selectors: readonly string[],
  timeout: number,
  requireText = false,
  /**
   * TODO(debug): notified with the winning selector, or null if nothing became
   * visible in time. Purely an observer — the return value is unaffected.
   */
  onSettled?: (selector: string | null) => void
): Promise<Locator | null> {
  const match = await firstVisibleMatch(page, selectors, timeout, requireText);
  onSettled?.(match?.selector ?? null); // TODO(debug): remove
  return match?.locator ?? null;
}

/** As `firstVisible`, across several labelled groups; returns the winning label. */
async function firstMatch<TCode extends string>(
  page: Page,
  groups: ReadonlyArray<{
    code: TCode;
    selectors: readonly string[];
    /** Match these selectors only when they hold non-empty visible text. */
    requireText?: boolean;
  }>,
  timeout: number,
  /** TODO(debug): when set, every candidate's outcome is logged under this name. */
  debugScope?: string
): Promise<TCode | null> {
  try {
    return await Promise.any(
      groups.flatMap((group) =>
        group.selectors.map(async (selector) => {
          const startedAt = Date.now(); // TODO(debug): remove

          try {
            await candidateLocator(page, selector, group.requireText ?? false).waitFor({
              state: "visible",
              timeout,
            });
          } catch (error) {
            // TODO(debug): remove — rethrown unchanged, so the race is unaffected.
            if (debugScope !== undefined) {
              await traceCandidate(
                debugScope,
                page,
                group.code,
                selector,
                "timeout",
                Date.now() - startedAt,
                error
              );
            }
            throw error;
          }

          // TODO(debug): remove.
          if (debugScope !== undefined) {
            await traceCandidate(
              debugScope,
              page,
              group.code,
              selector,
              "visible",
              Date.now() - startedAt
            );
          }

          return group.code;
        })
      )
    );
  } catch {
    return null;
  }
}

/**
 * As `firstMatch`, but watching SEVERAL pages at once and returning whichever
 * one produces a verdict first.
 *
 * Required by the popup flow, not a generalisation for its own sake. The
 * authenticated indicator can only ever appear on the portal page, while a
 * rejection message can only ever appear on the auth page — so a race confined
 * to one page can see at most half of the possible outcomes, and would report a
 * refused password as an unrecognised page.
 *
 * Every group is tried on every page: a page simply never matches the groups
 * that do not belong to it. Pages that close mid-race (the auth popup does
 * exactly that on success) reject rather than resolve, and `Promise.any`
 * ignores them.
 */
async function firstMatchAcross<TCode extends string>(
  pages: readonly Page[],
  groups: ReadonlyArray<{
    code: TCode;
    selectors: readonly string[];
    requireText?: boolean;
  }>,
  timeout: number,
  /** TODO(debug): when set, every candidate on every page is logged. */
  debugScope?: string
): Promise<TCode | null> {
  try {
    return await Promise.any(
      pages.map(async (page, index) => {
        const code = await firstMatch(
          page,
          groups,
          timeout,
          // TODO(debug): remove the argument, not the call.
          debugScope === undefined ? undefined : `${debugScope}[page ${index}]`
        );
        // firstMatch reports "nothing matched" as null; convert it to a
        // rejection so it loses the race instead of winning it with a non-answer.
        if (code === null) throw new Error(`no match on page ${index}`);
        return code;
      })
    );
  } catch (error) {
    // TODO(debug): remove — `error` was previously discarded.
    if (debugScope !== undefined) traceNoVerdict(debugScope, error);
    return null;
  }
}

/**
 * The single definition of "this page is authenticated", used by both the login
 * flow and the session probe — so a session can never be considered valid by
 * one and invalid by the other.
 *
 * Two conditions, both required: we are not on the login screen, AND an
 * authenticated-only element is visible. The URL check alone would be fooled by
 * a portal that renders the login form at the dashboard path; the element check
 * alone would be fooled by a nav bar shared with the login page.
 */
export async function isAuthenticated(
  page: Page,
  timeout: number = INTELLICAR.PROBE_TIMEOUT_MS,
  /**
   * TODO(debug): observer for which indicator won and when. Never called when
   * the login-URL guard above short-circuits, which is itself the signal that
   * the race did not run.
   */
  onIndicatorSettled?: (selector: string | null) => void
): Promise<boolean> {
  if (isLoginUrl(page.url())) return false;

  const indicator = await firstVisible(
    page,
    INTELLICAR.AUTHENTICATED_INDICATOR,
    timeout,
    // TODO(debug): `false` is the existing default for `requireText`, restated
    // only because the observer parameter sits after it. Not a behaviour change.
    false,
    onIndicatorSettled
  );

  return indicator !== null;
}

/** The host that serves both the portal and its API. */
function portalHost(): string {
  // INTELLICAR_BASE_URL is validated as an http(s) URL in src/lib/env.ts, so
  // this cannot throw on a configured deployment.
  return new URL(authEnv().INTELLICAR_BASE_URL).hostname;
}

/**
 * What ended the wait for the application to finish starting up.
 *
 * None of these is a verdict about the session. They say only that there is no
 * longer any point in waiting — `isAuthenticated` still decides.
 */
type StartupSignal =
  /** Session verified, and the app has begun using it. The dashboard is coming. */
  | "startup-complete"
  /** The app itself says the session is no good, or it has left for the login screen. */
  | "not-authenticated"
  /** The dashboard is already on screen; there was nothing to wait for. */
  | "already-rendered"
  /** Nothing conclusive arrived in time. Judge the page as it stands. */
  | "unknown";

/**
 * Watches one probe navigation for the application's own startup milestones.
 *
 * The listener must be attached BEFORE the navigation. The verification call is
 * issued by the bundle a moment after DOMContentLoaded, and a `waitForResponse`
 * entered afterwards can lose that race and then wait for a response that has
 * already been and gone — which is the same class of bug this whole change is
 * about.
 *
 * Nothing here is logged: this is the production path, the URLs it inspects
 * belong to authenticated API calls, and the temporary debug block already
 * traces the same traffic under its own flags.
 */
interface StartupWatcher {
  /** Resolves once the app has verified the session AND started using it. */
  readonly completed: Promise<void>;
  /** Resolves if the verification call itself refuses the restored session. */
  readonly refused: Promise<void>;
  dispose(): void;
}

function watchAppStartup(page: Page): StartupWatcher {
  // Promise executors run synchronously, so both are assigned before use.
  let markCompleted: () => void = () => {};
  let markRefused: () => void = () => {};

  const completed = new Promise<void>((resolve) => {
    markCompleted = resolve;
  });
  const refused = new Promise<void>((resolve) => {
    markRefused = resolve;
  });

  const apiHost = portalHost();

  /** Set by the verification response; gates everything after it. */
  let verified = false;

  const onResponse = (response: PlaywrightResponse) => {
    try {
      const status = response.status();
      const url = new URL(response.url());

      if (url.pathname.toLowerCase().includes(INTELLICAR.SESSION_VERIFY_PATH)) {
        // Only a 200 counts as verified. Anything else is the portal declining
        // the restored cookies, which is worth stopping the wait for — though
        // it is still `isAuthenticated` that turns it into a verdict.
        if (status === 200) verified = true;
        else markRefused();
        return;
      }

      // "Authenticated API traffic" means all four of: after verification, on
      // the portal's own host, issued by the application rather than by the
      // document, and actually successful. A subresource, a third-party call or
      // a failed request cannot stand in for the app using its session.
      if (!verified) return;
      if (url.hostname !== apiHost) return;

      const resourceType = response.request().resourceType();
      if (resourceType !== "xhr" && resourceType !== "fetch") return;
      // 2xx only. A redirect hop on an authenticated XHR is more likely to be
      // the start of a bounce to the auth host than proof of a working session,
      // and Playwright reports each hop as its own response.
      if (status < 200 || status >= 300) return;

      markCompleted();
    } catch {
      // An unparseable URL says nothing about readiness, and a listener must
      // never be the thing that breaks the probe it is helping.
    }
  };

  page.on("response", onResponse);

  return {
    completed,
    refused,
    dispose: () => {
      page.off("response", onResponse);
    },
  };
}

/**
 * Wait for the portal application to finish starting up, so that the session
 * verdict is taken against a settled page rather than a booting one.
 *
 * ## Why this exists
 *
 * `page.goto(..., { waitUntil: "domcontentloaded" })` resolves when the shell
 * HTML has been parsed. For this portal that is several steps before the app
 * knows anything about the session: the bundle still has to execute, POST
 * `SESSION_VERIFY_PATH`, fetch its startup data, and only then render the
 * header that AUTHENTICATED_INDICATOR matches. Asking for that header straight
 * after DOMContentLoaded spends the indicator's whole budget on the boot and
 * reports "expired" for a session the portal had already accepted — with the
 * successful verification and the successful authenticated XHRs sitting in the
 * probe's own network trace, unread.
 *
 * ## Why the application's sequence and not `networkidle`
 *
 * `networkidle` is a statement about sockets, not about this app. A fleet portal
 * holds map tiles, polling and telemetry streams open, so idle may arrive late
 * or never; and it says nothing about whether the session was accepted. The
 * verification call and the authenticated XHRs that follow it are the
 * application's own statement that its startup got past authentication.
 *
 * ## Why it cannot manufacture a valid session
 *
 * This function returns no verdict and is not consulted for one. Every branch
 * leads to the same `isAuthenticated` call, which still requires a non-login URL
 * AND a visible authenticated-only element. Observing a 200 makes the probe look
 * LATER; it can never make it decide YES.
 *
 * ## Why it stays fast
 *
 * All four outcomes race, each bounded by the same PROBE_TIMEOUT_MS the probe
 * already used, and the first one wins:
 *
 *   - the startup sequence completing (the common path, and as fast as the app);
 *   - the app refusing the session, or navigating to the login screen — so an
 *     expired session is not made to sit out a readiness wait it can never pass;
 *   - the dashboard already being on screen, which covers any build that renders
 *     without a verification call this recognises;
 *   - nothing conclusive, in which case the page is judged exactly as it is
 *     today.
 *
 * No fixed sleep and no new timeout value: the bounds are Playwright's own, set
 * to a constant the probe already had.
 */
async function waitForAppStartup(
  page: Page,
  watcher: StartupWatcher,
  timeout: number
): Promise<StartupSignal> {
  return await Promise.race<StartupSignal>([
    watcher.completed.then((): StartupSignal => "startup-complete"),
    watcher.refused.then((): StartupSignal => "not-authenticated"),

    // Resolves immediately if the app has ALREADY been bounced to the login
    // screen. Its timeout rejection is caught rather than allowed to reject the
    // race — "no bounce happened" is not an error.
    page
      .waitForURL((url) => isLoginUrl(url.toString()), { timeout })
      .then((): StartupSignal => "not-authenticated")
      .catch((): StartupSignal => "unknown"),

    // Doubles as the deadline for the whole race: it resolves to null exactly at
    // `timeout`, which is what makes a separate timer unnecessary.
    firstVisibleMatch(page, INTELLICAR.AUTHENTICATED_INDICATOR, timeout).then(
      (match): StartupSignal => (match === null ? "unknown" : "already-rendered")
    ),
  ]);
}

/**
 * Check whether a restored context still holds a live session.
 *
 * Returns three states, not two, on purpose. "The portal is down" must not be
 * reported as "the session expired": that would discard a perfectly good stored
 * session and trigger a login that is equally doomed. `unreachable` leaves the
 * stored session untouched.
 */
export async function probeSession(
  context: BrowserContext
): Promise<ProbeResult> {
  // TODO(debug): remove. Runs before the first navigation, so the jar it
  // reports is purely what the restored storageState produced — nothing the
  // portal has set yet. Awaited rather than fired-and-forgotten so the line
  // cannot land in the log after the probe verdict it is meant to explain.
  await captureProbeCookies(context);

  const page = await context.newPage();

  // Attached BEFORE the first navigation, and detached in the `finally` below.
  // The application's verification call can land while the probe is still
  // between statements, and a watcher armed afterwards would wait for a response
  // that has already passed.
  const startup = watchAppStartup(page);

  // TODO(debug): remove. Attached before the first navigation and detached in
  // the `finally` below, so it observes this probe's traffic and nothing else.
  const stopNetworkTrace = traceProbeNetwork(page);

  // TODO(debug): remove. Started before the navigation so its clock covers the
  // whole probe, and attached to the same page so the verifytoken response is
  // observed rather than inferred.
  const timing = traceProbeTiming();
  timing.attach(page);

  try {
    const response = await page.goto(probeUrl(), {
      waitUntil: "domcontentloaded",
    });

    timing.markDomContentLoaded(); // TODO(debug): remove

    // A 5xx is the portal failing, not the session expiring. A 401/403, by
    // contrast, is exactly an expired session.
    if (response && response.status() >= 500) {
      log.warn({ status: response.status() }, "Portal returned a server error during probe.");
      return timing.result("unreachable"); // TODO(debug): identity wrapper.
    }

    // Synchronise with the APPLICATION, not with the browser. Until this
    // resolves, the page is a shell that has not yet decided anything about the
    // session, and an indicator race run against it would be measuring the boot.
    // This does not judge the session; it only decides when judging is possible.
    const startupSignal = await waitForAppStartup(
      page,
      startup,
      INTELLICAR.PROBE_TIMEOUT_MS
    );

    timing.markStartupSettled(startupSignal); // TODO(debug): remove

    log.info({ startupSignal }, "Portal startup settled; evaluating the session.");

    // TODO(debug): `PROBE_TIMEOUT_MS` restated and the observer appended. The
    // timeout is the same value the parameter already defaulted to, so the wait
    // is unchanged — it is passed only to reach the parameter after it.
    const authenticated = await isAuthenticated(
      page,
      INTELLICAR.PROBE_TIMEOUT_MS,
      (selector) => timing.onIndicatorSettled(selector)
    );

    // TODO(debug): remove. Runs before the return, while the `finally` below
    // has not yet closed the page — so this is the DOM exactly as the verdict
    // saw it, not a reconstruction.
    if (!authenticated) await captureExpiredProbeDiagnostics(page);

    return timing.result(authenticated ? "valid" : "expired");
  } catch (error) {
    // A navigation error is a transport failure; treat it as such.
    log.warn({ err: error }, "Session probe could not reach the portal.");
    return timing.result("unreachable"); // TODO(debug): identity wrapper.
  } finally {
    timing.finish(); // TODO(debug): remove — emits the single summary.
    stopNetworkTrace(); // TODO(debug): remove — detaches before the page closes.
    startup.dispose();
    await page.close().catch(() => {});
  }
}

/**
 * Fill the first candidate field that appears, or throw if none does.
 *
 * `fill` is used rather than `type` because it sets the value directly instead
 * of dispatching per-character key events — faster, and it keeps the secret out
 * of a long sequence of individually logged CDP messages when Playwright
 * tracing is enabled.
 *
 * The thrown message names the FIELD, never the value.
 */
async function fillField(
  page: Page,
  field: string,
  selectors: readonly string[],
  value: string,
  timeout: number
): Promise<void> {
  const match = await firstVisibleMatch(page, selectors, timeout);

  if (match === null) {
    throw new Error(`No ${field} field matched any known selector.`);
  }

  traceSelector(field, match.selector); // TODO(debug): remove

  await match.locator.fill(value);
}

/**
 * Click the first candidate control that becomes visible, or throw if none does.
 *
 * Waits for visibility rather than presence, and never sleeps: a control that is
 * in the DOM but not yet interactive is not a control we can click.
 */
async function clickControl(
  page: Page,
  control: string,
  selectors: readonly string[],
  timeout: number
): Promise<void> {
  const match = await firstVisibleMatch(page, selectors, timeout);

  if (match === null) {
    throw new Error(`No ${control} control matched any known selector.`);
  }

  traceSelector(control, match.selector); // TODO(debug): remove

  await match.locator.click();
}

/**
 * Perform a login in the given context.
 *
 * The context must be fresh — no restored storage state — so that a stale
 * cookie cannot make a failed login look successful. On success, the context
 * holds the authenticated session and the caller is responsible for persisting
 * `context.storageState()`.
 *
 * The credential is used inside this function and never stored, logged, or
 * returned.
 */
export async function authenticate(
  context: BrowserContext,
  credential: IntellicarCredential
): Promise<AuthOutcome> {
  const page = await context.newPage();
  const startedAt = Date.now();

  /**
   * The page the credential form is on, once it is known to be a separate one.
   *
   * Null means the form is on `page` itself. Declared out here so the popup is
   * closed on every exit path, and so the verdict race can watch it.
   */
  let authPage: Page | null = null;

  try {
    try {
      await page.goto(loginUrl(), { waitUntil: "domcontentloaded" });
    } catch (error) {
      log.warn({ err: error }, "Could not open the Intellicar login page.");
      return { ok: false, code: "PORTAL_UNREACHABLE", cause: error };
    }

    const formTimeout = INTELLICAR.PROBE_TIMEOUT_MS;
    const navTimeout = INTELLICAR.VERDICT_TIMEOUT_MS;

    // The portal serves no form at LOGIN_PATH. The flow is: landing page →
    // click Login → auth host /signin/identifier (email, Next) →
    // /signin/challenge (password, Next) → back to the portal.
    //
    // Every step waits on a URL or an element, never on a fixed duration.
    traceStep(page, "landing-loaded"); // TODO(debug): remove

    try {
      // 1–3. Landing page loaded is proven by the Login control being visible.
      //
      // Login opens the auth host in a NEW page. The listener is armed BEFORE
      // the click, not after: the page event fires during `click()`, and a
      // listener attached afterwards would miss it and fall back to the
      // same-tab path against a tab that never navigates.
      const opened = context
        .waitForEvent("page", { timeout: navTimeout })
        .catch(() => null);

      await clickControl(page, "login", INTELLICAR.LOGIN_BUTTON, formTimeout);
      traceStep(page, "login-clicked"); // TODO(debug): remove

      // Whichever happens first decides where the form is. Racing the two
      // instead of assuming a popup means the flow still works if the portal
      // reverts to navigating in place, and costs no extra wait when it does:
      // the same-tab branch resolves as soon as the opener reaches the
      // identifier URL.
      authPage = await Promise.race([
        opened,
        page
          .waitForURL(INTELLICAR.IDENTIFIER_URL, { timeout: navTimeout })
          .then(() => null)
          .catch(() => null),
      ]);

      // From here to the password submit, every step is on the auth page.
      const formPage = authPage ?? page;

      if (authPage === null) {
        log.warn("Login did not open a separate auth page; continuing in the portal tab.");
      }

      // 4. Redirect to the auth host. A popup starts at about:blank, so this
      // waits for its first real navigation rather than assuming it has landed.
      await formPage.waitForURL(INTELLICAR.IDENTIFIER_URL, { timeout: navTimeout });
      traceStep(formPage, "identifier-step-reached"); // TODO(debug): remove

      // A challenge on the identifier step means the flow cannot proceed at all,
      // and must not be misreported as a missing email field. Checked here
      // rather than on the landing page, which no longer carries the form.
      const challenge = await firstMatch(
        formPage,
        [{ code: "challenge", selectors: INTELLICAR.CHALLENGE_INDICATOR }],
        1_000
      );
      if (challenge !== null) {
        await captureChallengeDiagnostics(formPage); // TODO(debug): remove
        log.error("The Intellicar login page presented an interactive challenge.");
        return { ok: false, code: "CHALLENGE_REQUIRED" };
      }

      // 5–7. Identifier step. `fillField` waits for the field to be visible.
      await fillField(formPage, "email", INTELLICAR.EMAIL_INPUT, credential.email, formTimeout);
      await clickControl(
        formPage,
        "next (identifier step)",
        INTELLICAR.SUBMIT_BUTTON,
        formTimeout
      );
      traceStep(formPage, "next-1-clicked"); // TODO(debug): remove

      // 8–11. Challenge step.
      await formPage.waitForURL(INTELLICAR.CHALLENGE_URL, { timeout: navTimeout });
      traceStep(formPage, "password-step-reached"); // TODO(debug): remove

      await fillField(
        formPage,
        "password",
        INTELLICAR.PASSWORD_INPUT,
        credential.password,
        formTimeout
      );

      // Armed before the click for the same reason as the popup listener: on
      // success the auth page closes the moment the form is submitted.
      //
      // `Promise.any`, not `race`: a closing page makes `waitForURL` reject
      // with "target closed", and under `race` that rejection could beat the
      // close event and mislabel a perfectly good login.
      const settled = Promise.any([
        formPage.waitForEvent("close", { timeout: navTimeout }).then(() => "closed" as const),
        formPage
          .waitForURL((url) => isPortalUrl(url.toString()), { timeout: navTimeout })
          .then(() => "returned-to-portal" as const),
      ]).catch(() => "still-open" as const);

      await clickControl(
        formPage,
        "next (challenge step)",
        INTELLICAR.SUBMIT_BUTTON,
        formTimeout
      );
      traceStep(formPage, "next-2-clicked"); // TODO(debug): remove

      // Wait for the auth page to finish, then hand back to the portal tab.
      // Not conclusive on its own — "still-open" is also what a rejected
      // password looks like, and the verdict race is what tells them apart.
      const outcome = await settled;
      log.info({ outcome }, "Intellicar auth page settled.");
      traceStep(formPage, "auth-page-settled"); // TODO(debug): remove
    } catch (error) {
      // A step did not arrive: a changed selector or a changed redirect chain.
      // Not returned yet — a WRONG password also fails to reach the portal, and
      // the verdict race below is what tells those two apart. Falling through
      // keeps a rejection reported as INVALID_CREDENTIALS rather than as a
      // broken page.
      log.warn(
        // TODO(debug): remove `url` — the step where the flow stopped.
        { err: error, url: safeUrl(page.url()) },
        "Intellicar login flow did not complete its expected steps."
      );
    }

    // 12. Back on the portal. Absence here is not conclusive either: the verdict
    // race decides, and a rejection surfaces there.
    //
    // In the popup flow the portal tab never navigated, so this resolves at
    // once — the tab is authenticated in place by the auth page's redirect,
    // and step 13 below is what proves it.
    await page
      .waitForURL((url) => isPortalUrl(url.toString()), { timeout: navTimeout })
      .catch(() => {});

    traceStep(page, "final-redirect"); // TODO(debug): remove

    // 13. Race the states a submitted login can settle into, across both pages:
    // success appears on the portal tab, rejection on the auth page. Whichever
    // renders first decides, so a rejected login is reported immediately rather
    // than after the full timeout.
    traceVerdictWatch(page, authPage); // TODO(debug): remove

    const verdict = await firstMatchAcross(
      authPage === null || authPage.isClosed() ? [page] : [page, authPage],
      [
        { code: "authenticated", selectors: INTELLICAR.AUTHENTICATED_INDICATOR },
        { code: "rejected", selectors: INTELLICAR.LOGIN_ERROR_TEXT },
        {
          code: "rejected",
          selectors: INTELLICAR.LOGIN_ERROR_CONTAINER,
          requireText: true,
        },
        { code: "challenge", selectors: INTELLICAR.CHALLENGE_INDICATOR },
      ],
      INTELLICAR.VERDICT_TIMEOUT_MS,
      "verdict" // TODO(debug): remove this argument to silence the per-candidate log.
    );

    const elapsedMs = Date.now() - startedAt;

    // TODO(debug): remove with the rest of the debug block.
    // Diagnose the page the flow actually stopped on. A failure now lives on
    // the auth page whenever it is still open, and screenshotting the portal
    // tab instead would photograph a page with nothing wrong with it.
    const failurePage = authPage !== null && !authPage.isClosed() ? authPage : page;

    switch (verdict) {
      case "authenticated":
        // Confirm positively rather than trusting the indicator alone: a nav
        // element shared with the login screen would otherwise pass.
        if (isLoginUrl(page.url())) {
          log.error(
            { elapsedMs },
            "Authenticated indicator matched while still on the login page — check AUTHENTICATED_INDICATOR."
          );
          return { ok: false, code: "UNEXPECTED_PAGE" };
        }

        log.info({ elapsedMs }, "Intellicar authentication succeeded.");
        return { ok: true };

      case "rejected":
        log.error({ elapsedMs }, "Intellicar rejected the configured credentials.");
        await captureFailureDiagnostics(failurePage, "rejected"); // TODO(debug): remove
        return { ok: false, code: "INVALID_CREDENTIALS" };

      case "challenge":
        log.error({ elapsedMs }, "Intellicar presented an interactive challenge after submit.");
        await captureFailureDiagnostics(failurePage, "challenge"); // TODO(debug): remove
        return { ok: false, code: "CHALLENGE_REQUIRED" };

      case null:
      // `default` is unreachable — every verdict code has a case above — but
      // TypeScript stopped treating the switch as exhaustive once the race
      // moved to `firstMatchAcross`. Sharing the null branch rather than
      // returning bare keeps any future code logged instead of silent.
      // falls through
      default:
        // Nothing recognisable appeared. Most likely AUTHENTICATED_INDICATOR is
        // wrong — the placeholder problem this milestone documents — but it can
        // also be a portal that simply hung.
        log.error(
          { elapsedMs, url: isLoginUrl(page.url()) ? "login" : "other" },
          "Login produced no recognisable outcome; verify the portal selectors."
        );
        await captureFailureDiagnostics(failurePage, "no-match"); // TODO(debug): remove
        return { ok: false, code: "UNEXPECTED_PAGE" };
    }
  } finally {
    // The auth page belongs to the same context, so leaving it open would leak
    // a tab per login attempt. Closed independently of `page` so that a failure
    // to close one still closes the other. Closing a page does NOT discard the
    // context's cookies — the session the popup established survives it, which
    // is the whole point of both pages sharing one context.
    if (authPage !== null) await authPage.close().catch(() => {});
    await page.close().catch(() => {});
  }
}
