# Intellicar Authentication — Setup & Runbook

Tarang reaches the Intellicar portal through an **internal** authentication layer: the AI agent cannot trigger a login, observe one, or reach a credential or cookie. This document is the operator runbook for it.

Architecture: SAD §8 (sessions), §9 (credentials), §10 (login flow), §11 (Playwright), and the Milestone 3 decisions in §19.

---

## 1. What this layer does

| Module | Responsibility |
|---|---|
| `src/services/credentials/credential-manager.ts` | The only reader of Intellicar credentials. Lends them for one login; never returns them. |
| `src/services/credentials/crypto.ts` | AES-256-GCM seal/open. Pure; the key is a parameter. |
| `src/services/session/playwright-manager.ts` | Chromium lifecycle. Launched on demand, cached on `globalThis`. |
| `src/services/session/session-store.ts` | The encrypted storageState on disk, plus its metadata. |
| `src/services/session/authenticator.ts` | The login flow, and **every Intellicar-specific URL and selector**. |
| `src/services/session/session-manager.ts` | **The only public entry point.** Reuse → validate → refresh → latch. |

Consumers call exactly one function:

```ts
import { withAuthenticatedContext } from "@/services/session/session-manager";

const rows = await withAuthenticatedContext(async (context) => {
  const page = await context.newPage();
  await page.goto(`${baseUrl}/some/module`);
  return extractSomething(page);      // Milestone 4 territory
});
```

The caller never knows whether a login happened. **Nothing in `src/tools/` or `src/agent/` may import this** — the boundary is enforced by `npm run lint` (see `eslint.config.mjs`).

---

## 2. Prerequisites

**Chromium.** `npm install` alone is not enough: npm 12 blocks package install scripts by default, so Playwright's browser download does not run.

```bash
npx playwright install chromium
```

In Docker this is unnecessary — the image builds on the Microsoft Playwright base (SAD §17), which ships browsers preinstalled.

**An encryption key.** 32 bytes, hex or base64:

```bash
openssl rand -hex 32
```

---

## 3. Configuration

Add to `.env.local` (gitignored — `.gitignore` covers `.env*`):

```
INTELLICAR_BASE_URL="https://portal.intellicar.example"
INTELLICAR_EMAIL="fleet-operator@yourcompany.com"
INTELLICAR_PASSWORD="…"
CREDENTIAL_ENCRYPTION_KEY="<openssl rand -hex 32 output>"

# Optional — defaults shown
SESSION_STORE_DIR=".sessions"
PLAYWRIGHT_HEADLESS="true"
AUTH_TIMEOUT_MS="30000"
```

| Variable | Notes |
|---|---|
| `INTELLICAR_BASE_URL` | Portal origin, no trailing slash (a trailing slash is stripped). |
| `INTELLICAR_EMAIL` / `INTELLICAR_PASSWORD` | Read only by the Credential Manager, only during a login. |
| `CREDENTIAL_ENCRYPTION_KEY` | Seals the stored session. Named as in SAD §16 because the same key will seal the credential vault when that lands. |
| `SESSION_STORE_DIR` | Holds `intellicar-session.json`. Add to `.gitignore` if you change it from the default. |
| `PLAYWRIGHT_HEADLESS` | Set `"false"` to watch a login in a real window while fixing selectors. |
| `AUTH_TIMEOUT_MS` | Ceiling for one login, including page loads. |

**These are validated lazily**, not at boot. A developer with no Intellicar access can still run the app, build it, and ask historical-telemetry questions; only an authentication attempt fails, and it fails with a message naming the missing variables. This is deliberate — see SAD §19 (Milestone 3).

**Changing credentials requires a restart.** `process.env` is read once per process, so editing `.env.local` takes effect on restart (`next dev` restarts itself). A restart also clears the failure latch described in §6.

---

## 4. Replacing the portal placeholders — DO THIS BEFORE PRODUCTION TESTING

Every Intellicar-specific value lives in one block, `INTELLICAR`, at the top of [`src/services/session/authenticator.ts`](../src/services/session/authenticator.ts). Each entry marked `TODO(intellicar)` is an **unverified guess** at conventional markup. Nothing else in the codebase needs to change.

Procedure:

1. Set `PLAYWRIGHT_HEADLESS="false"` so you can watch.
2. Open the real login page and inspect it. `npx playwright codegen <your-portal-url>` writes selectors for you.
3. Replace, in order of importance:

| Constant | What it must become | Why it matters |
|---|---|---|
| `AUTHENTICATED_INDICATOR` | **Validated** — `#pac-input` (dashboard places-autocomplete input; absent before login, created only once the dashboard has initialised) and `#intellicarSSODropWidget .ICSSOprofileDropdown` (populates from the authenticated identity). The unverified placeholders below them are kept as fallbacks only | **The most important constant in the system.** If it also matches on the login page, a failed login is indistinguishable from a successful one. |
| `DASHBOARD_PATH` | The lightest authenticated page that redirects to login when the session dies | Runs on every request as the validity probe; a heavy dashboard makes every question slower |
| `SESSION_VERIFY_PATH` | The call the portal's own SPA makes at startup to check the restored session — `/sso/verifytoken` on the live portal | The probe waits for this before judging the session. Wrong value ⇒ the probe falls back to judging a page that may still be booting (see the still-booting trap below) |
| `LOGIN_PATH` | The login form's path | Wrong value ⇒ `UNEXPECTED_PAGE` |
| `EMAIL_INPUT`, `PASSWORD_INPUT`, `SUBMIT_BUTTON` | The real field selectors | Candidates are tried in order; narrowing to the real one is faster and less fragile |
| `LOGIN_ERROR_TEXT` | The portal's real rejection wording | Turns "wrong password" into an immediate `INVALID_CREDENTIALS` instead of three slow failures (§6). Keep the wording specific — a loose pattern like `/invalid\|incorrect/i` would match help text on the login page and reject every attempt |
| `LOGIN_ERROR_CONTAINER` | The element that *holds* an error | Matched only when it contains non-empty visible text — see the trap below |
| `CHALLENGE_INDICATOR` | Believed unnecessary — the brief states there is no MFA/OTP/CAPTCHA | Safety net: if one ever appears, authentication stops loudly rather than looking like a broken selector |

Each candidate list is raced **selector by selector**, so any Playwright selector syntax works (`css=`, `text=`, `xpath=`, `:has-text()`), and one bad entry costs only itself. Do not join candidates with commas — `text=` is not CSS, and a joined string would be invalid as a whole.

### The hidden-alert trap — observed on the real portal

A bare `[role="alert"]` selector reported **every** login as `INVALID_CREDENTIALS`, including logins with correct credentials. The cause: a Next.js-based portal always renders a route announcer —

```html
<p id="__next-route-announcer__" role="alert" style="…height:1px;clip:rect(0 0 0 0)…"></p>
```

— which is sized 1px rather than `display:none`, so **Playwright counts it as visible**. Empty text and all, it won the verdict race instantly.

The fix has two parts, and both are necessary:

1. **`LOGIN_ERROR_CONTAINER` requires non-empty visible text**, via `.filter({ hasText: /\S/ })`. The filter is applied before `.first()`, so an empty first alert cannot hide a real second one.
2. **The announcer is excluded by id.** This is *not* redundant with (1): the announcer's purpose is to announce the new page title after a route change, so on a **successful** login it becomes a visible `role="alert"` element *containing text*. With only (1), success would race `rejected` against `authenticated` and fail intermittently.

Measured against a portal reproducing this markup:

| | login page | after successful login |
|---|---|---|
| `[role="alert"]` visible to Playwright | yes | yes |
| after non-empty-text filter | 0 matches | **1 match** |
| after announcer exclusion | 0 matches | 0 matches |

If you add a new container selector, prefer one specific to authentication, and assume it may be present-but-empty until proven otherwise.

### The still-booting trap — observed on the real portal

A probe reported `expired` for a session that was **completely valid**. The stored cookies restored, the portal answered `POST /sso/verifytoken` with a 200, and the app went straight on to authenticated XHRs (`getinfo`, `getmygroups`, …) that all succeeded — while the probe was already declaring the session dead.

The cause was the probe's own sequencing, not a selector. It navigated with `waitUntil: "domcontentloaded"` and then asked `isAuthenticated` immediately. On a SPA, `domcontentloaded` fires when the shell HTML is parsed — before the bundle executes. So the indicator race's `PROBE_TIMEOUT_MS` budget had to cover bundle execution, the verification round trip, the startup data fetches **and** the render, and when it did not, "the app is still initializing" came out as "authentication failed". The successful verification was sitting in the probe's own network trace, unread by the decision path.

The fix is `waitForAppStartup`, which runs between the navigation and `isAuthenticated`. It waits for the **application's** startup sequence — a 200 from `SESSION_VERIFY_PATH` followed by a successful authenticated XHR on the portal host — and only then starts the indicator clock.

Three properties worth keeping if you touch it:

1. **It never returns a verdict.** All four of its outcomes lead to the same `isAuthenticated` call, which still requires a non-login URL *and* a visible authenticated-only element. A readiness signal can make the probe look later; it can never make it answer yes.
2. **It does not delay a genuinely expired session.** A non-200 verification, or a bounce to the login screen, ends the wait at once — and `isAuthenticated`'s URL guard then answers immediately.
3. **It is not `networkidle`.** A fleet portal holds map tiles and telemetry streams open, so socket quiescence may arrive late or never, and says nothing about whether the session was accepted.

Read the `startup-settled` entry in the `DEBUG: probe timeline.` log line to see which of the four fired.

**If MFA turns out to exist**, silent re-authentication (SAD §10) is not achievable and this milestone's guarantee that "the user is never asked to log in again" no longer holds. The flow will report `CHALLENGE_REQUIRED`; escalate that as a design change rather than working around it.

---

## 5. First run

Authentication has no HTTP surface and no agent tool by design, so trigger it from a Node REPL inside the app's module graph, or from the Milestone 4 Portal Service once it exists:

```ts
import { ensureAuthenticatedSession, getSessionStatus }
  from "@/services/session/session-manager";

await ensureAuthenticatedSession();     // logs in if needed, saves, closes the browser
console.log(await getSessionStatus());
```

Expected sequence, visible in the logs (`LOG_LEVEL=debug` for detail):

1. `No stored Intellicar session; authenticating.`
2. `Chromium launched.`
3. `Intellicar authentication succeeded.`
4. `Encrypted session state saved.`
5. `Chromium closed.`

The second run should instead log `Reusing the stored Intellicar session.` and never launch a login.

---

## 6. Failure states

| Code | Meaning | Recovery |
|---|---|---|
| `NOT_CONFIGURED` | Variables missing or malformed | Fix `.env.local`, restart |
| `CREDENTIALS_REJECTED` | Portal rejected the credential, **or** the failure ceiling was hit | Fix the credential, restart. **Latched** — see below |
| `CHALLENGE_REQUIRED` | MFA/OTP/CAPTCHA encountered | Design change; not recoverable by retry |
| `PORTAL_UNREACHABLE` | DNS/TLS/timeout/5xx | Transient; retry. The stored session is **preserved** |
| `PORTAL_CHANGED` | Page loaded but matched no known state | Almost always a selector — see §4 |

**The latch.** After a rejected credential — or three consecutive failed sign-in attempts of any kind — authentication stops for the life of the process. No browser is launched and no request reaches the portal while latched. This exists to protect the Intellicar account from lockout: without it, every incoming request would drive another real sign-in attempt with a password the portal has already refused.

The ceiling is the backstop that does **not** depend on `LOGIN_ERROR` being correct. With that selector unverified, a wrong password may present as `PORTAL_CHANGED` rather than `CREDENTIALS_REJECTED` — the ceiling stops it either way, after at most three attempts.

Clear the latch with `invalidateSession()` or a restart.

---

## 7. Security notes

- **Credentials** come only from the environment, are read only by the Credential Manager, and are lent to the login flow for one call. No function returns them. They are never written to disk, never logged, and never placed in an error message.
- **The stored session is a live credential.** `intellicar-session.json` holds the storageState sealed with AES-256-GCM (fresh IV per write, purpose-bound AAD, key version recorded). Treat the file as equivalent to a password: it is gitignored, written owner-only, and never logged.
  - *Windows caveat:* the `0o600` file mode is honoured on Linux (the deployment target). Windows ignores POSIX modes, so on a dev machine the file inherits directory ACLs.
- **Key rotation.** Changing `CREDENTIAL_ENCRYPTION_KEY` makes the stored session unopenable; it is ignored and replaced by a fresh login. No manual cleanup needed.
- **Logging.** `src/lib/logger.ts` redacts credential, cookie, token, storageState and authorization fields. Redaction matches field *paths*, not free text — so never interpolate a secret into a message string, and never log page content or a whole Playwright object.
- **Nothing authentication-related is agent-reachable.** No tool, no registry entry, no prompt text. Error messages crossing outward carry a code and a generic sentence, never a URL, selector, or credential — this matters because the Tool Registry copies error text into the model's context.

---

## 8. What this document is not

Not a portal scraping guide. Extraction, dashboard modules, and normalisation are Milestone 4 (SAD §11). This layer's only job is to hand a caller an authenticated browser context.
