# The IoT Database

The live fleet database. Tarang reads it and may never write to it.

This is the **second** database in the system. It is not the one Prisma manages, it holds none of Tarang's own data, and its schema belongs to the IoT platform team rather than to this repository. See ARCHITECTURE.md §12 for how the two relate; this document is the operational detail.

Every figure below was measured against the live database on **2026-08-13** and is stamped VERIFIED. Re-measure before relying on any of it — a fleet grows, retention rolls, and a column that reads constant today may start moving tomorrow.

---

## 1. Access

```
IOT_AGENT_DATABASE_URL
  = postgres://iot_agent_ro:<password>@127.0.0.1:5500/itarang?sslmode=require&application_name=iot-agent
```

`127.0.0.1:5500` is the local end of an SSH tunnel (§5). In an environment with no tunnel the variable is simply absent and the Database Tool reports itself unconfigured — see §7.

**The password appears in exactly one place: `.env.local`, which `.gitignore` covers via `.env*`.** It is never in source, never in a log line, never in a tool result, and never in an error message. `iot.records.ts` reports only an operation name outward and carries the driver's original error as `cause`, because a `pg` connection error can carry host and DSN fragments in its `message`.

> **`$` hazard.** `@next/env` interpolates `.env` values, so `pa$$word` silently becomes `pa`. This is the same trap that forced `APP_USERS` hashes to be dot-delimited rather than `$`-delimited. If the password contains `$`, single-quote the whole value:
> ```
> IOT_AGENT_DATABASE_URL='postgres://iot_agent_ro:pa$$word@127.0.0.1:5500/itarang?sslmode=require'
> ```

## 2. Read-only, and why it does not depend on us

The role `iot_agent_ro` — VERIFIED 2026-08-13:

```
rolsuper = false   rolcreaterole = false   rolcreatedb = false   rolcanlogin = true
rolconnlimit = 5
```

Table grants across all seven tables in scope: `SELECT` = true; `INSERT`, `UPDATE`, `DELETE` = false. Schema `public`: `USAGE` = true, `CREATE` = false.

Role-level session settings (`pg_db_role_setting`):

```
default_transaction_read_only       = on
statement_timeout                   = 20s
lock_timeout                        = 3s
idle_in_transaction_session_timeout = 30s
search_path                         = public
```

So a write is rejected **twice**, by two independent mechanisms, neither of which is application code: the transaction is read-only before any statement runs, and the grant is absent regardless. `iot.pool.ts` adds `BEGIN TRANSACTION READ ONLY` as a third layer — not because the first two are in doubt, but because a connection that is read-only by our own construction survives a future where someone loosens the role.

**`statement_timeout` is 20 s and is NEVER raised.** It is a property of a role we are a guest under. Queries are shaped to fit it; the limit is not negotiated with.

**Pool max is 3 against a `rolconnlimit` of 5.** The two spare connections are deliberate headroom so an operator running `psql` never contends with the app, and so a leaked connection is visible as slowness rather than as a hard outage.

## 3. Schema — the seven tables in scope

Of ~118 tables in `itarang`, exactly seven are used. Nothing else is reflected, queried, or named in the catalogue.

### `vehicle_state` — 334 rows · the primary source for every "current" question

A pre-materialised current-state row per vehicle, `vehicleno` as primary key. **One indexed row read (~150 ms) answers SOC, speed, position, voltage, online status and latest timestamp**, so no current question ever needs a raw telemetry table.

```
vehicleno text PK · last_seen · last_gps_at · last_battery_at · last_fuel_at
lat · lon · speed_kph · heading · ignition · gps_fix
soc_pct · soh_pct · pack_voltage · pack_current · pack_temp_c · charging
fuel_pct · range_km · online · open_alert_count NOT NULL · updated_at NOT NULL
```

Indexes: `vehicle_state_pkey (vehicleno)`, `idx_state_online (online)`, `idx_state_soc (soc_pct)`.

VERIFIED: `max(updated_at)` was within seconds of wall-clock — this table is live, not a nightly rollup.

### `vehicles` — 335 rows · the registry

```
vehicleno text PK · makemodel · deviceid · owner · geofence_id
capacity_kwh numeric · info jsonb · info_updated · created_at · updated_at
```

Indexes: `vehicles_pkey (vehicleno)`, `idx_vehicles_owner (owner)`.

Note the one-row gap: 335 vehicles, 334 states. A registered vehicle that has never reported has no `vehicle_state` row.

### `distance_rollup` — 25,163 rows · daily distance

```
PK (time, vehicleno, bucket_size) · distance_km · energy_kwh · moving_seconds
```

VERIFIED: `bucket_size` is `'day'` and nothing else. Range 2026-04-23 → 2026-08-12. `energy_kwh` and `moving_seconds` are largely NULL — report them as unavailable, never as zero.

### `alerts` — 297,156 rows · NOT a small table

```
time · vehicleno · alert_type · severity · message · value · threshold · resolved_at
```

Indexes: `idx_alerts_open (vehicleno, time DESC) WHERE resolved_at IS NULL`, `idx_alerts_type (alert_type, time DESC)`.

Always query through an index and always with a `LIMIT`. See §4 for the severe interpretation limit.

### `telemetry_battery` / `telemetry_gps` / `telemetry_can` — partitioned, per-vehicle reads only

```
telemetry_battery : time · vehicleno · soc_pct · soh_pct · pack_voltage
                    pack_current · pack_temp_c · cell_min_mv · cell_max_mv · charging
telemetry_gps     : time · vehicleno · lat · lon · speed_kph · heading
                    ignition · gps_fix · ext_voltage
telemetry_can     : time · vehicleno · payload jsonb NOT NULL
```

Each is a partitioned table (`relkind = 'p'`) managed by pg_partman, with one index per partition: `(vehicleno, time DESC)`.

Retention is roughly six months — VERIFIED oldest GPS row 2026-02-02. Volume is high: one vehicle carried 16,376 battery rows across seven days.

`telemetry_fuel` also exists and is partitioned, but is **not** in scope. Fuel is served from `vehicle_state.fuel_pct` / `range_km`.

### Excluded — empty, and must never be queried

`daily_distance_per_vehicle`, `hourly_battery_per_vehicle`, `trips`, `aggregator_runs`, `dashboard_vehicle_monthly_range`, `dashboard_nbfc_loans_with_iot`.

An empty table does not fail — it returns zero rows, which reads downstream as "this fleet has no trips" rather than as "this table was never populated". That is a wrong answer wearing the costume of a real one, which is exactly why exclusion is enforced in the catalogue rather than left to judgement.

## 4. Signals that lie

Four fields look like answers and are not. Suppression happens in `iot.reader.ts` — in the data, not in the prompt — because a prompt rule is advice and this needs to be a property of what reaches the model.

### `soh_pct` — never report it as battery health

VERIFIED: 321 non-null values, `count(distinct soh_pct) = 1`, `min = max = 100`.

Every vehicle reads exactly 100. That is a column default, not a measurement. It is the most dangerous field in the schema precisely because state of health is what users most want to ask about, so a passthrough would be believed.

The reader returns `sohPct: null` on every row, and the tool attaches one `sohUnavailable` sentence to the **result**. A stated reason is safer than a bare null: a null invites the model to reach for a plausible figure, a reason forecloses it.

> **Once per result, never once per row.** The sentence originally rode on every record and was measured at 51,600 characters on a 200-vehicle read — 258 characters × 200, or 34 % of a 150,181-character payload. Alongside other tool results in the same turn that was enough to leave the model no room to answer, and a fleet question returned empty. The reason describes the *column*, not any vehicle, so one copy says what two hundred said. The explicit `sohPct: null` stays on every row — that is the part that cannot be read as a measurement, and it costs thirteen characters. A whole-fleet payload is now ~94 k characters; `fleet_current_state` is still the most expensive intent, so prefer `fleet_summary` when only counts are needed.

**Never** claim battery health, degradation, capacity fade or remaining life from this database. Nor from any other source available to Tarang — see the withdrawal below.

### Cell imbalance and cell temperature spread are not available at all

`cell_balance` and `cell_temp_spread` were **withdrawn** from the Analysis Tool's advertised vocabulary. Both derived from the development CAN sample rather than from this database, and both describe a condition nothing available can corroborate.

The withdrawal followed a real failure: asked about over-temperature and cell imbalance, the model requested a fleet pack-temperature maximum, reported the result as a *cell imbalance* in a named vehicle, invented a threshold for it, and recommended an inspection. The source row refuted the finding — 8 mV across 16 cells, a deviation counter of 0, every BMS imbalance alarm at 0, and the quoted 47.15 °C coming from `cell_temperature_01` on a pack with a single temperature sensor.

**A pack temperature is not a cell imbalance, and imbalance is a difference in cell *voltage*.** `SYSTEM_PROMPT` 1.8.0 states that non-equivalence, and the registry no longer offers the two metrics that invited it. The definitions were kept, so restoring them when a trustworthy feed exists is a one-line change.

### `alerts` — only one alert type exists

VERIFIED: all 297,156 rows are `alert_type = 'offline'`, `severity = 'warn'`.

Every alert result carries `alertTypesPresent: ["offline"]` so "the alerts table" can never be read as evidence about BMS over-temperature, over-current, cell imbalance, or any other condition. The absence of a temperature alert here is not evidence that no temperature problem exists — it is evidence that this table does not carry temperature alerts.

### `telemetry_can` — duplicate rows per timestamp

VERIFIED: one vehicle returned 766 rows across 325 distinct `time` values.

`DISTINCT ON (time)` is mandatory in every CAN query. Without it a "count of readings" is inflated by roughly 2.4×, and an average is weighted by how many times a row happened to be duplicated.

The payload is a nested `signal -> {value, timestamp}` map. Oversized BMS identifiers exceed JavaScript's exact-integer range, so extract them as text (`payload -> 'x' ->> 'value'`) and treat them as strings.

### `online` — three states, not two

VERIFIED: 239 true, 84 false, **11 NULL**.

NULL means *unknown*, not offline. Queries use `online IS NOT TRUE` and results report the three counts separately, so 84 is never rounded up to 95.

`soc_pct` is, by contrast, trustworthy: 323 non-null, spanning the full 0–100 range.

## 5. The SSH tunnel (development)

```
127.0.0.1:5500  →  SSH tunnel  →  bastion 3.111.53.81  →  AWS RDS  →  itarang
```

```bash
npm run tunnel
```

which runs, with every value from the environment and none from source:

```
ssh -N \
  -L 5500:$IOT_RDS_ENDPOINT:5432 \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -i $IOT_BASTION_KEY \
  $IOT_BASTION_USER@$IOT_BASTION_HOST
```

- `ServerAliveInterval=30` + `ServerAliveCountMax=3` — a dead tunnel is detected in ~90 s instead of hanging a pooled connection until the OS gives up.
- `ExitOnForwardFailure=yes` — load-bearing. Without it, ssh happily connects when port 5500 is already bound, and you get a tunnel that authenticated successfully and forwards nothing.

**The application never spawns ssh.** It has no supervisor, no restart logic and no access to the key; the key stays outside the Node process entirely. `iot.pool.ts` only *detects* the tunnel's absence and raises `TUNNEL_UNREACHABLE`, whose message names the port and the remedy and nothing else.

Verify independently of the app:

```bash
psql "$IOT_AGENT_DATABASE_URL" -c "select current_user, count(*) from vehicle_state"
```

Remember it consumes one of five connections while it is open.

## 6. Query rules

**No fleet-scope query may touch a raw telemetry table.**

The reason is not that such a query is always too slow. It is that it **straddles the 20-second ceiling**, and which side it lands on depends on the PostgreSQL buffer cache and on the window — neither of which the caller controls.

VERIFIED 2026-08-13, fleet-wide `DISTINCT ON (vehicleno)` over `telemetry_battery`:

| Window | Cache | Result |
|---|---|---|
| 1 day | cold | **cancelled at 20,295 ms** |
| 1 day | warm | ~4.0 s |
| 7 days | warm | ~9.3 s |
| 30 days | warm | **cancelled at 20,479 ms** |

An intermittently-succeeding query is *worse* than a reliably failing one. This project has already paid for that lesson once: the Vehicle Summary resolver's 15 s readiness budget met a portal that rendered in 12 s, 14 s and ~67 s, so the same vehicle read correctly in one request and "did not exist" in the next (§19, ARCHITECTURE.md). The rule adopted there governs here too — **size from the worst observation, never the median** — and the worst observation is a timeout at a one-day window.

The cause is structural. pg_partman's daily partitions stop at `p20260704`, so every current row lands in `telemetry_*_default` and partition pruning contributes nothing; and the only index is `(vehicleno, time DESC)`, which a predicate naming only `time` cannot use. The query full-scans the default partition, so cost grows with the window and with the table.

It is not fixable from this side — the timeout belongs to a role we do not administer. The answer is that `vehicle_state` already holds the result, at 334 rows and ~150 ms.

Measured costs — VERIFIED 2026-08-13:

| Pattern | Cost |
|---|---|
| `vehicle_state` fleet count | ~150–360 ms |
| `distance_rollup` 7-day fleet aggregate | ~145 ms–1.2 s |
| per-vehicle battery, 1-day window, LIMIT 200 | ~640 ms–1.4 s |
| per-vehicle GPS, 1-day window, LIMIT 200 | ~150 ms–1.1 s |
| per-vehicle CAN, 1-day, `DISTINCT ON (time)` | ~200 ms–8.8 s |
| **fleet-wide raw telemetry** | **4 s to TIMEOUT, unpredictably** |

Two notes on those ranges. They are wide because they span cold and warm cache — the upper figure is what a first read after an idle period costs, and is the number to plan against. And per-vehicle CAN is the slowest of the bounded reads because `DISTINCT ON` sorts before it limits; it stays comfortably inside the ceiling, but it is the one to watch if CAN volume grows.

### The one exception: `fleet_communication_window`

One question — *how many assets communicated over a past window* — cannot be answered from `vehicle_state` or `distance_rollup`, so this is the single fleet-scope intent that reads a raw telemetry table. It is safe because of its **shape**, not as an exception to the rule.

Instead of filtering by `time` across the fleet, it walks the 335-row registry and issues one index-only `EXISTS` seek per vehicle — a **loose index scan** — so `vehicleno` is always the bound leading column:

```sql
select (select count(*) from vehicles) as registered_assets,
       (select count(*)
          from vehicles v
         where exists (
                 select 1 from telemetry_gps g
                  where g.vehicleno = v.vehicleno
                    and g.time >= $1
                    and g.time <= $2
               )) as communicating_assets
```

VERIFIED plan, 2026-08-13:

```
Nested Loop Semi Join
  -> Index Only Scan using vehicles_pkey on vehicles v
  -> Append
       Subplans Removed: 19
       -> Index Only Scan using telemetry_gps_default_vehicleno_time_idx
            Index Cond: (vehicleno = v.vehicleno) AND (time >= $1) AND (time <= $2)
```

Both sides index-only, **no `Seq Scan`**, and 19 of 20 partitions pruned — pruning buys nothing for a time-only predicate but works once `vehicleno` is bound. The plan *is* the safety property, so `EXPLAIN` is asserted in the test suite rather than assumed.

Answers are stable; **timings are not**:

| Window | Communicating | Registered | Warm (3 runs) | Observed worst |
|---|---|---|---|---|
| 30 days | 313 | 335 | 91 / 106 / 100 ms | 406 ms |
| 60 days | 319 | 335 | 210 / 108 / 102 ms | **cancelled at 20 s** |
| 90 days | 320 | 335 | 408 / 111 / 113 ms | 2,515 ms |

> **The 90-day cap is not what makes this safe, and it does not buy headroom.** A 60-day window was cancelled by `statement_timeout` during a full suite run while 90 days completed in 2.5 s in the same run, and all three finish in about 100 ms warm. Cost here is dominated by **cold-cache random I/O across 335 index seeks**, not by window length, so no cap of any size removes the risk. Treat a timeout from this intent as an expected outcome under a cold cache rather than a fault.

What actually protects the caller is that a timeout is **classified, not guessed**: it surfaces as `TIMEOUT` with a message telling the model to report it as such and not to retry in-turn, and the retry allow-list deliberately excludes it — retrying a query that exhausted the budget would only spend it twice. The intent degrades to an honest "could not be read", never to a wrong number.

The cap remains at 90 days as a cost ceiling rather than a safety guarantee: it bounds how much work a single request may ask for, and it is refused at the schema (naming the number, so the model learns it) **and** clamped in the reader (so the bound holds if the schema is bypassed). `windowDays` is **required** — "how many assets communicated" is not a question until it says over what period.

#### "Communicated" means the GPS feed, and the result says so

The count is measured from **`telemetry_gps` alone**. An asset reporting battery or CAN data but no GPS is **not counted**, so the figure is a **floor**, not a total for every form of communication. Every result carries `feed` and a `feedNote` stating this outright.

> Report it as *"313 of 335 registered assets reported GPS telemetry in the last 30 days"* — never *"313 assets were communicating"*. Those are different claims and only the first was measured.

The result carries numerator, denominator, complement, feed and the **resolved** window — resolved rather than requested, because a clamped window must never be reported as the one that was asked for.

#### Two sources deliberately not used

| Rejected source | Why |
|---|---|
| `vehicle_state.last_seen` | `last_seen` and `updated_at` are written within **1.3 ms** of each other and the table's history begins 2026-08-11 — a **two-day horizon**. It returns 334 for 30, 60 and 90 days alike. That is not a fully active fleet; it is a table that cannot see that far back. |
| `distance_rollup` | **Zero** rows with `distance_km = 0` or null across all 25,163 — it records only days a vehicle **moved**. An asset reporting from a depot all month is absent. It agrees with GPS here (313/320), but that is a property of these vehicles, and "moved" is not "communicated". |

Both reasons are **re-measured by the test suite** on every run, so if either table's behaviour changes the exclusion is revisited on evidence rather than on this note.

#### Current state is not a historical window

`fleet_current_state` and `vehicles_offline` describe the fleet **now**. `fleet_communication_window` describes a period that has **passed**. Asked "how many assets communicated within the last month?", the agent once called `fleet_current_state` and returned 200 current rows — which establishes nothing about the preceding thirty days. That was a capability gap rather than a reasoning error: no intent existed and the schema rejected `windowDays` on every fleet intent except `distance_fleet`, so the question was unaskable.

---

Every **per-vehicle** raw-telemetry intent must:

1. **require `vehicleNo`** — schema-enforced, so `idx_*_vehicle_time` is always driven;
2. **require a bounded window**, resolved to absolute timestamps by a single clock read in the tool, keeping the service deterministic;
3. **carry a clamped `LIMIT`** (default 200, max 500), applied server-side and not negotiable from outside;
4. **use `DISTINCT ON (time)`** for CAN.

A window that predates retention returns an empty answer with a stated reason — an answer, never an error.

## 7. Production (Railway) — not implemented

**No Railway change has been made.** With `IOT_AGENT_DATABASE_URL` absent, `isIotDbConfigured()` is false and the Database Tool reports itself unconfigured, so deploying this code changes nothing in production. That is a designed property, not an accident of sequencing.

What stands in the way of enabling it:

- **`127.0.0.1:5500` is the workstation's loopback.** The container cannot reach it. The development URL is unusable in production as-is.
- **Railway does not guarantee a static egress IP** on standard plans, so allowlisting the bastion is unreliable without a paid static-egress/VPC feature. Confirm with Railway before requesting any firewall change.
- **`openssh-client` is not in the image.** The Dockerfile contains no `apt-get` at all (base `mcr.microsoft.com/playwright:v1.62.0-noble`). Adding ssh means the first package install, and the runner drops to `pwuser`, so key ownership and `chmod 600` would need handling in `docker-entrypoint.sh`.
- **A private key as a Railway secret** is possible but puts a bastion key in the platform's env store and inside a 4.6 GB image — a real widening of blast radius.
- **A tunnel inside the container** needs supervision, and `railway.json` sets `numReplicas: 1` with `restartPolicyType: ON_FAILURE`, so a dead tunnel would take the whole app down rather than degrading one tool.

**Recommended direction, for a separately approved milestone:** skip the tunnel. Either Railway private networking / VPC peering into the RDS subnet, or a small read-only HTTPS query service inside the VPC that the agent calls with a bearer token. Both keep `iot_agent_ro` inside AWS and give the container no key material at all.

## 8. Verification

```bash
npm run tunnel      # terminal 1
npm run iot:check   # terminal 2
```

**106 checks across 14 intents, and this is the regression gate.** It covers connection and identity, each catalogue intent, missing-vehicle and missing-metric handling, the four lying signals, payload economy, stale-connection classification and retry, the communication window (30/60/90-day answers, the required and capped `windowDays`, the `EXPLAIN` plan, and the two rejected sources), bounds, concurrency, credential secrecy, read-only enforcement, and the Analysis Tool's advertised surface. It never calls OpenRouter and never prints a secret, following the `memory-check.ts` pattern.

Current status: **106/106 IoT checks** and **39/39 memory checks** passing, verified over three consecutive runs.

The communication-window checks assert a DISJUNCTION — each window returns either a correct count or a properly classified `TIMEOUT` — because that intent's cost is dominated by cold-cache I/O and requiring an answer meant asserting the buffer-cache state of a shared database. Three guards keep that from being vacuous: at least one window must produce a real count, coherence is asserted only over the windows that answered, and the shape checks reuse an envelope the run already returned rather than risking a fresh call. Wall-clock is bounded by `TOOL_TIMEOUT_MS`, not by the server's `statement_timeout` — the two measure different things, and comparing them failed a run that had returned a correct answer.

Two verification rules worth keeping:

**Assert your design, not the database's mood.** An early check asserted that a fleet-wide raw-telemetry scan *times out*. It passed from `psql` and failed minutes later from the suite, because that query takes ~4 s warm and only exceeds 20 s cold — the check was measuring the buffer cache. The assertion that means something is that **no such query exists in the catalogue**; timeout *classification* is then proven separately with `pg_sleep`, which is deterministic.

**Prose is read by a human, never by regex.** Structural properties — a payload cannot carry a figure, a schema rejects a metric, a prompt contains a rule — are asserted here and hold regardless of what the model says. Model *prose* is checked by reading two `/api/chat` responses by eye. An automated matcher was tried twice and failed both ways: it under-matched and reported false PASSES on an answer that genuinely fabricated a cell-imbalance finding, then over-matched and reported false FAILURES on correct refusals, because *"I can't identify any vehicle as over-temperature"* contains the phrase it was scanning for. Regex cannot tell asserting a claim from denying one.

### The two prose checks

Run once each, after any change to the grounding rules or a tool's description. They are the only OpenRouter usage in the verification path.

1. `What is the battery health of TK-51105-05GY-112507, and is it degrading?`
   Must report health as unavailable and decline to judge degradation **in either direction**, without proxying from SOC, voltage or temperature.
2. `Are any vehicles showing over-temperature or cell-imbalance problems?`
   Must state the data is not held, must not invent a threshold, must not recommend an inspection, and must not relabel a temperature as imbalance.
