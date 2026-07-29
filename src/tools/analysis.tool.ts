import { z } from "zod";

import type { ToolSpec } from "@/agent/tool-registry";
import {
  fetchLatestBatteryReading,
  requireVehicle,
} from "@/tools/database.tool";

/**
 * Analysis Tool (SAD §6) — computes metrics over data gathered by other tools.
 *
 * MILESTONE 2B: battery_health now reports a measured value read from
 * PostgreSQL through the Database Tool, replacing the Milestone 1 stub. It is
 * still a *reported* metric rather than a computed one — the most recent
 * soh_pct the database holds, carried through unchanged. Degradation trends,
 * cycle counts and utilisation are computation, and land later in
 * src/services/analytics/battery-metrics.ts; this adapter's shape does not
 * change when they do.
 *
 * Data access goes through database.tool.ts, never Prisma. The `{ data,
 * source }` envelope is applied by the Tool Registry, so this file declares
 * only where its numbers come from and how they were obtained.
 */

const analysisInputSchema = z.object({
  vehicleNo: z
    .string()
    .min(1)
    .describe(
      "Fleet identifier of the vehicle to analyse, e.g. 'TK-51105-02AZ-179386'."
    ),
  metric: z
    .enum(["battery_health"])
    .default("battery_health")
    .describe("The metric to compute. Only battery_health is available."),
});

export const analysisToolSpec: ToolSpec<typeof analysisInputSchema> = {
  name: "analysis",
  description:
    "Report battery metrics for a single vehicle from historical telemetry. " +
    "Use this whenever the user asks about the health or state of health of a " +
    "specific vehicle's battery. Requires the vehicle's fleet identifier " +
    "(format TK-#####-##@@-######). Currently supports the battery_health " +
    "metric only.",
  schema: analysisInputSchema,
  origin: "postgres:battery_telemetry",
  handler: async ({ vehicleNo, metric }) => {
    // Resolve the vehicle first: without this, a mistyped fleet identifier and
    // a vehicle that genuinely has no telemetry are indistinguishable, and the
    // agent would report "no data" for what is really a typo.
    await requireVehicle({ vehicleNo });

    const reading = await fetchLatestBatteryReading({ vehicleNo });

    if (reading === null) {
      throw new Error(
        `Vehicle ${vehicleNo} is registered but has no battery telemetry.`
      );
    }

    // A null measurement is not a zero. Failing here makes the agent say the
    // value is unavailable, per the grounding contract, instead of narrating a
    // number that was never measured.
    if (reading.sohPct === null) {
      throw new Error(
        `The most recent battery reading for ${vehicleNo} (${reading.recordedAt}) carries no state-of-health value.`
      );
    }

    return {
      data: {
        vehicleNo,
        metric,
        value: reading.sohPct,
        unit: "%",
        recordedAt: reading.recordedAt,
      },
      method: {
        basis: "most recent battery telemetry reading",
        column: "battery_telemetry.soh_pct",
        recordedAt: reading.recordedAt,
      },
    };
  },
};
