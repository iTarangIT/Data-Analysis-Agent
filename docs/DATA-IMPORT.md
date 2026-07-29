# Manual Telemetry Import

Tarang's telemetry tables are populated **manually** from three datasets — Battery, GPS and CAN. There is no Prisma seed script and no automated importer, by design: the data is loaded once from files you control, not generated.

This document is the runbook for that load.

---

## 1. Prerequisites

**A local PostgreSQL database named `tarang_dev`**, with the schema applied:

```bash
npm run db:migrate     # or: npm run db:deploy
npm run db:status      # confirm: "Database schema is up to date!"
```

**`DATABASE_URL` in `.env.local`.** This is the only place the connection string lives — both the Next.js app and every Prisma CLI command read it from there:

```
DATABASE_URL="postgresql://<user>:<password>@localhost:5432/tarang_dev?schema=public"
```

`.env.local` is gitignored (`.gitignore` covers `.env*`), so credentials never reach the repository. No default or example value is committed anywhere. A missing `DATABASE_URL` fails immediately — at app boot via `src/lib/env.ts` (SAD §16), and on any Prisma command needing a connection.

---

## 2. Where to put the dataset files

Drop the three files in `data/samples/`:

```
data/
└── samples/
    ├── telemetry_battery.csv
    ├── telemetry_gps.csv
    └── telemetry_can.csv
```

`/data/` is gitignored. Telemetry files are large and often operationally sensitive; they stay on your machine.

---

## 3. Why the import needs staging tables

**You cannot `\copy` these CSVs directly into the telemetry tables.** The files carry a `vehicleno` text column (`TK-51105-02AZ-179386`); the tables carry a `vehicle_id` bigint foreign key. Something has to resolve one to the other, and `\copy` cannot join.

The load is therefore three steps: **stage → register vehicles → insert with a join**. Deduplication happens at the insert step, which is where the agreed design puts it — the schema deliberately carries no unique constraint on `(vehicle_id, recorded_at)`.

Known duplication in the samples:

| Dataset | Rows | Unique rows | Note |
|---|---|---|---|
| Battery | 100 | 100 | no duplicates |
| GPS | 100 | **53** | 47 byte-identical duplicates, one timestamp repeats 17× |
| CAN | 100 | **79** | 21 byte-identical duplicates |

In both cases the duplicate rows are *byte-identical*, so `SELECT DISTINCT` is lossless — it removes repeats, never conflicting readings.

---

## 4. Import

Run from the project root so the relative CSV paths resolve:

```bash
psql "$DATABASE_URL"
```

### 4.1 Create staging tables

These mirror the CSV shape exactly — including `vehicleno` and the raw `payload` text.

```sql
CREATE UNLOGGED TABLE stg_battery (
  "time"       timestamptz,
  vehicleno    text,
  soc_pct      numeric,
  soh_pct      numeric,
  pack_voltage numeric,
  pack_current numeric,
  pack_temp_c  numeric,
  cell_min_mv  integer,
  cell_max_mv  integer,
  charging     boolean
);

CREATE UNLOGGED TABLE stg_gps (
  "time"      timestamptz,
  vehicleno   text,
  lat         numeric,
  lon         numeric,
  speed_kph   numeric,
  heading     numeric,
  ignition    boolean,
  gps_fix     boolean,
  ext_voltage numeric
);

CREATE UNLOGGED TABLE stg_can (
  "time"    timestamptz,
  vehicleno text,
  payload   text          -- kept as text so DISTINCT compares raw bytes
);
```

`UNLOGGED` skips WAL writes — these tables are dropped at the end and never need crash recovery.

### 4.2 Load the files

```sql
\copy stg_battery FROM 'data/samples/telemetry_battery.csv' WITH (FORMAT csv, HEADER true, NULL 'NULL')
\copy stg_gps     FROM 'data/samples/telemetry_gps.csv'     WITH (FORMAT csv, HEADER true, NULL 'NULL')
\copy stg_can     FROM 'data/samples/telemetry_can.csv'     WITH (FORMAT csv, HEADER true, NULL 'NULL')
```

`NULL 'NULL'` is required and not optional. The Battery file writes missing values as a bare `NULL` token while writing real values quoted — without this clause every empty cell imports as the literal four-character string `NULL` and the numeric casts fail. Because the token is unquoted in the file and CSV mode only treats *unquoted* fields as null markers, a genuine `"NULL"` string value would still survive intact.

Booleans arrive as bare `False` / `True`, which PostgreSQL accepts case-insensitively. The CAN payload arrives with CSV-doubled quotes (`""`), which `\copy` unescapes back into valid JSON text.

### 4.3 Register vehicles

Vehicles must exist before telemetry, because all three tables reference them. Build the dimension from all three files at once — the datasets do not cover the same vehicles (Battery and GPS hold one vehicle; CAN holds 70).

```sql
INSERT INTO vehicles (vehicle_no)
SELECT vehicleno FROM stg_battery
UNION
SELECT vehicleno FROM stg_gps
UNION
SELECT vehicleno FROM stg_can
ON CONFLICT (vehicle_no) DO NOTHING;
```

`ON CONFLICT DO NOTHING` makes this step re-runnable.

### 4.4 Insert telemetry

Battery — no deduplication needed:

```sql
INSERT INTO battery_telemetry (
  vehicle_id, recorded_at, soc_pct, soh_pct, pack_voltage,
  pack_current, pack_temp_c, cell_min_mv, cell_max_mv, charging
)
SELECT v.id, s."time", s.soc_pct, s.soh_pct, s.pack_voltage,
       s.pack_current, s.pack_temp_c, s.cell_min_mv, s.cell_max_mv, s.charging
FROM stg_battery s
JOIN vehicles v ON v.vehicle_no = s.vehicleno;
```

GPS — `DISTINCT` collapses the 47 duplicate rows:

```sql
INSERT INTO gps_telemetry (
  vehicle_id, recorded_at, lat, lon, speed_kph, heading,
  ignition, gps_fix, ext_voltage
)
SELECT v.id, s."time", s.lat, s.lon, s.speed_kph, s.heading,
       s.ignition, s.gps_fix, s.ext_voltage
FROM (SELECT DISTINCT * FROM stg_gps) s
JOIN vehicles v ON v.vehicle_no = s.vehicleno;
```

CAN — `DISTINCT` on the raw text, then cast to `jsonb`:

```sql
INSERT INTO can_telemetry (vehicle_id, recorded_at, payload)
SELECT v.id, s."time", s.payload::jsonb
FROM (SELECT DISTINCT * FROM stg_can) s
JOIN vehicles v ON v.vehicle_no = s.vehicleno;
```

Deduplicating on the text column rather than on `jsonb` is deliberate: `jsonb` normalises key order and whitespace, so casting first would silently merge rows that were not byte-identical.

### 4.5 Clean up

```sql
DROP TABLE stg_battery, stg_gps, stg_can;
```

---

## 5. Verifying the load

Expected from the 100-row samples: **70 vehicles**, **100** battery rows, **53** GPS rows, **79** CAN rows.

```sql
SELECT
  (SELECT COUNT(*) FROM vehicles)          AS vehicles,
  (SELECT COUNT(*) FROM battery_telemetry) AS battery,
  (SELECT COUNT(*) FROM gps_telemetry)     AS gps,
  (SELECT COUNT(*) FROM can_telemetry)     AS can;
```

Confirm the timezone survived — these must read `2026-06-16` for Battery/GPS and `2026-06-25` for CAN:

```sql
SELECT MIN(recorded_at), MAX(recorded_at) FROM battery_telemetry;
SELECT MIN(recorded_at), MAX(recorded_at) FROM gps_telemetry;
SELECT MIN(recorded_at), MAX(recorded_at) FROM can_telemetry;
```

Confirm no duplicates survived:

```sql
SELECT vehicle_id, recorded_at, COUNT(*)
FROM gps_telemetry GROUP BY 1, 2 HAVING COUNT(*) > 1;   -- expect 0 rows
```

Confirm the oversized BMS identifiers are intact. `jsonb` stores numbers as arbitrary-precision `numeric`, so the digits survive in the database — but only if you read them **as text**. Reading them through a JavaScript number silently corrupts anything above 2^53:

```sql
SELECT payload -> 'bms_serial_no_1' ->> 'value' AS bms_serial
FROM can_telemetry LIMIT 5;
```

Inspect per-signal timestamps, which `recorded_at` does not capture — it equals only the *freshest* signal in the row:

```sql
SELECT recorded_at,
       to_timestamp(((payload -> 'soc' ->> 'timestamp')::bigint) / 1000.0) AS soc_measured_at,
       to_timestamp(((payload -> 'mfh' ->> 'timestamp')::bigint) / 1000.0) AS mfh_measured_at
FROM can_telemetry
WHERE payload ? 'mfh'
LIMIT 5;
```

`npm run db:studio` opens Prisma Studio for a visual check.

---

## 6. Re-importing

The schema carries **no unique constraint** on `(vehicle_id, recorded_at)`, by design — GPS and CAN both ship duplicates, so the constraint could not be satisfied without altering the source data. The consequence: **re-running section 4.4 doubles the rows.** It will not error.

To reload from scratch:

```sql
TRUNCATE battery_telemetry, gps_telemetry, can_telemetry, vehicles RESTART IDENTITY CASCADE;
```

`RESTART IDENTITY` resets the `BIGSERIAL` counters. This is irreversible — confirm you are connected to `tarang_dev` and not a shared database before running it:

```sql
SELECT current_database();
```

---

## 7. Known data-quality issues

These are preserved as-is in the database, not corrected on import. Anything reading this data should know about them:

- **Battery: five columns are 100% empty** in the sample (`pack_voltage`, `pack_temp_c`, `cell_min_mv`, `cell_max_mv`, `charging`) and `pack_current` has one value in 100 rows. Their column types follow the field spec, not observed data.
- **GPS: `ignition` is always `false` while `speed_kph` reaches 27.2 km/h.** Contradictory; stored unmodified.
- **GPS: `ext_voltage` reads 53–57 V**, which is pack-level rather than an auxiliary supply. It is deliberately *not* merged with `battery_telemetry.pack_voltage`.
- **CAN: six misspelled payload keys** (`volatge` ← `voltage`) appear in exactly one row, from a firmware variant. Other spelling inconsistencies exist across keys: `occurance`/`occurence`, `cummulative`, `thermal_runway_protection`.
- **CAN: `bms_serial_no_1` / `_2` lost precision upstream** — the values exceed 2^53 and already carry trailing zeros in the source file. Treat them as strings; do not trust them as exact identifiers.
- **CAN: per-signal timestamps can be days older than `recorded_at`.** The payload is a last-known-value snapshot, not a synchronous sample. Most rows carry three distinct signal timestamps.
- **The three datasets barely intersect.** Battery and GPS cover one vehicle on 2026-06-16; CAN covers 70 vehicles on 2026-06-25. The Battery/GPS vehicle appears in CAN exactly once, so cross-dataset joins on these samples return almost nothing.

---

## 8. What this document is not

Migrations are not part of the import. Schema changes ship as Prisma migrations (`npm run db:migrate`) and are committed to the repository; data is loaded separately by the steps above. Never hand-edit a table's structure in `psql` — the next migration will not know about it, and drift is painful to unwind.
