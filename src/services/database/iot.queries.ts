/**
 * The IoT query catalogue (docs/IOT-DATABASE.md §6, ARCHITECTURE.md §19).
 *
 * EVERY STATEMENT TARANG RUNS AGAINST THE IoT DATABASE IS IN THIS FILE, and
 * every one is a module-level constant with `$n` placeholders. Nothing is
 * composed, concatenated, templated or interpolated — the only variation
 * between two executions of the same query is its bound parameters.
 *
 * ## Why a catalogue instead of a validator
 *
 * §6 originally allowed "typed query intent or read-only SQL", and a validator
 * over model-authored SQL was the obvious reading of the second half. It was
 * rejected: a validator's guarantee is only as complete as the list of attacks
 * its author anticipated, and it must be re-audited every time PostgreSQL grows
 * syntax. Here there is no string supplied by the model that becomes SQL, so a
 * write is UNREPRESENTABLE rather than filtered.
 *
 * The second benefit is the one that shows up daily: each statement is written
 * once, EXPLAINed once, and timed once against the role's 20s
 * `statement_timeout` — instead of being composed afresh by a model that has no
 * way to measure it.
 *
 * ## The rule every raw-telemetry query obeys, and why
 *
 * MEASURED 2026-08-13, fleet-wide `DISTINCT ON (vehicleno)` over
 * `telemetry_battery`: 1 day cold — cancelled at 20,295 ms; 1 day warm — ~4.0 s;
 * 7 days warm — ~9.3 s; 30 days warm — cancelled at 20,479 ms.
 *
 * The point is not that it is slow. It is that it STRADDLES the 20s ceiling,
 * and which side it lands on depends on the buffer cache and the window —
 * neither of which a caller controls. An intermittently-succeeding query is
 * worse than a reliably failing one, and this codebase has already paid for
 * that lesson once with the portal's readiness budget. Size from the worst
 * observation.
 *
 * The cause is structural: pg_partman stopped creating partitions at
 * `p20260704`, so every current row is in `telemetry_*_default` and pruning
 * contributes nothing; and the only index is `(vehicleno, time DESC)`, which a
 * predicate naming only `time` cannot use.
 *
 * So: NO FLEET-SCOPE QUERY BELOW TOUCHES A RAW TELEMETRY TABLE. Fleet questions
 * read `vehicle_state` (334 pre-materialised rows) or `distance_rollup`. Every
 * `telemetry_*` query names a `vehicleno` first, so it drives
 * `idx_*_vehicle_time`, and carries a time bound and a LIMIT. The boundary is
 * unreachable by construction rather than merely discouraged.
 *
 * ## Tables that are NOT here, deliberately
 *
 * `daily_distance_per_vehicle`, `hourly_battery_per_vehicle`, `trips`,
 * `aggregator_runs`, `dashboard_vehicle_monthly_range` and
 * `dashboard_nbfc_loans_with_iot` are all EMPTY. An empty table does not fail —
 * it returns zero rows, which reads downstream as "this fleet has no trips"
 * rather than "this table was never populated". That is a wrong answer wearing
 * the costume of a real one, so exclusion is enforced here rather than left to
 * judgement. `telemetry_fuel` is out of scope; fuel comes from
 * `vehicle_state.fuel_pct`.
 *
 * `soh_pct` is never selected. See `SOH_UNAVAILABLE_REASON`.
 */

/* -------------------------------------------------------------------------- */
/*  Current state — vehicle_state                                             */
/* -------------------------------------------------------------------------- */

/**
 * One vehicle's complete current state.
 *
 * The single most useful query in the catalogue: one primary-key lookup (~150 ms)
 * answers SOC, speed, position, voltage, temperature, fuel, range, online status
 * and latest timestamp together. No "current" question needs a raw telemetry
 * table, which is exactly what keeps the 20s ceiling out of reach.
 *
 * `soh_pct` is absent from the projection rather than selected and dropped
 * later — a column that must never be reported should not be in the result set
 * at all.
 */
export const VEHICLE_CURRENT_STATE = `
  select vehicleno, last_seen, last_gps_at, last_battery_at, last_fuel_at,
         lat, lon, speed_kph, heading, ignition, gps_fix,
         soc_pct, pack_voltage, pack_current, pack_temp_c, charging,
         fuel_pct, range_km, online, open_alert_count, updated_at
    from vehicle_state
   where vehicleno = $1
`;

/**
 * Fleet counts in one pass over 334 rows.
 *
 * The three online states are counted SEPARATELY. `online IS NULL` means the
 * platform does not know — 11 vehicles were in that state on 2026-08-13 — and
 * folding them into `offline` would assert something the data does not say.
 *
 * `registered` and `with_state` are counted from different tables because they
 * differ: 335 vehicles are registered, 334 have ever reported.
 */
export const FLEET_SUMMARY = `
  select (select count(*) from vehicles)                          as registered_vehicles,
         count(*)                                                 as vehicles_with_state,
         count(*) filter (where online is true)                   as online,
         count(*) filter (where online is false)                  as offline,
         count(*) filter (where online is null)                   as unknown,
         max(last_seen)                                           as latest_telemetry_at
    from vehicle_state
`;

/**
 * Vehicles that are not currently online, newest-silent first.
 *
 * `online is not true` covers false AND null; the caller reports the two counts
 * separately from `FLEET_SUMMARY` so the distinction is never lost. Ordering by
 * `last_seen` puts the longest-silent vehicles first, which is the order the
 * question is actually asking about.
 */
export const VEHICLES_OFFLINE = `
  select vehicleno, last_seen, online, soc_pct, lat, lon, updated_at
    from vehicle_state
   where online is not true
   order by last_seen asc nulls first
   limit $1
`;

/** Fleet current state, bounded. Reads `vehicle_state` only — never telemetry. */
export const FLEET_CURRENT_STATE = `
  select vehicleno, last_seen, last_gps_at, last_battery_at, last_fuel_at,
         lat, lon, speed_kph, heading, ignition, gps_fix,
         soc_pct, pack_voltage, pack_current, pack_temp_c, charging,
         fuel_pct, range_km, online, open_alert_count, updated_at
    from vehicle_state
   order by vehicleno asc
   limit $1
`;

/* -------------------------------------------------------------------------- */
/*  Registry — vehicles                                                       */
/* -------------------------------------------------------------------------- */

export const VEHICLE_REGISTRY_ONE = `
  select vehicleno, makemodel, deviceid, owner, geofence_id, capacity_kwh,
         created_at, updated_at
    from vehicles
   where vehicleno = $1
`;

export const VEHICLE_REGISTRY_LIST = `
  select vehicleno, makemodel, deviceid, owner, geofence_id, capacity_kwh,
         created_at, updated_at
    from vehicles
   order by vehicleno asc
   limit $1
`;

/* -------------------------------------------------------------------------- */
/*  Distance — distance_rollup                                                */
/* -------------------------------------------------------------------------- */

/**
 * Daily distance for one vehicle. Uses `idx_distrollup_v (vehicleno, time DESC)`.
 *
 * `bucket_size = 'day'` is pinned rather than assumed: it is the only value
 * present today, and pinning means a future hourly bucket cannot silently double
 * every total.
 */
export const DISTANCE_BY_VEHICLE = `
  select vehicleno, time, distance_km, energy_kwh, moving_seconds
    from distance_rollup
   where vehicleno = $1
     and bucket_size = 'day'
     and time >= $2
     and time <= $3
   order by time desc
   limit $4
`;

/**
 * Fleet distance over a window — the ONLY fleet-scope aggregate in the
 * catalogue, and it is safe precisely because `distance_rollup` is already
 * rolled up (25,163 rows, ~145 ms). The equivalent question asked of
 * `telemetry_gps` would time out.
 */
export const DISTANCE_FLEET = `
  select vehicleno,
         sum(distance_km)                                  as distance_km,
         sum(energy_kwh)                                   as energy_kwh,
         sum(moving_seconds)                               as moving_seconds,
         min(time)                                         as first_day,
         max(time)                                         as last_day,
         count(*)                                          as days
    from distance_rollup
   where bucket_size = 'day'
     and time >= $1
     and time <= $2
   group by vehicleno
   order by sum(distance_km) desc nulls last
   limit $3
`;

/* -------------------------------------------------------------------------- */
/*  Alerts                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Open alerts for one vehicle. Uses the partial index
 * `idx_alerts_open (vehicleno, time DESC) WHERE resolved_at IS NULL`, so the
 * `resolved_at is null` predicate is load-bearing for performance as well as
 * meaning — dropping it would scan 297,156 rows instead of a fraction of them.
 */
export const OPEN_ALERTS_BY_VEHICLE = `
  select vehicleno, time, alert_type, severity, message, value, threshold, resolved_at
    from alerts
   where vehicleno = $1
     and resolved_at is null
   order by time desc
   limit $2
`;

/** Open alerts across the fleet, newest first. Bounded; never unlimited. */
export const OPEN_ALERTS_FLEET = `
  select vehicleno, time, alert_type, severity, message, value, threshold, resolved_at
    from alerts
   where resolved_at is null
   order by time desc
   limit $1
`;

/* -------------------------------------------------------------------------- */
/*  Raw telemetry — per-vehicle, windowed, limited. Never fleet-scope.        */
/* -------------------------------------------------------------------------- */

/**
 * Battery history for ONE vehicle inside a window, newest first.
 *
 * `vehicleno = $1` leads the predicate so `idx_batt_vehicle_time` is driven;
 * with a time-only filter this same query full-scans the default partition and
 * is cancelled at 20s. Measured ~640 ms for a one-day window at LIMIT 200.
 *
 * `soh_pct` is not selected.
 */
export const BATTERY_HISTORY = `
  select vehicleno, time, soc_pct, pack_voltage, pack_current, pack_temp_c,
         cell_min_mv, cell_max_mv, charging
    from telemetry_battery
   where vehicleno = $1
     and time >= $2
     and time <= $3
   order by time desc
   limit $4
`;

/** GPS history for one vehicle inside a window. Measured ~150 ms. */
export const GPS_HISTORY = `
  select vehicleno, time, lat, lon, speed_kph, heading, ignition, gps_fix, ext_voltage
    from telemetry_gps
   where vehicleno = $1
     and time >= $2
     and time <= $3
   order by time desc
   limit $4
`;

/**
 * CAN history for one vehicle, ONE ROW PER TIMESTAMP.
 *
 * `DISTINCT ON (time)` is mandatory, not an optimisation. MEASURED 2026-08-13:
 * one vehicle held 766 rows across 325 distinct timestamps. Without the
 * deduplication a count of readings is inflated ~2.4x and any average is
 * weighted by how many times a row happened to be duplicated — the same reason
 * the Analysis Engine collapses samples by measurement instant.
 *
 * The inner ordering `(time desc, vehicleno)` is what `DISTINCT ON` requires;
 * the outer select re-orders for the caller.
 */
export const CAN_HISTORY = `
  select vehicleno, time, payload
    from (
      select distinct on (time) vehicleno, time, payload
        from telemetry_can
       where vehicleno = $1
         and time >= $2
         and time <= $3
       order by time desc, vehicleno
    ) deduped
   order by time desc
   limit $4
`;

/**
 * The newest raw reading per feed for one vehicle — the fallback when
 * `vehicle_state` has no row for it.
 *
 * Ordered and limited to 1 on an indexed prefix, so it is a single index seek
 * rather than a scan.
 */
export const LATEST_BATTERY_RAW = `
  select vehicleno, time, soc_pct, pack_voltage, pack_current, pack_temp_c,
         cell_min_mv, cell_max_mv, charging
    from telemetry_battery
   where vehicleno = $1
   order by time desc
   limit 1
`;

export const LATEST_GPS_RAW = `
  select vehicleno, time, lat, lon, speed_kph, heading, ignition, gps_fix, ext_voltage
    from telemetry_gps
   where vehicleno = $1
   order by time desc
   limit 1
`;

/* -------------------------------------------------------------------------- */
/*  Historical communication window                                           */
/* -------------------------------------------------------------------------- */

/**
 * How many registered assets reported telemetry inside a window.
 *
 * ## This is the ONE fleet-scope query that reads a raw telemetry table
 *
 * It is permitted only because of its SHAPE. The forbidden pattern is a
 * predicate naming `time` alone, which cannot use `idx_gps_vehicle_time` and
 * full-scans the default partition — MEASURED at 20,273 ms, cancelled by
 * `statement_timeout`, for a 30-day window.
 *
 * This is a LOOSE INDEX SCAN instead: it walks the 335-row registry and does one
 * index-only EXISTS seek per vehicle, so `vehicleno` is always pinned and the
 * index leads. VERIFIED plan, 2026-08-13:
 *
 *   Nested Loop Semi Join
 *     -> Index Only Scan using vehicles_pkey on vehicles v
 *     -> Index Only Scan using telemetry_gps_default_vehicleno_time_idx
 *          Index Cond: (vehicleno = v.vehicleno) AND (time >= $1)
 *
 * No sequential scan appears. MEASURED: 146 ms at 30 days, 4,753 ms at 90 days
 * cold. The 90-day figure is why the window is capped there rather than at the
 * catalogue's usual 180 — 4.7s against a 20s ceiling is four-fold headroom, and
 * the cost grows with the window while the cache state is not ours to control.
 *
 * ## Why `telemetry_gps` and not the alternatives
 *
 * `vehicle_state.last_seen` CANNOT answer this. Its `last_seen` and `updated_at`
 * are written within 1.3 ms of each other and the whole table begins
 * 2026-08-11 — a two-day horizon — so it returns 334 for 30, 60 and 90 days
 * alike. That is not a fleet that has been fully active for three months; it is
 * a table that cannot see that far back.
 *
 * `distance_rollup` cannot answer it either. It holds ZERO rows with
 * `distance_km = 0` or null across all 25,163, so it records only days a vehicle
 * MOVED. A vehicle reporting from a depot all month is absent from it. It agrees
 * with GPS on this fleet (313/320) but that is a property of these vehicles, not
 * a guarantee, and "moved" is not "communicated".
 *
 * ## What this query does and does not prove
 *
 * It measures communication AS SEEN BY THE GPS FEED. A vehicle reporting battery
 * or CAN data but no GPS is not counted. The result says so explicitly rather
 * than letting a caller read "communicated" as "communicated by any means" — see
 * `COMMUNICATION_FEED_NOTE`.
 *
 * The upper bound is bound rather than left open so the answer is a function of
 * the caller's clock, not of when the query happened to run.
 */
export const FLEET_COMMUNICATION_WINDOW = `
  select (select count(*) from vehicles) as registered_assets,
         (select count(*)
            from vehicles v
           where exists (
                   select 1
                     from telemetry_gps g
                    where g.vehicleno = v.vehicleno
                      and g.time >= $1
                      and g.time <= $2
                 )) as communicating_assets
`;

/* -------------------------------------------------------------------------- */
/*  Existence                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Does this identifier exist in the IoT registry?
 *
 * Asked FIRST by every per-vehicle read, so "no rows" can be reported as either
 * "this vehicle is not in this database" or "this vehicle has no data in that
 * window" — two different answers that an empty result set alone cannot tell
 * apart. `requireVehicle` in telemetry.reader.ts exists for the same reason.
 */
export const VEHICLE_EXISTS = `
  select vehicleno from vehicles where vehicleno = $1
`;
