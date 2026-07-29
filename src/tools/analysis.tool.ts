import { z } from "zod";

import type { ToolSpec } from "@/agent/tool-registry";

/**
 * Analysis Tool (SAD §6) — computes metrics over data gathered by other tools.
 *
 * MILESTONE 1 STUB: returns a hardcoded battery-health figure so the grounded
 * agent loop can be exercised end to end. The real computation lands in
 * src/services/analytics/battery-metrics.ts; this adapter's shape does not
 * change when it does. `origin` says "stub" on purpose — nothing downstream
 * should mistake this for measured data.
 */

const analysisInputSchema = z.object({
  batteryId: z
    .string()
    .min(1)
    .describe("Identifier of the battery to analyse, e.g. 'B-1042'."),
  metric: z
    .enum(["battery_health"])
    .default("battery_health")
    .describe("The metric to compute. Only battery_health is available."),
});

const ANALYSIS_WINDOW = "last 90 charging cycles";

export const analysisToolSpec: ToolSpec<typeof analysisInputSchema> = {
  name: "analysis",
  description:
    "Compute battery metrics for a single battery. Use this whenever the user " +
    "asks about the health, degradation or state of health of a specific " +
    "battery. Requires the battery identifier. Currently supports the " +
    "battery_health metric only.",
  schema: analysisInputSchema,
  origin: "stub:analytics/battery-metrics",
  handler: ({ batteryId, metric }) => ({
    data: {
      batteryId,
      metric,
      value: 87,
      unit: "%",
    },
    method: {
      window: ANALYSIS_WINDOW,
      note: "Stub value — not computed from telemetry.",
    },
  }),
};
