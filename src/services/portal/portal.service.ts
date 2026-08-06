import type { BrowserContext, Page } from "playwright";
import type { z } from "zod";

import { authEnv } from "@/lib/env";
import { childLogger } from "@/lib/logger";
import { occurrenceId, reportStage } from "@/lib/run-progress";
import {
  SessionError,
  withAuthenticatedContext,
} from "@/services/session/session-manager";

import { batteryAnalyticsCapability } from "./extractors/battery-analytics";
import { fleetOverviewCapability } from "./extractors/fleet-overview";
import { vehicleSummaryCapability } from "./extractors/vehicle-summary";
import {
  normalizeVehicleNo,
  type BatteryAnalytics,
  type FleetOverview,
  type Normalizer,
  type VehicleSummary,
} from "./normalizers";

/**
 * Portal Service (SAD §4, §11 — Milestone 4A).
 *
 * THE ONLY COMPONENT THAT TALKS TO INTELLICAR. It is also the only caller of
 * `withAuthenticatedContext()`: authentication ownership stays entirely inside
 * the Session Manager, and this service is the single consumer that asks it for
 * a ready browser context (Milestone 3's session-manager.ts header names this
 * module as its one expected caller).
 *
 * ## What Milestone 4A is
 *
 * Structure and contracts. There are no extractors, no normalizers and no
 * registered capabilities yet, so `fetchPortalModule()` currently reports every
 * module as unavailable. What exists is the seam each capability slots into, and
 * the one place the read → normalise → validate chain is composed. Fleet
 * Overview — the first live capability — arrives next, as one file under
 * extractors/, one normalizer plus schema in normalizers.ts, and one line in
 * CAPABILITIES below.
 *
 * ## The four roles, and why they are four
 *
 *   - EXTRACTORS read a rendered page and return raw structure. They touch
 *     Playwright and nothing else — no service, no database, no agent.
 *   - NORMALIZERS turn that raw structure into the agreed shape. Pure functions;
 *     they never see a `Page` (see normalizers.ts).
 *   - ZOD validates the normalised output, so a silently changed dashboard
 *     becomes a clean failure instead of a plausible wrong number reaching the
 *     model.
 *   - THIS SERVICE navigates, waits for readiness, and composes the three. It is
 *     the only part that holds a browser context.
 *
 * The split is enforced mechanically by the Portal zone in eslint.config.mjs.
 *
 * ## What never crosses the tool boundary
 *
 * No Playwright type leaves this module. `fetchPortalModule()` takes plain data
 * and returns validated JSON, so src/tools/portal.tool.ts — and therefore the
 * agent — can never hold a page, a context or a cookie (CLAUDE.md rule 1). The
 * `Page` in `Extractor` below travels INWARD only.
 */

const log = childLogger("portal");

/**
 * How long one navigation to a module may take.
 *
 * A named constant rather than an environment variable, matching
 * TOOL_TIMEOUT_MS: this is an architectural budget, not a per-deployment knob.
 * It is deliberately NOT AUTH_TIMEOUT_MS — that variable paces authentication,
 * and the telemetry path should not be governed by authentication
 * configuration. `withContext` sets AUTH_TIMEOUT_MS as the context default;
 * every wait below states its own, so the default never silently applies here.
 */
const PORTAL_NAV_TIMEOUT_MS = 30_000;

/**
 * How long to wait for a module's data to actually render after navigation.
 *
 * Sized from the live dashboard: a cold load of this SPA resolves
 * DOMContentLoaded at ~5s and settles its startup at ~8s, with the fleet counts
 * arriving after that. 20s leaves real headroom without letting a hung module
 * consume the whole tool budget.
 */
const PORTAL_READY_TIMEOUT_MS = 20_000;

/**
 * How long a TARGETED module's resolution phase may take in total
 * (Milestone 4C).
 *
 * Bounds the whole phase, not a step inside it: a resolver opens a view and may
 * page a table, and capping only the individual actions would let a pager with
 * many pages multiply into an unbounded phase. A capability may still hold
 * stricter per-step budgets of its own — the Vehicle Summary module does — which
 * is the internal-SLA case SAD §19 keeps separate from an outer ceiling.
 *
 * The three phase budgets are sized to fit inside PORTAL_TOOL_TIMEOUT_MS (90s)
 * with room to spare: 30s navigation + 35s resolution + 20s readiness = 85s. A
 * COLD run that must also sign in can still exceed the tool budget; that is
 * accepted rather than designed away, because the Session Manager persists the
 * session before running this work, so the login a timed-out first request paid
 * for is saved and the retry takes the reuse path.
 */
const PORTAL_RESOLVE_TIMEOUT_MS = 35_000;

/* -------------------------------------------------------------------------- */
/*  Public contract                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The seven Intellicar dashboard modules (SAD §11).
 *
 * The full vocabulary is declared here because it is the architecture's, not
 * one milestone's. Which of them can actually be fetched is a separate
 * question, answered by CAPABILITIES: a module named here but not registered
 * there fails as MODULE_UNAVAILABLE rather than pretending.
 */
export const PORTAL_MODULES = [
  "fleet_overview",
  "vehicle_summary",
  "battery_analytics",
  "fleet_activity",
  "health_analytics",
  "alerts_rules",
  "device_management",
  "database_health",
] as const;

export type PortalModule = (typeof PORTAL_MODULES)[number];

/**
 * Everything a registered capability can return.
 *
 * Declared now that there is more than one member, as the note on
 * `fetchPortalModule` said it would be: a union costs nothing while there is one
 * capability and starts carrying information at two. Each capability's schema
 * types its own arm, and `defineCapability` constrains `TData` to this union, so
 * the service's public return type is sound without a cast anywhere.
 */
export type PortalData = FleetOverview | VehicleSummary | BatteryAnalytics;

/** What to fetch. Plain data — nothing here names a browser or a transport. */
export interface PortalRequest {
  module: PortalModule;
  /**
   * The fleet or battery the module should be read for, as that module names
   * it (SAD §6: "Dashboard module + battery / fleet target"). Optional because
   * several modules render a whole account with no target at all.
   */
  target?: string;
}

/**
 * Per-call options, separate from the request because they describe the RUN
 * rather than the data being asked for.
 */
export interface PortalOptions {
  /**
   * Cancellation, propagated from the agent run (Milestone 3.5). The Tool
   * Registry hands the Portal Tool a signal that fires when either the client
   * disconnects or the tool's budget expires; the tool passes it here.
   *
   * Playwright accepts no AbortSignal anywhere in its API (SAD §19), so this is
   * never forwarded into it. It is honoured by CLOSING THE BROWSER CONTEXT,
   * which rejects every in-flight operation on it — and that closing happens
   * inside src/services/session/, so the signal travels inward and no
   * BrowserContext comes back out.
   */
  signal?: AbortSignal;
}

export type PortalErrorCode =
  /** No capability is registered for this module yet. Not a fault. */
  | "MODULE_UNAVAILABLE"
  /** This module reports one entity and the request named none. Not a fault. */
  | "TARGET_REQUIRED"
  /**
   * The module was reached but the portal does not list the requested entity.
   * A normal, reportable answer — the vehicle is not in this account — rather
   * than a failure of the scrape.
   *
   * There is deliberately no TARGET_AMBIGUOUS beside it: resolution matches an
   * identifier EXACTLY, so several candidates cannot occur (SAD §19, 4C).
   */
  | "TARGET_NOT_FOUND"
  /** The run was cancelled — the client went away, or the budget expired. */
  | "CANCELLED"
  /** The module could not be reached or did not finish rendering. Retryable. */
  | "PORTAL_UNREACHABLE"
  /** The page loaded but did not look like itself — likely changed markup. */
  | "MODULE_CHANGED"
  /** Extraction succeeded but the normalised result failed its schema. */
  | "MALFORMED_DATA";

/**
 * A failure of the Portal Service.
 *
 * The message is written to be safe to surface anywhere, INCLUDING inside a
 * tool envelope the model reads — the Tool Registry copies a failing tool's
 * error text straight into the model's context. It therefore names no URL, no
 * selector, no credential and no page content. Diagnostic detail travels as
 * `cause`, to Pino and LangSmith only.
 *
 * Deliberately the same convention as SessionError (src/services/session/), and
 * a SessionError raised underneath this service is passed through unchanged
 * rather than re-wrapped: it is already written to this standard, and its code
 * carries recovery information ("credentials rejected") that flattening into a
 * portal code would destroy.
 */
export class PortalError extends Error {
  readonly code: PortalErrorCode;

  constructor(
    code: PortalErrorCode,
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = "PortalError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/*  Capability contract                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Read one module's data off an already-navigated, already-ready page.
 *
 * READ-ONLY BY CONTRACT. An extractor queries the DOM; it does not click
 * through workflows, submit forms, or change anything on the portal. Tarang is
 * an analyst, and a scrape that mutates the customer's dashboard is a defect
 * class this codebase does not intend to have.
 *
 * Navigation and readiness are NOT an extractor's job either: the service does
 * both, from `path` and `readySelector` on the capability, so every module
 * waits for data the same way instead of each extractor inventing its own.
 *
 * `TRaw` is whatever shape suits that one module. It is paired with exactly one
 * `Normalizer` and erased by `defineCapability()`, so it never appears in this
 * service's public surface.
 */
export type Extractor<TRaw> = (
  page: Page,
  request: PortalRequest
) => Promise<TRaw>;

/**
 * Reach the entity named by the request, on an already-navigated page.
 *
 * The phase that exists because the portal has no per-vehicle route (SAD §19,
 * Milestone 4C): selecting a vehicle leaves the URL unchanged, so a target is
 * reached by opening a view and finding it. Run by THIS SERVICE, between
 * navigation and the readiness wait — never by an extractor, which continues to
 * read a page it is handed.
 *
 * The rule a resolver obeys is NEVER MUTATE. Opening a view, paging a table and
 * typing into a search box are navigation. Submitting a form, saving a setting
 * or issuing a device command are not, and no capability may do them.
 *
 * Raises `PortalError("TARGET_NOT_FOUND")` when the portal does not list the
 * entity — a reportable answer, not a fault.
 */
export type Resolver = (page: Page, request: PortalRequest) => Promise<void>;

/**
 * Read back the identifier the portal is actually showing, so the service can
 * prove it is about to extract the entity that was asked for.
 *
 * Returns the label VERBATIM as rendered, or null if none is showing. The
 * comparison is the service's, not the capability's, so every targeted module is
 * checked the same way.
 */
export type IdentityAssertion = (
  page: Page,
  request: PortalRequest
) => Promise<string | null>;

/**
 * One registered dashboard module, with its raw type already erased.
 *
 * `read` is the composed chain — extract → normalise → validate — built once by
 * `defineCapability()`. Composing it there rather than here is what guarantees
 * no capability can skip Zod validation, the same way the Tool Registry's
 * `defineTool()` guarantees no tool can skip the source envelope.
 */
export interface PortalCapability {
  module: PortalModule;
  /**
   * Path under INTELLICAR_BASE_URL for this module.
   *
   * Portal knowledge for a module lives WITH that module, in its own file under
   * extractors/ — one file to change when Intellicar moves a dashboard. This is
   * a deliberate narrowing of the Milestone 3 rule that put every portal URL in
   * authenticator.ts: that block is the LOGIN flow's knowledge, owned by the
   * Session Manager, and module paths are not the authenticator's business.
   */
  path: string;
  /**
   * Selectors that prove this module's data has actually rendered
   * (SAD §11 step 5). Waiting on one is what separates "the page arrived" from
   * "the numbers arrived" — this portal is a client-rendered SPA whose shell
   * exists long before its data, so a dashboard extracted at DOMContentLoaded
   * would be normalised into confident nulls.
   *
   * A LIST, raced candidate by candidate, for the same reason the authenticator
   * races its selector candidates: portal markup is discovered rather than
   * specified, and a single selector makes readiness all-or-nothing — one stale
   * guess reports a working dashboard as MODULE_CHANGED. Candidates are raced
   * separately rather than joined into one CSS union, because Playwright's
   * `text=` and `xpath=` are distinct selector engines and a joined string
   * would be invalid as a whole.
   */
  readySelector: readonly string[];
  /**
   * Whether this module reports ONE entity named by `PortalRequest.target`.
   *
   * A targeted capability always carries both `resolve` and `assertIdentity` —
   * `defineCapability` will not accept one without them — so the two optionals
   * below are optional to the TYPE, never to a targeted module.
   */
  targeted: boolean;
  /** Reach the target. Present exactly when `targeted` is true. */
  resolve?: Resolver;
  /** Prove the right target was reached. Present exactly when `targeted`. */
  assertIdentity?: IdentityAssertion;
  /** extract → normalise → validate. Returns schema-validated data. */
  read: (page: Page, request: PortalRequest) => Promise<PortalData>;
}

/**
 * Bind one module's extractor, normalizer and schema into a capability.
 *
 * The single place the three are composed, and therefore the single place
 * validation is applied. A capability author supplies three independent,
 * separately reviewable pieces and cannot wire them in the wrong order, skip
 * the schema, or return unvalidated data — exactly the property `defineTool()`
 * gives the result envelope.
 *
 * `TRaw` is bound here and appears nowhere outside, so the registry can hold
 * capabilities for modules whose raw shapes have nothing in common.
 */
interface CapabilitySpec<TRaw, TData> {
  module: PortalModule;
  path: string;
  readySelector: readonly string[];
  extract: Extractor<TRaw>;
  normalize: Normalizer<TRaw, unknown>;
  schema: z.ZodType<TData>;
}

export function defineCapability<TRaw, TData extends PortalData>(
  spec:
    | (CapabilitySpec<TRaw, TData> & {
        /** An account-wide module: no target, no resolution, no assertion. */
        targeted?: false;
      })
    | (CapabilitySpec<TRaw, TData> & {
        /**
         * A targeted module. Both fields below are REQUIRED by this arm, which
         * is the whole point of the union: a capability that reports one entity
         * cannot be declared without the step that proves which entity it read.
         */
        targeted: true;
        resolve: Resolver;
        assertIdentity: IdentityAssertion;
      })
): PortalCapability {
  return {
    module: spec.module,
    path: spec.path,
    readySelector: spec.readySelector,
    targeted: spec.targeted === true,
    ...(spec.targeted === true
      ? { resolve: spec.resolve, assertIdentity: spec.assertIdentity }
      : {}),
    read: async (page, request) => {
      const raw = await spec.extract(page, request);
      const normalized = spec.normalize(raw);
      const result = spec.schema.safeParse(normalized);

      if (!result.success) {
        // The Zod report names fields and received values from a live customer
        // dashboard; it is diagnostic, so it travels as `cause` and never as
        // prose the model will read.
        throw new PortalError(
          "MALFORMED_DATA",
          `The ${spec.module} dashboard did not return data in the expected shape.`,
          { cause: result.error }
        );
      }

      return result.data;
    },
  };
}

/* -------------------------------------------------------------------------- */
/*  Capability registry                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Every module Tarang can actually read, keyed by module id.
 *
 * Adding one is a file under extractors/ and a line here; nothing else in the
 * system changes, which is the whole point of the seam. Fleet Overview
 * (Milestone 4B) was exactly that.
 *
 * Partial rather than complete on purpose: the seven modules land one at a
 * time, and a missing entry must read as "not yet" rather than as a type error
 * that pressures someone into a placeholder.
 */
const CAPABILITIES: Partial<Record<PortalModule, PortalCapability>> = {
  fleet_overview: fleetOverviewCapability,
  vehicle_summary: vehicleSummaryCapability,
  battery_analytics: batteryAnalyticsCapability,
};

/* -------------------------------------------------------------------------- */
/*  Public entry point                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Fetch one Intellicar dashboard module as validated JSON.
 *
 * The Portal Tool's only call, and the Session Manager's only caller. The
 * caller learns nothing about whether a login happened, which context was used,
 * or how the data was read — it asks for an outcome and receives normalised
 * data or a PortalError.
 *
 * The return type is `unknown` deliberately: each capability's schema types its
 * own output, and a discriminated union over the registered modules is worth
 * declaring once there is more than one member. The Tool Registry's envelope
 * carries `unknown` data regardless, so nothing downstream loses information by
 * waiting.
 */
export async function fetchPortalModule(
  request: PortalRequest,
  options: PortalOptions = {}
): Promise<PortalData> {
  const { signal } = options;

  // Already gone: the run was cancelled before this call was reached. Refusing
  // here rather than starting work that is known to be unwanted — the same
  // guard, for the same reason, as `runBounded()` in the Tool Registry.
  if (signal?.aborted) {
    throw new PortalError(
      "CANCELLED",
      "The portal request was cancelled before it started."
    );
  }

  const capability = CAPABILITIES[request.module];

  if (capability === undefined) {
    // A normal, reportable answer rather than a fault: the module exists in the
    // architecture and simply is not built yet. The message is written for the
    // model, which will relay it — so it says what is true without inviting a
    // retry.
    throw new PortalError(
      "MODULE_UNAVAILABLE",
      `Live ${request.module} data is not available from the Intellicar portal yet.`
    );
  }

  // A targeted module with no target is refused BEFORE any browser work: it is
  // a question that cannot be asked, not a scrape that failed. The message is
  // written for the model, which can fix it by asking again with an identifier.
  if (capability.targeted && normalizeVehicleNo(request.target ?? "").length === 0) {
    throw new PortalError(
      "TARGET_REQUIRED",
      `Reading ${request.module} needs a specific vehicle. Ask again with the ` +
        `vehicle's fleet identifier, for example TK-51105-02AZ-179386.`
    );
  }

  // Canonicalised ONCE, here, so every capability compares identifiers the same
  // way and no extractor has to remember to. What is reported back to the caller
  // is always the portal's own rendering, never this form.
  const resolved: PortalRequest = capability.targeted
    ? { ...request, target: normalizeVehicleNo(request.target ?? "") }
    : request;

  const startedAt = Date.now();

  try {
    const data = await withAuthenticatedContext(
      (context) => readModule(capability, resolved, context, signal),
      { signal }
    );

    // The module and the duration; never the data, and never a selector. The
    // same policy /api/chat applies to tool spans, for the same reason.
    log.info(
      { module: capability.module, durationMs: Date.now() - startedAt },
      "Portal module read."
    );

    return data;
  } catch (error) {
    // Decided on the SIGNAL, not on the error's shape — the throw can come from
    // the navigation, the readiness wait, the extractor or the Session Manager,
    // each with its own error type, while "was this run cancelled" has exactly
    // one answer. This is the same rule /api/chat uses to keep a client
    // disconnect from reading as an incident.
    if (signal?.aborted) {
      throw new PortalError(
        "CANCELLED",
        "The portal request was cancelled before it finished."
      );
    }

    // Already in the outward vocabulary. A SessionError passes through
    // UNCHANGED rather than being flattened into a portal code: its message is
    // already written to be safe for the model, and its code carries recovery
    // information ("credentials rejected", "not configured") that this layer
    // would destroy by re-wrapping.
    if (error instanceof PortalError || error instanceof SessionError) throw error;

    log.warn(
      { module: capability.module, err: error },
      "Portal module read failed."
    );

    // Anything left is Playwright failing to reach or render the module.
    throw new PortalError(
      "PORTAL_UNREACHABLE",
      `The ${capability.module} dashboard could not be read from the Intellicar portal.`,
      { cause: error }
    );
  }
}

/**
 * The run itself (SAD §11 steps 4-7), inside an authenticated context.
 *
 * The only function in the system that holds a page. It navigates and waits for
 * readiness — the extractor does neither — then hands the settled page to the
 * capability's composed read.
 */
async function readModule(
  capability: PortalCapability,
  request: PortalRequest,
  context: BrowserContext,
  signal?: AbortSignal
): Promise<PortalData> {
  const page = await context.newPage();

  /**
   * Stop at a phase boundary rather than starting the next one.
   *
   * This is an EARLY EXIT, not the classification rule. Cancelling closes the
   * context, so whatever was in flight fails — and during resolution that would
   * otherwise surface as TARGET_NOT_FOUND, telling a user their vehicle does not
   * exist because they closed a tab. What guarantees that cannot happen is
   * `fetchPortalModule`'s catch, which tests `signal.aborted` BEFORE it inspects
   * the error at all. This check only avoids paying for work already known to be
   * unwanted; the ordering there is the fix.
   */
  const stopIfCancelled = () => {
    if (signal?.aborted) {
      throw new PortalError(
        "CANCELLED",
        "The portal request was cancelled before it finished."
      );
    }
  };

  try {
    const url = `${authEnv().INTELLICAR_BASE_URL}${capability.path}`;

    /**
     * One id for THIS attempt (Phase 3 fix).
     *
     * A run can read the same module twice — the first read timing out on a cold
     * page and the model retrying — and a constant id made the second attempt
     * invisible: its `active` was suppressed as a duplicate and its `ok` closed
     * the first attempt's row, rendering a failure followed by a success as one
     * long success. Taking a per-attempt id is what keeps both visible.
     */
    const stageId = occurrenceId(`portal:${capability.module}`);

    /**
     * The dashboard read begins here (Phase 2).
     *
     * Opened before the navigation and closed after the extraction, so it spans
     * the whole slow leg — navigate, resolve, wait for readiness, extract — which
     * is the part of a run a user is actually waiting on. Reported as ONE stage
     * rather than four because the phases underneath it are implementation
     * detail; what a fleet manager needs is that the dashboard is being read and
     * which module.
     *
     * `detail` is the MODULE ID only. The URL is in scope on the line above and
     * is deliberately not carried: this service's whole error convention is that
     * nothing it surfaces names a URL, a selector or page content, and a stage is
     * held to the same rule as a message.
     */
    reportStage({
      id: stageId,
      kind: "portal_read",
      status: "active",
      detail: capability.module,
    });

    // `domcontentloaded`, never `networkidle`: this portal holds map tiles and
    // polling open, so idle may arrive late or never (the same finding that
    // shaped the authenticator's probe). Readiness is asserted below, against
    // the module's own rendered data, rather than inferred from the network.
    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: PORTAL_NAV_TIMEOUT_MS,
    });

    // Reach the requested entity. Only a targeted module has this phase, and it
    // runs BEFORE readiness because for such a module the data-bearing element
    // does not exist until the entity has been reached.
    if (capability.resolve) {
      stopIfCancelled();
      await withPhaseBudget(
        capability.resolve(page, request),
        PORTAL_RESOLVE_TIMEOUT_MS,
        () =>
          new PortalError(
            "MODULE_CHANGED",
            `The ${capability.module} view did not respond as expected while ` +
              `looking up ${request.target}.`
          )
      );
    }

    stopIfCancelled();
    await waitForReady(page, capability);

    // Prove the page is showing the entity that was asked for. Redundant with an
    // exact-match resolver by construction, and kept anyway: it turns a future
    // resolution bug into a clean TARGET_NOT_FOUND instead of a confident wrong
    // vehicle, which is the failure this whole module is shaped to prevent.
    if (capability.assertIdentity) {
      stopIfCancelled();

      const shown = await capability.assertIdentity(page, request);
      const expected = normalizeVehicleNo(request.target ?? "");

      if (shown === null || normalizeVehicleNo(shown) !== expected) {
        throw new PortalError(
          "TARGET_NOT_FOUND",
          `The Intellicar portal did not show ${request.target} in the ` +
            `${capability.module} view.`
        );
      }
    }

    stopIfCancelled();

    const data = await capability.read(page, request);

    // Closed only past every phase and past Zod validation, so it reports a
    // module that was genuinely read rather than one that was reached. Any
    // failure above leaves the stage `active`, which is how the timeline shows
    // where the run stopped.
    reportStage({
      id: stageId,
      kind: "portal_read",
      status: "ok",
      detail: capability.module,
    });

    return data;
  } finally {
    // The context is closed by the Session Manager; the page is this
    // function's to release, and a close failure must not mask a real error.
    await page.close().catch(() => {});
  }
}

/**
 * Bound one lifecycle phase, without pretending to cancel it.
 *
 * `Promise.race` reports the first outcome; it does not stop the loser — the
 * same property the Tool Registry documents about `runBounded`. What actually
 * stops a phase here is the browser context closing, which happens for the two
 * reasons that matter: the run was cancelled, or `withAuthenticatedContext`
 * returned. So this guarantees the SERVICE moves on, and the context guarantees
 * the work does.
 *
 * The loser cannot become an unhandled rejection: `Promise.race` subscribes to
 * both, so a late rejection already has a handler attached and settles the race
 * a second time as a no-op.
 */
async function withPhaseBudget<T>(
  work: Promise<T>,
  timeoutMs: number,
  onTimeout: () => PortalError
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), timeoutMs);
  });

  try {
    return await Promise.race([work, expiry]);
  } finally {
    // Released whichever way the race settled: a stray timer would hold the
    // event loop open for the rest of the budget, which is what hangs a
    // short-lived process such as `npm run portal:fetch`.
    clearTimeout(timer);
  }
}

/**
 * Wait until one of the capability's readiness selectors is visible.
 *
 * Raced with `Promise.any`, so the FIRST candidate to appear wins and a stale
 * candidate costs only itself. If every one times out, the page loaded but did
 * not render what this module expects — which is a changed dashboard, not an
 * unreachable portal, and the two need different responses from whoever reads
 * the log.
 */
async function waitForReady(
  page: Page,
  capability: PortalCapability
): Promise<void> {
  try {
    await Promise.any(
      capability.readySelector.map((selector) =>
        page
          .locator(selector)
          .first()
          .waitFor({ state: "visible", timeout: PORTAL_READY_TIMEOUT_MS })
      )
    );
  } catch (error) {
    throw new PortalError(
      "MODULE_CHANGED",
      `The ${capability.module} dashboard loaded but did not show the expected data.`,
      { cause: error }
    );
  }
}
