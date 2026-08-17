import { z } from "zod";

import type { ToolSpec } from "@/agent/tool-registry";
import { isIotDbConfigured } from "@/lib/env";
import { IotReadError, SOH_UNAVAILABLE_REASON } from "@/services/database/iot.records";
import {
  readBatteryHistory,
  readCanHistory,
  readDistanceByVehicle,
  readDistanceFleet,
  readFleetCommunicationWindow,
  readFleetCurrentState,
  readFleetSummary,
  readGpsHistory,
  readLatestBattery,
  readLatestGps,
  readOpenAlerts,
  readVehicleCurrentState,
  readVehicleRegistry,
  readVehiclesOffline,
  resolveWindow,
} from "@/services/database/iot.reader";

/**
 * Database Tool (SAD §6) — the agent's access to the live IoT database.
 *
 * The THIRD of the four Level-1 tools (CLAUDE.md rule 6: portal, database,
 * analysis, report). It adds no capability beyond the four already sanctioned;
 * it makes one that was designed but never registered actually reachable.
 *
 * ## The schema takes an INTENT, never SQL
 *
 * §6 originally allowed "typed query intent or read-only SQL". The second half
 * is now closed (ARCHITECTURE.md §19): there is no free-text SQL parameter here
 * or anywhere else, so a write is UNREPRESENTABLE rather than filtered by a
 * validator whose completeness nobody can prove. Every statement lives in
 * `iot.queries.ts` as a constant with `$n` placeholders.
 *
 * The cost is real and accepted: a question nobody anticipated needs a new
 * intent, not a cleverer prompt. What it buys is that each query is written
 * once, EXPLAINed once, and measured once against the database's 20s ceiling —
 * rather than composed afresh by a model with no way to measure it.
 *
 * ## What this tool is FOR, relative to the other two
 *
 * The portal is preferred for live questions it can answer; this database is
 * the authoritative source for IoT telemetry and for the current questions the
 * portal cannot serve; the analysis tool reads a small imported DEVELOPMENT
 * dataset and is never a source of truth for current telemetry. That ordering
 * is stated in SYSTEM_PROMPT rather than inferred here.
 *
 * ## This file is a thin adapter and holds no logic
 *
 * No SQL, no clamping, no conversion — all of that is the IoT Database Service.
 * The one thing this layer owns is THE CLOCK: `new Date()` is read exactly once
 * per call and passed down, so the service stays a deterministic function of its
 * inputs. `analysis.tool.ts` arranges the single clock read the same way and for
 * the same reason.
 *
 * It does NOT build the `{ data, source }` envelope — that is the Tool
 * Registry's job (CLAUDE.md rule 2) — and it never catches an error to return
 * it as data; it throws, and `defineTool` wraps it.
 */

/* -------------------------------------------------------------------------- */
/*  Intents                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Intents that read one vehicle and therefore REQUIRE `vehicleNo`.
 *
 * The three `*_history` members additionally read a raw, partitioned telemetry
 * table, which is exactly why they may never be fleet-scope: a raw read that
 * does not pin a `vehicleno` cannot use `idx_*_vehicle_time` and straddles the
 * database's 20-second ceiling depending on cache state (docs/IOT-DATABASE.md
 * §6). Requiring the identifier in the SCHEMA is what makes that structural.
 */
const VEHICLE_INTENTS = [
  "vehicle_current_state",
  "latest_gps",
  "latest_battery",
  "distance_by_vehicle",
  "battery_history",
  "gps_history",
  "can_history",
] as const;

const FLEET_INTENTS = [
  "fleet_summary",
  "fleet_current_state",
  "vehicles_offline",
  "vehicle_registry",
  "distance_fleet",
  "fleet_communication_window",
  "open_alerts",
] as const;

/**
 * Fleet intents that REQUIRE a window rather than merely accepting one.
 *
 * `fleet_communication_window` is meaningless without a period — "how many
 * assets communicated" is not a question until it says over what. Making the
 * window mandatory in the schema means the model is told what is missing rather
 * than handed a default it did not choose and could misreport.
 */
const WINDOW_REQUIRED_INTENTS = new Set<Intent>(["fleet_communication_window"]);

/**
 * The ceiling for a communication window, mirrored from the reader.
 *
 * Stated here so the REFUSAL can name the number. The reader clamps to the same
 * value independently — the schema teaches the model, the clamp enforces the
 * bound, and neither is sufficient alone.
 */
const COMMUNICATION_WINDOW_DAYS_MAX = 90;

const INTENTS = [...VEHICLE_INTENTS, ...FLEET_INTENTS] as const;

type Intent = (typeof INTENTS)[number];

/** Intents whose answer is a window of history rather than a current value. */
const WINDOWED_INTENTS = new Set<Intent>([
  "battery_history",
  "gps_history",
  "can_history",
  "distance_by_vehicle",
  "distance_fleet",
  "fleet_communication_window",
]);

const schema = z
  .object({
    intent: z
      .enum(INTENTS)
      .describe(
        "Which named query to run. Prefer vehicle_current_state and " +
          "fleet_summary: they read a pre-materialised current-state table and " +
          "answer charge, speed, position, voltage, online status and latest " +
          "timestamp in one fast read."
      ),
    vehicleNo: z
      .string()
      .regex(
        /^[A-Za-z0-9-]{1,64}$/,
        "vehicleNo may contain only letters, digits and hyphens"
      )
      .optional()
      .describe(
        "The vehicle's fleet identifier (format TK-#####-##@@-######). " +
          "REQUIRED for every per-vehicle intent. For vehicle_registry and " +
          "open_alerts it is optional and narrows the result to one vehicle."
      ),
    windowDays: z
      .number()
      .int()
      .positive()
      .max(180)
      .optional()
      .describe(
        "How many days back to read, for the history, distance and " +
          "communication-window intents. Defaults to 7. Retention is about 6 " +
          "months, so 180 is the maximum — except fleet_communication_window, " +
          "where it is REQUIRED and capped at 90 (30 = last month, 60 = last " +
          "two months, 90 = last three months). Ignored by the current-state " +
          "intents, which have no window."
      ),
    limit: z
      .number()
      .int()
      .positive()
      .max(500)
      .optional()
      .describe("Maximum rows to return. Defaults to 200 and is clamped server-side."),
  })
  /**
   * Per-intent requirements, mirroring `analysisInputSchema`'s superRefine.
   *
   * Enforced HERE rather than in the service because a mismatch should be
   * refused before any connection is opened — the same reasoning that puts the
   * Analysis Engine's scope gate (P0) in the planner. Both inputs are static, so
   * the refusal costs nothing and the model gets a message naming what it must
   * supply rather than an empty result it might narrate as "no data".
   */
  .superRefine((value, ctx) => {
    const needsVehicle = (VEHICLE_INTENTS as readonly string[]).includes(value.intent);

    if (needsVehicle && value.vehicleNo === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["vehicleNo"],
        message:
          `The "${value.intent}" intent reads one vehicle and requires ` +
          `vehicleNo. For a fleet-wide answer use fleet_summary, ` +
          `fleet_current_state, vehicles_offline or distance_fleet instead.`,
      });
    }

    if (
      value.windowDays !== undefined &&
      !WINDOWED_INTENTS.has(value.intent)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["windowDays"],
        message:
          `The "${value.intent}" intent reports a CURRENT value and has no ` +
          `window. Drop windowDays, or use battery_history, gps_history, ` +
          `can_history, distance_by_vehicle, distance_fleet or ` +
          `fleet_communication_window for a period.`,
      });
    }

    if (WINDOW_REQUIRED_INTENTS.has(value.intent) && value.windowDays === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["windowDays"],
        message:
          `The "${value.intent}" intent measures a PERIOD and requires ` +
          `windowDays — "how many assets communicated" is not a question until ` +
          `it says over what period. Supply windowDays (1-${COMMUNICATION_WINDOW_DAYS_MAX}), ` +
          `for example 30 for "the last month" or 90 for "the last three months".`,
      });
    }

    /**
     * The 90-day cap is REFUSED rather than silently clamped, so the model is
     * told the limit instead of receiving an answer over a period it did not
     * ask for and would then misreport. The reader clamps too, as defence in
     * depth for any caller that bypasses this schema.
     */
    if (
      WINDOW_REQUIRED_INTENTS.has(value.intent) &&
      value.windowDays !== undefined &&
      value.windowDays > COMMUNICATION_WINDOW_DAYS_MAX
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["windowDays"],
        message:
          `The "${value.intent}" intent is capped at ` +
          `${COMMUNICATION_WINDOW_DAYS_MAX} days. It is the only fleet-wide read ` +
          `that touches raw telemetry, and its cost grows with the window ` +
          `(measured 146 ms at 30 days, 4.8 s at 90 against a 20-second server ` +
          `limit). Ask for ${COMMUNICATION_WINDOW_DAYS_MAX} days or fewer, and ` +
          `report the window you actually used.`,
      });
    }
  });

/* -------------------------------------------------------------------------- */
/*  Dispatch                                                                  */
/* -------------------------------------------------------------------------- */

type Input = z.output<typeof schema>;

/**
 * Everything the answer needs to be read honestly, attached to every result.
 *
 * `origin` names the TABLE that answered, not just the database, because three
 * registries in this system disagree about which vehicles exist and a bare
 * "postgres" would not say which one spoke.
 */
function describeMethod(input: Input, now: Date, extra: Record<string, unknown> = {}) {
  const method: Record<string, unknown> = {
    intent: input.intent,
    database: "itarang (IoT platform, read-only)",
    ...extra,
  };

  if (WINDOWED_INTENTS.has(input.intent)) {
    const window = resolveWindow(now, input.windowDays);
    method.windowFrom = window.from.toISOString();
    method.windowTo = window.to.toISOString();
  }

  return method;
}

/**
 * Intents whose payload contains battery figures, and which therefore carry the
 * state-of-health unavailability sentence.
 *
 * ONCE PER RESULT, never once per row. It used to ride on every
 * `VehicleStateRecord`, which was measured at 51,600 characters on a
 * 200-vehicle read — 34% of the payload — and helped fill the model's context so
 * completely that a fleet question returned no answer at all. The reason is a
 * property of the COLUMN, not of any vehicle, so one copy says everything 200
 * said. `sohPct: null` still rides on every row; that is the part that carries
 * the per-row guarantee, and it costs thirteen characters.
 */
const SOH_BEARING_INTENTS = new Set<Intent>([
  "vehicle_current_state",
  "fleet_current_state",
  "vehicles_offline",
  "latest_battery",
  "battery_history",
]);

async function dispatch(input: Input, now: Date, signal: AbortSignal) {
  const { intent, vehicleNo, windowDays, limit } = input;
  const window = resolveWindow(now, windowDays);

  /**
   * The identifier for a per-vehicle intent.
   *
   * `superRefine` has already refused the request if it is missing, so this
   * throw is unreachable — but it is a real check rather than a `!` assertion,
   * because an unreachable branch that silently passes `undefined` into a query
   * parameter is how "no data for vehicle undefined" reaches a user.
   */
  const requireVehicleNo = (): string => {
    if (vehicleNo === undefined) {
      throw new IotReadError(
        "INVALID_REQUEST",
        `The "${intent}" intent requires a vehicleNo.`
      );
    }
    return vehicleNo;
  };

  switch (intent) {
    case "fleet_summary": {
      const data = await readFleetSummary(signal);
      return { data, method: { table: "vehicle_state, vehicles" } };
    }

    case "fleet_current_state": {
      const vehicles = await readFleetCurrentState(limit, signal);
      return {
        data: { vehicles, count: vehicles.length },
        method: { table: "vehicle_state", rows: vehicles.length },
      };
    }

    case "vehicles_offline": {
      const vehicles = await readVehiclesOffline(limit, signal);
      const summary = await readFleetSummary(signal);
      return {
        data: {
          vehicles,
          // Reported alongside the list so "offline" is never conflated with
          // "unknown": 11 vehicles have online IS NULL, which means the platform
          // does not know rather than that they are off.
          onlineCount: summary.online,
          offlineCount: summary.offline,
          unknownCount: summary.unknown,
          note:
            "online IS NULL means the platform does not know this vehicle's " +
            "state — it is counted as unknown, not as offline.",
        },
        method: { table: "vehicle_state", rows: vehicles.length },
      };
    }

    case "vehicle_registry": {
      const vehicles = await readVehicleRegistry(vehicleNo, limit, signal);
      return { data: { vehicles, count: vehicles.length }, method: { table: "vehicles" } };
    }

    case "vehicle_current_state": {
      const state = await readVehicleCurrentState(requireVehicleNo(), signal);
      return {
        data:
          state ??
          {
            vehicleNo,
            available: false,
            reason:
              "This vehicle is registered in the IoT database but has no " +
              "current-state row, so it has never reported telemetry.",
          },
        method: { table: "vehicle_state" },
      };
    }

    case "latest_gps": {
      const { record, source } = await readLatestGps(requireVehicleNo(), signal);
      return { data: record, method: { table: source } };
    }

    case "latest_battery": {
      const { record, source } = await readLatestBattery(requireVehicleNo(), signal);
      return { data: record, method: { table: source } };
    }

    case "distance_by_vehicle": {
      const days = await readDistanceByVehicle(requireVehicleNo(), window, limit, signal);
      return {
        data: {
          days,
          totalDistanceKm: days.reduce((sum, d) => sum + (d.distanceKm ?? 0), 0),
          note:
            "energyKwh and movingSeconds are largely unrecorded in this " +
            "database; a null means unavailable, never zero.",
        },
        method: { table: "distance_rollup", bucket: "day", rows: days.length },
      };
    }

    case "distance_fleet": {
      const vehicles = await readDistanceFleet(window, limit, signal);
      return {
        data: {
          vehicles,
          totalDistanceKm: vehicles.reduce((sum, v) => sum + (v.distanceKm ?? 0), 0),
          vehicleCount: vehicles.length,
        },
        method: { table: "distance_rollup", bucket: "day", rows: vehicles.length },
      };
    }

    case "fleet_communication_window": {
      // windowDays is schema-required for this intent, so the fallback is
      // unreachable; it exists so the type is honest rather than asserted.
      const data = await readFleetCommunicationWindow(now, windowDays ?? 30, signal);
      return {
        data,
        method: {
          table: "telemetry_gps + vehicles",
          plan: "loose index scan — one index-only EXISTS seek per registered vehicle",
          measures: "assets that reported GPS telemetry inside the window",
          notFrom:
            "not vehicle_state.last_seen (about two days of history) and not " +
            "distance_rollup (records movement, not communication)",
          communicatingAssets: data.communicatingAssets,
          registeredAssets: data.registeredAssets,
        },
      };
    }

    case "open_alerts": {
      const result = await readOpenAlerts(vehicleNo, limit, signal);
      return {
        data: result,
        method: { table: "alerts", rows: result.alerts.length },
      };
    }

    case "battery_history": {
      const samples = await readBatteryHistory(requireVehicleNo(), window, limit, signal);
      return {
        data: { samples, count: samples.length },
        method: { table: "telemetry_battery", rows: samples.length },
      };
    }

    case "gps_history": {
      const samples = await readGpsHistory(requireVehicleNo(), window, limit, signal);
      return {
        data: { samples, count: samples.length },
        method: { table: "telemetry_gps", rows: samples.length },
      };
    }

    case "can_history": {
      const samples = await readCanHistory(requireVehicleNo(), window, limit, signal);
      return {
        data: { samples, count: samples.length },
        method: {
          table: "telemetry_can",
          rows: samples.length,
          deduplication: "DISTINCT ON (time) — the raw table holds duplicate rows per timestamp",
        },
      };
    }
  }
}

/* -------------------------------------------------------------------------- */
/*  Spec                                                                      */
/* -------------------------------------------------------------------------- */

export const databaseToolSpec: ToolSpec<typeof schema> = {
  name: "database",
  description:
    "Read the live IoT telemetry database for this fleet. This is the " +
    "authoritative database source for IoT telemetry, and the source for any " +
    "current reading the portal cannot provide. " +
    "CURRENT STATE: vehicle_current_state returns one vehicle's charge, speed, " +
    "position, pack voltage, current, temperature, fuel, range, online status " +
    "and latest timestamp together in a single fast read — prefer it over the " +
    "history intents for any 'what is it now' question. fleet_summary returns " +
    "fleet counts (registered, online, offline, unknown). vehicles_offline " +
    "lists vehicles that are not online. fleet_current_state returns the whole " +
    "fleet's current rows. vehicle_registry returns make/model, owner and " +
    "battery capacity. " +
    "HISTORICAL COMMUNICATION — how many assets COMMUNICATED, REPORTED or were " +
    "ACTIVE over a past period: use fleet_communication_window with windowDays. " +
    "This is the ONLY intent that answers 'how many assets communicated in the " +
    "last N days / last month / last two months / last three months', 'how many " +
    "assets reported', 'how many were reporting', 'how many were active', or " +
    "'how many have gone silent'. windowDays is REQUIRED and capped at 90 (use " +
    "30 for a month, 60 for two months, 90 for three months). It returns the " +
    "count of assets that reported, the registered-asset total to compare it " +
    "against, and the feed it measured. " +
    "DO NOT answer a historical communication question with any of these: " +
    "fleet_current_state reports the CURRENT state of each asset and says " +
    "nothing about any past period; vehicles_offline reports which assets are " +
    "offline RIGHT NOW, not who communicated over a window; distance_fleet " +
    "reports DISTANCE TRAVELLED, and an asset that reported while parked all " +
    "month travelled zero kilometres but did communicate, so distance is not a " +
    "substitute for communication. There is also no 'last seen' field you may " +
    "use for this — the current-state table holds only about two days of " +
    "history, so it cannot answer a question about one, two or three months. " +
    "HISTORY: battery_history, gps_history and can_history read raw telemetry " +
    "for ONE vehicle over a window and REQUIRE vehicleNo. distance_by_vehicle " +
    "and distance_fleet report daily distance. " +
    "ALERTS: open_alerts returns unresolved alerts; this database records only " +
    "'offline' alerts, so it is not evidence about temperature, current or " +
    "cell balance. " +
    "STATE OF HEALTH IS NOT AVAILABLE from this database — the column is a " +
    "constant, not a measurement — so battery health, degradation and capacity " +
    "fade cannot be answered here and must be reported as unavailable. " +
    "Ask for a fleet intent rather than calling a per-vehicle intent once per " +
    "vehicle.",
  schema,
  origin: "postgres:itarang (IoT, read-only)",
  handler: async (input, context) => {
    if (!isIotDbConfigured()) {
      throw new IotReadError(
        "NOT_CONFIGURED",
        "The IoT database is not configured in this environment, so no " +
          "telemetry can be read from it. This describes the deployment, not " +
          "the fleet — it is not evidence that any vehicle or reading does not " +
          "exist. Try the portal tool for current data."
      );
    }

    // THE RUN'S SINGLE CLOCK READ. Everything below receives it, so the service
    // never reads the clock and stays deterministic (see the header).
    const now = new Date();

    const { data, method } = await dispatch(input, now, context.signal);

    /**
     * The state-of-health sentence, attached ONCE beside the rows.
     *
     * Spread onto the result object rather than into each record, so a
     * 200-vehicle read carries it once instead of two hundred times. A single
     * `vehicle_current_state` row and a 200-row fleet read now pay exactly the
     * same 258 characters for it.
     */
    const withNotes =
      SOH_BEARING_INTENTS.has(input.intent) && data !== null && typeof data === "object"
        ? { ...(data as Record<string, unknown>), sohUnavailable: SOH_UNAVAILABLE_REASON }
        : data;

    return { data: withNotes, method: describeMethod(input, now, method) };
  },
};
