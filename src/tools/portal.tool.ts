import { z } from "zod";

import type { ToolSpec } from "@/agent/tool-registry";
import {
  PORTAL_MODULES,
  fetchPortalModule,
} from "@/services/portal/portal.service";

/**
 * Portal Tool (SAD §6) — the Tool layer's adapter over the Portal Service.
 *
 * A THIN ADAPTER AND NOTHING MORE. It declares what the LLM may ask for,
 * forwards the validated request to the Portal Service, and returns what comes
 * back. There is no scraping here, no selector, no navigation, no browser type,
 * and no parsing — those live behind portal.service.ts, and every one of them
 * is a boundary the ESLint Portal zone enforces rather than a convention.
 *
 * ## The agent's distance from authentication
 *
 * This file cannot reach the Session Manager, the Credential Manager, or
 * Playwright: eslint.config.mjs forbids all three from src/tools/**. So a
 * prompt-injected model calling this tool cannot trigger a login it can observe,
 * cannot obtain a cookie, and cannot receive a page handle — it asks for
 * "Fleet Overview data" and receives normalised JSON or a safe error string
 * (CLAUDE.md rule 1, SAD §5).
 *
 * ## Not registered at Milestone 4A
 *
 * The Tool Registry's `specs` list is deliberately untouched: no capability is
 * implemented yet, so registering this would advertise a tool to the model that
 * can only ever fail, change the tool list the LLM reasons over, and cost a
 * wasted step on every question that mentions live data. Milestone 4B adds
 * Fleet Overview and this spec to `specs` in the same slice — one line, once
 * there is something behind it.
 */

/**
 * Ceiling for one portal fetch, overriding the registry's 30s default.
 *
 * The rare, sanctioned use of `ToolSpec.timeoutMs` (SAD §19, Milestone 3.5):
 * this tool's work is a genuinely different shape from the in-process default —
 * a cold browser context, a live dashboard, and possibly a silent login inside
 * the Session Manager's serialised queue, none of which a database read pays
 * for. It is raised HERE rather than raising TOOL_TIMEOUT_MS for everyone,
 * which is exactly what the per-spec field exists for.
 *
 * This is the outer bound whose only job is to guarantee the agent run ends.
 * The Portal Service may enforce stricter internal budgets over sub-operations
 * it understands; that is a different concern, and neither replaces the other.
 */
export const PORTAL_TOOL_TIMEOUT_MS = 90_000;

const schema = z.object({
  module: z
    .enum(PORTAL_MODULES)
    .describe("Which Intellicar dashboard module to read."),
  target: z
    .string()
    .min(1)
    .optional()
    .describe(
      "The vehicle to read the module for, as its fleet identifier " +
        "(format TK-#####-##@@-######). REQUIRED for vehicle_summary. Omit " +
        "for modules that report the whole account, such as fleet_overview."
    ),
});

export const portalToolSpec: ToolSpec<typeof schema> = {
  name: "portal",
  description:
    "Read live data from an Intellicar dashboard module. Use this for the " +
    "current state of a fleet or battery; use the analysis tool for " +
    "historical telemetry already stored in the database. " +
    "fleet_overview reports account-wide status counts and takes no target. " +
    "vehicle_summary reports one vehicle as the dashboard currently shows it — " +
    "device, model, variant, last talk time, speed, fuel and location — and " +
    "REQUIRES the vehicle's fleet identifier as `target`. It reads one vehicle " +
    "per call and each call scrapes the live portal, so ask for the specific " +
    "vehicle in question rather than looping over a fleet.",
  schema,
  origin: "Intellicar portal (live)",
  timeoutMs: PORTAL_TOOL_TIMEOUT_MS,
  handler: async (input, context) => {
    // The signal fires for either reason the registry merges into it — the
    // client disconnected, or this tool's budget expired. The Portal Service
    // acts on it by closing the browser context, which is the only cancellation
    // Playwright supports (SAD §19); passing it on is all this adapter does
    // with it.
    const data = await fetchPortalModule(
      { module: input.module, ...(input.target ? { target: input.target } : {}) },
      { signal: context.signal }
    );

    return { data };
  },
};
