// TODO(debug): mkdir/join are used only by the temporary failure-capture block.
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { BrowserContext, Locator, Page } from "playwright";

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
  LOGIN_PATH: "/login",

  /**
   * TODO(intellicar): confirm the post-login landing path.
   * Used as the probe target for an existing session: it must be a page that
   * requires authentication and that redirects to the login page when the
   * session has expired. A heavy dashboard works but is slow; the lightest
   * authenticated page is the better choice once one is known.
   */
  DASHBOARD_PATH: "/ceo/intellicar",

  /**
   * Path fragments that mean "we are looking at the login screen".
   * Used both to detect a redirect back to login and as a negative check on a
   * claimed successful authentication.
   */
  LOGIN_URL_MARKERS: ["/login", "/signin", "/sign-in"],

  /**
   * TODO(intellicar): confirm the email field selector.
   * Candidates are tried as one CSS union, so an extra guess costs nothing;
   * narrow this to the real selector once known.
   */
  EMAIL_INPUT: [
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]',
    "#email",
    "#username",
  ],

  /** TODO(intellicar): confirm the password field selector. */
  PASSWORD_INPUT: ['input[type="password"]', 'input[name="password"]', "#password"],

  /** TODO(intellicar): confirm the submit control. */
  SUBMIT_BUTTON: [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Log in")',
    'button:has-text("Login")',
    'button:has-text("Sign in")',
  ],

  /**
   * TODO(intellicar): CONFIRM BEFORE PRODUCTION TESTING — this is the single
   * most important constant in the file.
   *
   * The positive proof of authentication. Per the Milestone 3 brief this is the
   * "Intellicar Dashboard" navigation link; the remaining candidates are
   * conventional fallbacks in case that text differs.
   *
   * It MUST be an element that appears ONLY when authenticated. A logo, a
   * footer, or anything also rendered on the login page would make a failed
   * login indistinguishable from a successful one — which is the failure mode
   * this whole design exists to prevent.
   */
  AUTHENTICATED_INDICATOR: [
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
   */
  CHALLENGE_INDICATOR: [
    'input[name="otp"]',
    'input[autocomplete="one-time-code"]',
    "iframe[src*='recaptcha']",
    ".g-recaptcha",
    'text="Verify your identity"',
  ],

  /**
   * How long to wait for a post-submit verdict. Kept below AUTH_TIMEOUT_MS so
   * the indicator race resolves before the overall action timeout fires.
   */
  VERDICT_TIMEOUT_MS: 15_000,

  /**
   * How long to wait for the authenticated indicator when probing an existing
   * session. Short on purpose: this runs on the common path, where the session
   * is valid and the element is already in the DOM.
   */
  PROBE_TIMEOUT_MS: 8_000,
} as const;

/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/*  TEMPORARY DEBUG CAPTURE — remove after the first successful real login     */
/*                                                                            */
/*  Diagnoses the placeholder selectors against the live portal. Delete this   */
/*  block, the `captureFailureDiagnostics` function, and its three call sites  */
/*  in `authenticate` (each marked TODO(debug)) to revert. Nothing else        */
/*  depends on it.                                                            */
/* -------------------------------------------------------------------------- */

/** Set to false to silence the capture without deleting it. */
const DEBUG_CAPTURE_LOGIN_FAILURE = true;

const DEBUG_SCREENSHOT_FILENAME = "login-failure.png";

/** Longest snippet of portal text worth putting in a log line. */
const DEBUG_TEXT_LIMIT = 300;

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

async function firstVisible(
  page: Page,
  selectors: readonly string[],
  timeout: number,
  requireText = false
): Promise<Locator | null> {
  try {
    return await Promise.any(
      selectors.map(async (selector) => {
        const locator = candidateLocator(page, selector, requireText);
        await locator.waitFor({ state: "visible", timeout });
        return locator;
      })
    );
  } catch {
    // AggregateError: nothing appeared within the timeout.
    return null;
  }
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
  timeout: number
): Promise<TCode | null> {
  try {
    return await Promise.any(
      groups.flatMap((group) =>
        group.selectors.map(async (selector) => {
          await candidateLocator(page, selector, group.requireText ?? false).waitFor({
            state: "visible",
            timeout,
          });
          return group.code;
        })
      )
    );
  } catch {
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
  timeout: number = INTELLICAR.PROBE_TIMEOUT_MS
): Promise<boolean> {
  if (isLoginUrl(page.url())) return false;

  const indicator = await firstVisible(
    page,
    INTELLICAR.AUTHENTICATED_INDICATOR,
    timeout
  );

  return indicator !== null;
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
  const page = await context.newPage();

  try {
    const response = await page.goto(probeUrl(), {
      waitUntil: "domcontentloaded",
    });

    // A 5xx is the portal failing, not the session expiring. A 401/403, by
    // contrast, is exactly an expired session.
    if (response && response.status() >= 500) {
      log.warn({ status: response.status() }, "Portal returned a server error during probe.");
      return "unreachable";
    }

    return (await isAuthenticated(page)) ? "valid" : "expired";
  } catch (error) {
    // A navigation error is a transport failure; treat it as such.
    log.warn({ err: error }, "Session probe could not reach the portal.");
    return "unreachable";
  } finally {
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
  const locator = await firstVisible(page, selectors, timeout);

  if (locator === null) {
    throw new Error(`No ${field} field matched any known selector.`);
  }

  await locator.fill(value);
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

  try {
    try {
      await page.goto(loginUrl(), { waitUntil: "domcontentloaded" });
    } catch (error) {
      log.warn({ err: error }, "Could not open the Intellicar login page.");
      return { ok: false, code: "PORTAL_UNREACHABLE", cause: error };
    }

    // A challenge on the login page itself means the flow cannot proceed at
    // all, and must not be misreported as a missing email field.
    const challenge = await firstMatch(
      page,
      [{ code: "challenge", selectors: INTELLICAR.CHALLENGE_INDICATOR }],
      1_000
    );
    if (challenge !== null) {
      log.error("The Intellicar login page presented an interactive challenge.");
      return { ok: false, code: "CHALLENGE_REQUIRED" };
    }

    const formTimeout = INTELLICAR.PROBE_TIMEOUT_MS;

    try {
      await fillField(page, "email", INTELLICAR.EMAIL_INPUT, credential.email, formTimeout);
      await fillField(
        page,
        "password",
        INTELLICAR.PASSWORD_INPUT,
        credential.password,
        formTimeout
      );
    } catch (error) {
      // The page loaded but has no field matching any candidate selector — the
      // portal's markup has changed, or LOGIN_PATH is wrong.
      log.error({ err: error }, "Login form fields were not found on the login page.");
      return { ok: false, code: "UNEXPECTED_PAGE", cause: error };
    }

    const submit = await firstVisible(page, INTELLICAR.SUBMIT_BUTTON, formTimeout);

    if (submit !== null) {
      await submit.click();
    } else {
      // Many login forms submit on Enter even without a matchable button, so
      // this is a genuine fallback rather than a guess.
      log.warn("No submit control matched; submitting the form with Enter instead.");
      const password = await firstVisible(page, INTELLICAR.PASSWORD_INPUT, 1_000);
      await password?.press("Enter");
    }

    // Race the three states a submitted login can settle into. Whichever
    // renders first decides, so a rejected login is reported immediately rather
    // than after the full timeout.
    const verdict = await firstMatch(
      page,
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
      INTELLICAR.VERDICT_TIMEOUT_MS
    );

    const elapsedMs = Date.now() - startedAt;

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
        await captureFailureDiagnostics(page, "rejected"); // TODO(debug): remove
        return { ok: false, code: "INVALID_CREDENTIALS" };

      case "challenge":
        log.error({ elapsedMs }, "Intellicar presented an interactive challenge after submit.");
        await captureFailureDiagnostics(page, "challenge"); // TODO(debug): remove
        return { ok: false, code: "CHALLENGE_REQUIRED" };

      case null:
        // Nothing recognisable appeared. Most likely AUTHENTICATED_INDICATOR is
        // wrong — the placeholder problem this milestone documents — but it can
        // also be a portal that simply hung.
        log.error(
          { elapsedMs, url: isLoginUrl(page.url()) ? "login" : "other" },
          "Login produced no recognisable outcome; verify the portal selectors."
        );
        await captureFailureDiagnostics(page, "no-match"); // TODO(debug): remove
        return { ok: false, code: "UNEXPECTED_PAGE" };
    }
  } finally {
    await page.close().catch(() => {});
  }
}
