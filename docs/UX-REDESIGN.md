# Tarang — UX Redesign (design document, pre-implementation)

**Status:** proposal, awaiting approval. No code changes yet.
**Scope rule:** the backend architecture is preserved. Every change below is either
a rendering change, a wire-format addition, or one new leaf service. Nothing in
`src/services/analytics/`, `src/services/portal/` or `src/services/session/`
changes its responsibilities.

---

## 0. What the code already gives us (read this first)

Five findings from the current implementation. They decide what is a rendering
problem and what is a real engineering problem, and they are the reason this
redesign is mostly cheap.

### 0.1 The structured report already exists — and is being thrown away

`src/app/api/chat/route.ts` parses every tool envelope and then keeps only half
of it:

```
const envelope = parseToolEnvelope(event.data?.output);
if (envelope) sources.push(envelope.source);   // ← envelope.data is discarded
```

`envelope.data` is a fully-formed `MetricResult` (`src/tools/analysis.tool.ts`):
`metric`, `label`, `value`, `unit`, `available`, `reason`, `measuredAt`,
`reportedAt`, `detail`, `derivation`, `aggregation`, `reconciliation` (with
`conflict` and `otherSources`).

**Consequence:** "responses are too text-heavy" is not a prompt problem or a
model problem. The numbers, units, precision, timestamps, coverage, spans,
sample counts and conflicts are *already computed deterministically* and then
flattened into prose because prose is the only channel the UI has. Adding one
frame type to `ChatStreamFrame` unlocks the entire structured-report redesign.
This is the single highest-leverage change in the document.

### 0.2 Live / Historical / Unavailable are already first-class backend concepts

| UI state requested | Existing backend field |
|---|---|
| Live | `provenance.sourceClass === "live"`, `reconciliation.sourceClass` |
| Historical | `sourceClass === "historical"` |
| Unavailable | `available: false` + `reason` (never a zero — enforced in normalizers and projections) |
| Disputed | `reconciliation.disposition === "disputed"` |
| Substituted | `rule === "P5_substituted_after_unavailable"` |
| Stale-live demoted | `rule === "P4_stale_live_demoted"` |

**Estimated has no backend counterpart.** Nothing in the engine produces an
estimate. Per this codebase's own rule — *"a declared provider the engine cannot
reach is a promise the code does not keep"* — the Estimated state gets a
reserved token, a reserved colour and a reserved icon in the design system, and
**no component may render it** until something emits it. Reserving it in the
palette costs nothing; rendering it would be the first fabricated claim in the
system.

### 0.3 The progress timeline needs a new channel, but every stage in it is real

The route already observes `on_tool_start` / `on_tool_end` with tool name,
params and duration. That alone yields honest coarse stages today.

The fine stages the brief asks for — *"Reusing existing session"*,
*"Connecting to Intellicar"* — happen inside `session-manager.ts`,
`portal.service.ts` and `acquisition.ts`, which currently emit them only to
Pino:

- `"Reusing the stored Intellicar session."` — session-manager, after `probe === "valid"`
- `"Stored Intellicar session has expired; re-authenticating."`
- `"No stored Intellicar session; authenticating."`
- `"Portal module read."` with `module` and `durationMs`

So the events exist. What is missing is a transport from a service to the
stream. Section 5 designs it as a run-scoped emitter in `src/lib/`, shaped
exactly like `childLogger` — the one dependency every architectural zone already
permits.

### 0.4 The planner knows the plan before it executes it — so a "plan preview" is not fake

`planAnalysis()` is pure and runs before any I/O. It produces
`requirements[].candidates[]`, each carrying `scope`, `sourceClass` and an
`acquisitionKey`. The set of reads is therefore *known and truthful* before the
first read happens.

**Consequence:** the timeline may legitimately show upcoming steps as *pending*,
because they are a real plan, not a guess. This is the one place where showing
the future is honest. Anything not in the plan is never shown.

### 0.5 No health thresholds exist anywhere — so no metric may be coloured "bad"

The only calibrated thresholds in the codebase are *reconciliation* tolerances
(speed 2 km/h, position 50 m, count 0) — they answer "do two sources disagree",
never "is this value good". There is no declared healthy/warning/critical band
for state of charge, temperature, cell spread or state of health.

**Consequence — a hard design rule:** colour never encodes the *value* of a
metric. A 12% state of charge renders in exactly the same ink as 98%. Colour is
reserved entirely for **provenance and data state** (live / historical /
unavailable / disputed / error). The day thresholds are declared and calibrated,
a severity ramp can be added; inventing one now would put a fabricated judgement
behind a real number, which is the exact failure the whole grounding contract
exists to prevent.

---

## 1. Overall UX vision

> **Tarang is an instrument panel that answers questions — not a chat window that
> happens to know about batteries.**

Four principles, each traceable to something the backend already guarantees:

**1. The answer is a document, not a message.**
A response is a *report*: a headline fact, then analysis, then evidence, then
sources. Prose is the connective tissue between facts, never the container for
them. The model narrates a decision the engine already made.

**2. Provenance is visible at rest, detail is one interaction away.**
Every number carries its source class, its measurement time and its freshness
*on the face of the card*. The full evidence chain — samples, rows, windows,
coverage, rejected candidates, tolerances — is always present but collapsed. The
brief says "never hide evidence"; the design reads that as *never require a
round trip to get it*, not *show everything at once*.

**3. The system narrates its own work while it works.**
The progress timeline is a real-time trace of the backend pipeline, drawn from
emitted events. It is the single strongest signal that this is an operations
tool: a chatbot shows a typing indicator, an analyst shows their working.

**4. Disagreement and absence are first-class answers, not error states.**
"1 of 70 vehicles contributed", "70 vs 320", "the window holds one measurement
and a trend needs two" are the engine's most valuable outputs. They get
designed, deliberate, non-alarming components — not red boxes.

### Anti-goals

- No avatars, no bubbles, no typing dots, no "AI is thinking ✨".
- No animation that does not correspond to a state change.
- No gradient/glassmorphism. Density and legibility over surface treatment.
- No progress bar with a percentage — the pipeline has no denominator.
- No sentiment, no encouragement, no apology copy.

---

## 2. Wireframes

### 2.1 Application shell (desktop ≥ 1280px)

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│ ▪ TARANG   Fleet Analyst        ● Postgres   ● Intellicar   ⟲ Session 4m    ⚙     │  56px
├──────────────┬────────────────────────────────────────────────────────────────────┤
│              │                                                                    │
│  FLEET       │    ┌─ You ──────────────────────────────── 12:04:22 ──┐           │
│  ─────────── │    │ What is the state of charge across the fleet?     │           │
│  70 registered│   └───────────────────────────────────────────────────┘           │
│  320 on portal│                                                                    │
│  ⚠ disputed   │    ┌─ TARANG ─────────────────────────────────────────────────┐   │
│              │    │  ▸ 4 steps · 2.14s · 2 sources                           │   │
│  ─────────── │    ├──────────────────────────────────────────────────────────┤   │
│  LIVE STATUS │    │                                                          │   │
│  Running 128 │    │   FLEET STATE OF CHARGE               ◇ HISTORICAL       │   │
│  Stopped  94 │    │                                                          │   │
│  No comm  98 │    │       62.41 %                                            │   │
│  read 12:04  │    │       mean · 70 of 70 vehicles                           │   │
│              │    │                                                          │   │
│  ─────────── │    │   Coverage  ████████████████████████  70/70              │   │
│  RECENT      │    │   Measured  16 Jun 09:12 → 16 Jun 16:44   span 0.3 d     │   │
│  TK-…179386  │    │                                                          │   │
│  TK-…157748  │    ├──────────────────────────────────────────────────────────┤   │
│              │    │   ANALYSIS                                               │   │
│  ─────────── │    │   Every registered vehicle reported a usable charge      │   │
│  SUGGESTED   │    │   level, and all readings fall inside a single day, so   │   │
│  Fleet SoC   │    │   this is a current picture of the fleet.                │   │
│  Coldest pack│    │                                                          │   │
│  Fleet health│    ├──────────────────────────────────────────────────────────┤   │
│              │    │   ▸ Evidence            ▸ Sources · 2                    │   │
│              │    └──────────────────────────────────────────────────────────┘   │
│              │                                                                    │
│              │    ┌────────────────────────────────────────────────────────┐     │
│              │    │ Ask about a vehicle or the fleet…              [ ↵ ]   │     │
│              │    └────────────────────────────────────────────────────────┘     │
│   240px      │                        max 880px, centred                          │
└──────────────┴────────────────────────────────────────────────────────────────────┘
```

**Header status lamps are real reads, not decoration.**
`● Postgres` reflects the last successful telemetry read this session.
`● Intellicar` reflects `getSessionStatus()` — which already returns `stored`,
`credentialsConfigured`, `blocked`, `reason`, `lastValidatedAt` and a **masked**
account. When `blocked` is true (credentials latched off), the lamp is red and
its tooltip carries `reason` verbatim — this is the single most operationally
important state in the system and it is currently invisible to the user.

**The left rail is context, not conversation history.** Conversation list moves
behind a menu. A fleet manager's persistent context is the fleet.

### 2.2 Evidence drawer (right, opens over content, 420px)

```
                        ┌─ EVIDENCE ─ Fleet state of charge ──────────── ✕ ─┐
                        │                                                   │
                        │  FACT                                             │
                        │  62.41 %                                          │
                        │  ◇ historical · postgres:can_telemetry            │
                        │                                                   │
                        │  HOW IT WAS COMPUTED                              │
                        │  Operation      mean across population            │
                        │  Population     70  (postgres:vehicles)           │
                        │  Contributing   70                                │
                        │  Field          payload.soc                       │
                        │  Precision      2 dp                              │
                        │                                                   │
                        │  MEASUREMENT SPAN                                 │
                        │  ├─ first  16 Jun 2026 09:12                      │
                        │  └─ last   16 Jun 2026 16:44        0.3 days      │
                        │                                                   │
                        │  ONE VEHICLE, ONE SAMPLE                          │
                        │  A CAN signal re-reported unchanged counts once.  │
                        │                                                   │
                        │  SOURCES CONSULTED                                │
                        │  ✔ postgres:can_telemetry     chosen   historical │
                        │                                                   │
                        └───────────────────────────────────────────────────┘
```

### 2.3 Mobile (< 768px)

```
┌─────────────────────────┐
│ ▪ TARANG        ● ● ⚙   │
├─────────────────────────┤
│ ▸ Fleet · 70 · ⚠        │   ← rail collapses to one tappable strip
├─────────────────────────┤
│ You                     │
│ Fleet state of charge?  │
│                         │
│ ┌─────────────────────┐ │
│ │ FLEET SoC  ◇ HIST.  │ │
│ │                     │ │
│ │   62.41 %           │ │
│ │   mean · 70 of 70   │ │
│ │                     │ │
│ │ ████████████ 70/70  │ │
│ │ 16 Jun · span 0.3d  │ │
│ ├─────────────────────┤ │
│ │ Every registered…   │ │
│ ├─────────────────────┤ │
│ │ ▸ Evidence          │ │
│ │ ▸ Sources · 2       │ │
│ └─────────────────────┘ │
├─────────────────────────┤
│ Ask…              [ ↵ ] │
└─────────────────────────┘
```

Mobile rules: metric cards go full-bleed; the evidence drawer becomes a bottom
sheet; the progress timeline collapses to the current stage plus a count
(`◉ Reading Intellicar · step 4 of 5`), expandable; vehicle identifiers
middle-truncate (`TK-51105…179386`) and never wrap.

---

## 3. Screen layouts

### 3.1 The response is a fixed vertical grammar

Every Tarang answer, regardless of question type, uses the same section order.
Predictability is the point: a fleet manager learns one shape.

```
┌──────────────────────────────────────────────┐
│ ① RUN SUMMARY   steps · duration · sources   │  collapsed trace, always
├──────────────────────────────────────────────┤
│ ② FACTS         metric card(s)               │  from tool data. No prose.
├──────────────────────────────────────────────┤
│ ③ ANALYSIS      model narration              │  clearly attributed to the model
├──────────────────────────────────────────────┤
│ ④ EVIDENCE      derivation / aggregation     │  collapsed by default
├──────────────────────────────────────────────┤
│ ⑤ SOURCES       grouped provenance           │  collapsed by default
└──────────────────────────────────────────────┘
```

**② always renders before ③, and ③ can never contain a number that is not in ②.**
This is the "facts must never mix with AI observations" requirement expressed
structurally rather than as prompt guidance. The facts block is rendered from
`envelope.data`; the analysis block is rendered from model tokens. They are
different components fed by different frames, so they *cannot* interleave.

The analysis block carries a persistent, low-key attribution — `AI ANALYSIS ·
narration only, no new numbers` — so the boundary is legible without a warning
banner.

### 3.2 Streaming order

The current stream sends tokens first and sources last. The redesign inverts
what the user perceives, using data that already arrives in the right order:

```
t0   run starts        → progress timeline appears
t1   tool completes    → FACTS card renders (data frame)     ← number visible here
t2   model streams     → ANALYSIS block fills in
t3   done              → EVIDENCE + SOURCES become available
```

The user sees the number *before* the prose, which is both faster in perception
and correct in priority. Tool completion genuinely precedes the model's final
turn, so no reordering or buffering is required.

---

## 4. Improved response templates — the metric card

The atom of the whole design.

### 4.1 Anatomy

```
┌────────────────────────────────────────────────────────────┐
│  STATE OF CHARGE                             ◆ LIVE        │  ← label + state
│  TK-51105-02AZ-179386                                      │  ← subject, mono
│                                                            │
│        62.41 %                                             │  ← value, 40px tabular
│                                                            │
│  Measured  3 Aug 2026 13:53 · 2 min ago                    │  ← measuredAt + age
│  Read      3 Aug 2026 13:55                                │  ← reportedAt
└────────────────────────────────────────────────────────────┘
```

Rules:

- **Value precision comes from the registry** (`precision`) and is never
  re-rounded in the UI. Pack voltage shows 3 dp, cycle count 0 dp.
- **Unit is typeset smaller and lighter than the number**, on the same baseline.
- **`measuredAt` outranks `reportedAt`.** The distinction is load-bearing in this
  system — a CAN signal can lag its row by up to 235 days — so the card always
  shows both, measured first, with a relative age on the measurement.
- **Relative age is computed client-side and labelled as such.** It is a
  rendering of a real timestamp, never a stored fact.
- **A vehicle identifier is monospace and never truncated on desktop.**

### 4.2 State variants

```
◆ LIVE          teal   filled diamond   sourceClass = "live"
◇ HISTORICAL    slate  hollow diamond   sourceClass = "historical"
◷ SUBSTITUTED   slate  + note           rule = P5_substituted_after_unavailable
◶ DEMOTED       slate  + note           rule = P4_stale_live_demoted
⚠ DISPUTED      amber                   disposition = "disputed"
○ UNAVAILABLE   grey   dashed border    available = false
▨ ESTIMATED     RESERVED — never rendered
```

### 4.3 Unavailable card — absence is an answer, not an error

```
┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
   CHARGE CYCLES · TREND                     ○ UNAVAILABLE
   TK-51105-02AZ-179386
                                                            
   A trend needs at least 2 charge-cycle measurements;      
   the window between 6 May and 4 Aug holds 1 for this      
   vehicle. The window holds 3 CAN readings, but they       
   carry only 1 distinct measurement.                       
                                                            
   ▸ Evidence · window, rows, samples                       
   [ Widen to 180 days ]                                    
└ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
```

Dashed border, grey, **no red, no warning icon**. The `reason` string from the
engine is displayed verbatim — it is already written to be shown to a user and
it is already actionable. The suggested action is derived from the failure
class: `too_few_samples` → offer a wider window; `no rows` → offer a wider
window; portal unavailable → offer retry.

### 4.4 Disputed card — never lead with one figure

```
┌────────────────────────────────────────────────────────────┐
│  FLEET SIZE                              ⚠ SOURCES DISAGREE│
├───────────────────────────────┬────────────────────────────┤
│  70 vehicles                  │  320 vehicles              │
│  ◇ Tarang database            │  ◆ Intellicar dashboard    │
│  postgres:vehicles            │  intellicar:fleet_overview │
│  registered by import         │  read 3 Aug 13:55          │
├───────────────────────────────┴────────────────────────────┤
│  These registries count different sets. A count has no     │
│  rate of change, so elapsed time cannot account for the    │
│  difference.                                               │
│  Tolerance 0 · difference 250 vehicles                     │
└────────────────────────────────────────────────────────────┘
```

Two equal columns — **deliberately no hero number, no primary/secondary
hierarchy, no "we recommend"**. This directly renders
`ReconciliationDisposition === "disputed"` and the system prompt's rule that the
model must not adjudicate. The layout makes adjudication impossible rather than
merely discouraged.

### 4.5 Coverage bar — for every `method: "aggregated"` value

```
Coverage  ████████████████████████  70/70    full
Coverage  ███████████████████████░  69/70    one vehicle silent
Coverage  █░░░░░░░░░░░░░░░░░░░░░░░   1/70    ⚠ thin
```

Below 50% coverage the bar takes the amber ink and the card gains a one-line
qualifier: *"This figure rests on 1 of 70 vehicles."* This is not a warning about
data quality — it is the honest scope of the claim, which is exactly why
`fleet_battery_health` was shipped.

### 4.6 Span strip — for every aggregate and every derivation

```
Measured   ├─────────────────────────────────────────────┤
           12 Apr 2026                        10 Jun 2026
                                                 59.4 days
```

When the span exceeds ~7 days on a *fleet* aggregate, the strip takes amber ink
and gains: *"Each vehicle's latest reading — not a snapshot of the fleet right
now."* `fleet_pack_temperature` spans 59.4 days on this deployment, so this is
the normal case, not an edge case.

---

## 5. Loading & progress experience

### 5.1 The honesty contract

Five rules. They are the design; everything else is presentation.

1. **A stage appears only when the backend emits it.** No timers, no
   interpolation, no minimum display duration, no synthetic easing between
   stages.
2. **Durations are measured**, from the emitting site.
3. **Pending stages come only from the planner's real requirements** (§0.4).
   Nothing else is ever shown as upcoming.
4. **A stage that did not happen is never shown.** A run that reuses a session
   shows "Session reused"; a run that logs in shows "Signing in". Never both,
   never a generic placeholder.
5. **Silence is shown as silence.** If no event arrives, the current stage's
   elapsed counter keeps running. The UI never advances on its own.

### 5.2 Stage vocabulary — every stage mapped to real code

| Stage label | Emitted from | Detail shown |
|---|---|---|
| `Understanding the question` | first `on_chat_model_start` | — |
| `Planning analysis` | `planAnalysis()` return | metric key, scope |
| `Resolving vehicle` | `requireVehicle()` | vehicle no |
| `Resolving fleet population` | `fetchFleetPopulation()` | `n vehicles`, truncated flag |
| `Querying PostgreSQL` | `fetchLatest` / `fetchWindow` / `fetchFleetLatest` | table, mode, row count |
| `Connecting to Intellicar` | `withAuthenticatedContext()` entered | — |
| `Reusing existing session` | probe `=== "valid"` | session saved-at |
| `Signing in to Intellicar` | `loginAndRun()` | — |
| `Session expired — re-authenticating` | probe `=== "expired"` | — |
| `Opening <module>` | `page.goto()` | module id |
| `Locating <vehicle> in table` | `capability.resolve()` | target |
| `Waiting for dashboard data` | `waitForReady()` | — |
| `Reading <module>` | `capability.read()` | module id |
| `Reconciling sources` | `reconcile()` | rule selected |
| `Computing <operation>` | `computeSeries` / `aggregateFleet` | samples used |
| `Writing report` | first `on_chat_model_stream` after a tool | — |
| `Completed` | `done` frame | total duration |

Terminal / degraded stages, all of which correspond to real branches:

| Stage | Condition |
|---|---|
| `Portal unavailable — using recorded telemetry` | P5 substitution |
| `Live reading older than recorded — demoted` | P4 |
| `Intellicar not configured` | `isAuthEnvConfigured() === false` |
| `Authentication paused` | rejection latch engaged |
| `Timed out` | `ToolTimeoutError` |
| `Stopped` | client abort |

### 5.3 In-flight timeline

```
┌─ WORKING ─────────────────────────────────────────── 00:07.4 ─┐
│                                                                │
│  ✓  Understanding the question                          0.9s  │
│  ✓  Planning analysis          fleet_state_of_charge    0.00s │
│  ✓  Resolving fleet population 70 vehicles · postgres   0.04s │
│  ✓  Querying PostgreSQL        can_telemetry · 70 rows  0.31s │
│  ◉  Reading Intellicar         fleet_overview          ⟳ 6.1s │
│     └ session reused · saved 13:22                            │
│  ·  Reconciling sources                               pending │
│  ·  Writing report                                    pending │
│                                                                │
│                                              [ Stop ]          │
└────────────────────────────────────────────────────────────────┘
```

`✓` done (measured duration) · `◉` active (live counter) · `·` pending, and
pending rows appear **only** because the planner already produced those
requirements.

The portal leg is the slow one by design — nav 30s + resolve 35s + ready 20s
inside a 90s budget, under a 120s analysis-tool ceiling. When the active stage
passes ~10s, the row gains a quiet secondary line naming the budget:
*"dashboards can take up to 90s on a cold load"*. That is a real constant, not
reassurance copy.

### 5.4 After completion — the trace collapses, it does not vanish

```
▸ 5 steps · 8.30s · 2 sources · session reused
```

One click re-expands the full timeline with durations. The trace is part of the
record of the answer, not a transient spinner. This is what makes the product
feel auditable.

### 5.5 Transport design (preserves all layering rules)

Add to `src/types/chat.ts`:

```
| { type: "stage"; value: RunStage }        // one per real backend event
| { type: "data";  value: ToolEnvelope }    // the structured result, per tool call
```

`RunStage` is a **closed union** of the stage keys in §5.2 plus a small
typed detail object. A closed union is what prevents free-text status strings
drifting into the UI.

Emission mechanism — modelled on `childLogger`, which every eslint import zone
already permits:

- `src/lib/run-progress.ts` — an `AsyncLocalStorage`-scoped emitter. Pure: it
  holds a callback, no transport, no HTTP, no browser, no Prisma.
- `/api/chat` opens the scope for the request and forwards each emitted stage
  into the NDJSON stream. The route already owns the request id and the run's
  log record, so it is the correct owner of the run's progress record too — the
  identical argument the route header already makes about observability.
- Services call `emitStage(...)` at the exact site where they already call
  `log.info(...)`. No service learns about HTTP.
- Outside a request scope (`npm run auth:login`, an Inngest job) the emitter is
  a no-op, so nothing breaks.

This needs one new zone entry in `eslint.config.mjs` permitting
`@/lib/run-progress` in the analytics, portal and session zones, on the same
footing as `@/lib/logger`.

---

## 6. Evidence presentation

Evidence answers one question: **"why should I believe this number?"** It is
rendered entirely from `derivation`, `aggregation` and `reconciliation` — never
from model text.

### 6.1 Windowed derivation

```
▾ EVIDENCE

   COMPUTATION
   mean of 41 state-of-charge measurements
   between 2026-05-06T00:00:00Z and 2026-08-04T00:00:00Z

   EVIDENCE USED
   Rows returned        128
   Distinct measurements 41        ← rows ≠ measurements
   Minimum required      1
   Truncated             no

   ⓘ A CAN signal re-reported unchanged across rows is one
     measurement, not several.

   SPAN
   ├──────────────────────────────────────────────┤
   6 May 2026                            2 Aug 2026
```

The `readingCount` vs `sampleCount` gap is given its own row and its own
explanation, because it is the single most confusing honest number the engine
produces — a user looking at 128 rows in the database deserves to know why the
answer counted 41.

`truncated: true` promotes to an amber line: *"The window held more rows than one
read returns. This covers the most recent slice, not the whole period."*

### 6.2 Fleet aggregation

```
▾ EVIDENCE

   COMPUTATION      mean of state of charge across 70 of 70 vehicles
   POPULATION       70   postgres:vehicles          (truncated: no)
   CONTRIBUTING     70
   COVERAGE         ████████████████████████ 100%
   SPAN             16 Jun 09:12 → 16 Jun 16:44 · 0.3 days
   HELD BY          —                    (minimum/maximum only)
```

For a minimum or maximum, `extremeVehicleNo` renders as a linked vehicle
identifier — it is usually the point of the question.

### 6.3 Reconciliation

```
▾ EVIDENCE · WHY THIS SOURCE

   RULE     P1 · a current question prefers the live reading
   CHOSEN   intellicar:vehicle_summary   live    32.00 km/h
            measured 3 Aug 13:53
   SET ASIDE postgres:gps_telemetry      historical  31.77 km/h
            measured 16 Jun 14:02

   AGREEMENT  difference 0.23 km/h · tolerance 2 km/h
              within tolerance — the sources agree
```

Precedence rules render as plain sentences (the enum is never shown raw):

| Rule | Rendered |
|---|---|
| `P1_current_prefers_live` | A current question prefers the live reading. |
| `P2_historical_authoritative_feed` | Answered by the authoritative recorded feed. |
| `P4_stale_live_demoted` | The live reading was older than the recorded one, so it was set aside. |
| `P5_substituted_after_unavailable` | The preferred source could not answer; the next one did. |

### 6.4 Age explanation

```
explained      ✓  The difference fits the 48 days between the two readings.
unexplained    ⚠  Larger than 48 days of plausible change can account for.
unknown        ◌  One source reported no measurement time, so this cannot be assessed.
not_applicable —  A count has no rate of change; elapsed time cannot explain it.
```

`unknown` is deliberately neutral ink — it is a gap in evidence, never evidence
of disagreement, and the codebase is explicit that it must not escalate.

---

## 7. Source presentation

### 7.1 Grouped by kind, as requested

The brief asks for Database / Portal / Analysis / LLM. Mapping to real fields:

| Group | Derived from | Renders |
|---|---|---|
| **DATABASE** | `origin` starts `postgres:` | table, column, rows, timestamps |
| **PORTAL** | `origin` starts `intellicar:` | module, field, captured-at, session state |
| **ANALYSIS** | `source.method` (`basis`, `operation`, counts) | what was computed and from how much |
| **NARRATION** | the model | model id, prompt version — *"no numbers originate here"* |
| **ENRICHMENT** | geocoder (§8) | provider, queried-at — only if implemented |

**The Analysis Engine is a service, not a tool**, so it never appears in the
`sources` array today. Its work is nonetheless recorded — in `source.method`. The
Analysis group is built from that, so the computation gets billing without
inventing a tool call that never happened.

**Narration is listed but explicitly credited with nothing.** Naming the model
while stating that no number came from it is more honest than omitting it, and
it reinforces the product's core claim.

### 7.2 Layout

```
▾ SOURCES · 3

  ┌ DATABASE ────────────────────────────────────────────────┐
  │ ● postgres:can_telemetry                        CHOSEN   │
  │   payload.soc · 70 rows · one per vehicle                │
  │   measured 16 Jun 09:12 → 16 Jun 16:44                   │
  │   read     3 Aug 2026 13:55:02                           │
  └──────────────────────────────────────────────────────────┘

  ┌ PORTAL ──────────────────────────────────────────────────┐
  │ ◑ intellicar:fleet_overview                  NOT REPORTED│
  │   fleet_overview · total_vehicles                        │
  │   captured 3 Aug 2026 13:55:11 · session reused          │
  │   Consulted and set aside — this source did not supply   │
  │   the reported value.                                    │
  └──────────────────────────────────────────────────────────┘

  ┌ ANALYSIS ────────────────────────────────────────────────┐
  │ ▣ Analysis Engine                                        │
  │   mean of state of charge across 70 of 70 vehicles       │
  │   deterministic · no model involved                      │
  └──────────────────────────────────────────────────────────┘

  ┌ NARRATION ───────────────────────────────────────────────┐
  │ ◯ <model id> · prompt v1.2.0                             │
  │   Wrote the analysis text. No numbers originate here.    │
  └──────────────────────────────────────────────────────────┘
```

Fixes to the current implementation, which is *correct but unreadable*:

- `JSON.stringify(source.params)` is replaced by a labelled key/value list.
- Every timestamp gets an explicit label — `measured` and `read` mean different
  things and the current UI shows a bare date with neither.
- `role: "alternative"` renders as **"Consulted and set aside"**, not italic
  low-opacity text. The whole point of `contributingSources` is that a
  set-aside source is *visible*; rendering it at 40% opacity in italics defeats
  it.
- Origins render as monospace chips, so `postgres:` / `intellicar:` prefixes
  become scannable groupings rather than sentence fragments.

---

## 8. Location presentation

### 8.1 The problem, precisely

`last_known_location` returns `Coordinates {lat, lon}` with `unit: "degrees
(WGS84)"`. The portal's Address column renders coordinates too — measured at
**320 of 320 rows** in the 5D-1 discovery pass. So the user sees numbers because
both sources genuinely contain numbers.

### 8.2 Design rules

1. **The coordinate is the fact. The address is a derived label.**
2. **The address never replaces the coordinate** — it sits above it, and the
   coordinate stays visible, always.
3. **The address gets its own source entry** with its own provider and its own
   query time. It is not attributed to Postgres or Intellicar.
4. **Failure falls back to coordinates alone.** No partial guesses, no "near",
   no city inferred from a bounding box.
5. **The address is never sent to the model.** This is the important one: if a
   geocoded string enters the LLM context, the model can restate it as a
   measured fact, and the engine's determinism is compromised. Enrichment is
   resolved *after* the answer, on the presentation path, and rendered by the
   UI. The engine stays byte-identical.

### 8.3 Rendering

Resolved:
```
┌────────────────────────────────────────────────────────────┐
│  LAST KNOWN LOCATION                          ◆ LIVE       │
│  TK-51105-02AZ-179386                                      │
│                                                            │
│  📍 Sector 62, Noida, Uttar Pradesh 201309                 │
│     25.496010, 81.850116                                   │
│                                                            │
│  Measured  3 Aug 2026 13:53 · 2 min ago                    │
│  Address resolved by <provider> · 3 Aug 13:55  ⓘ           │
└────────────────────────────────────────────────────────────┘
```

Unresolved (failed, unconfigured, rate-limited — all identical to the user):
```
│  📍 25.496010, 81.850116                                   │
│     Address lookup unavailable                             │
```

Pending, while the enrichment call is in flight:
```
│  📍 25.496010, 81.850116                                   │
│     Resolving address…                                     │
```

The coordinate renders **immediately** from the answer; the address arrives when
it arrives. The card never blocks on enrichment, and never shows an empty slot.

### 8.4 Where it lives

New leaf service `src/services/geocoding/`, plus a thin route
`/api/geocode`, called by the client after a location value renders.

- Reverse geocoding only. Never forward.
- Results cached by rounded coordinate — a fleet re-parks in the same depots, so
  the cache hit rate is high and provider cost stays near zero.
- Rate-limited and failure-tolerant: any error is "unavailable", never a partial
  address.
- No dependency in either direction with the Analysis Engine, the Portal Service
  or the Session Manager. It is a leaf.

**Provider choice is a decision for you, not for me** — it has cost, ToS and
data-residency implications (an Indian fleet's coordinates leaving the country).
Options worth weighing: a self-hosted Nominatim (no third party sees fleet
positions), a commercial API (better Indian address coverage), or none at all
(ship §8.3's fallback rendering, which is already an improvement — labelled,
formatted, monospace coordinates rather than a raw pair).

---

## 9. Error states

Errors are classified by **what the user can do**, and the codebase already
carries the classification: `SessionErrorCode`, `PortalErrorCode`, and the
`available: false` reason strings.

### 9.1 Taxonomy

| Class | Ink | Retry offered | Backend condition |
|---|---|---|---|
| Not an error — no data | grey, dashed | widen window | `available: false` |
| Degraded — one source down | slate + amber note | retry live | P5 substitution |
| Transient | amber | retry | `PORTAL_UNREACHABLE`, timeout |
| Blocked — needs an operator | red | none | `CREDENTIALS_REJECTED`, `CHALLENGE_REQUIRED`, `NOT_CONFIGURED` |
| Changed — needs a developer | red | none | `MODULE_CHANGED`, `MALFORMED_DATA` |
| Stopped by user | grey | resend | client abort |

### 9.2 Degraded (the common and most important case)

```
┌────────────────────────────────────────────────────────────┐
│  SPEED                                     ◷ SUBSTITUTED   │
│  TK-51105-02AZ-179386                                      │
│                                                            │
│      31.77 km/h                                            │
│                                                            │
│  Measured  16 Jun 2026 14:02 · 48 days ago                 │
│                                                            │
│  ─────────────────────────────────────────────────────     │
│  ⓘ The live dashboard could not be read, so this is the    │
│    recorded reading. It is 48 days old.                    │
│    Reason: The Intellicar portal could not be reached.     │
│                                            [ Retry live ]  │
└────────────────────────────────────────────────────────────┘
```

**The answer is delivered.** This is P5 working exactly as designed — Postgres is
the system of record, the portal is a corroborator — and the UI must present it
as a complete answer with a disclosed substitution, never as a failure. The age
is prominent because a 48-day-old speed is the thing the user must notice.

### 9.3 Blocked — authentication latched off

```
┌────────────────────────────────────────────────────────────┐
│  ⛔ INTELLICAR ACCESS PAUSED                               │
│                                                            │
│  The configured Intellicar credentials were rejected by    │
│  the portal. Authentication is paused until they are       │
│  updated and the application is restarted.                 │
│                                                            │
│  Live dashboard readings are unavailable. Recorded         │
│  telemetry from PostgreSQL is unaffected.                  │
│                                                            │
│  Account  fl••••@example.com                               │
│  Since    3 Aug 2026 09:12                                 │
│                                                            │
│  No retry — this protects the account from lockout.        │
└────────────────────────────────────────────────────────────┘
```

Also raises the header lamp to red for the whole session. `SessionError`
messages are written to be safe to display, so they are shown **verbatim**
rather than paraphrased. The masked account comes from `SessionStatus.account`;
a full address is never rendered.

Critically: **"no retry" is stated with its reason.** A missing retry button
looks like a bug; a stated one looks like a safeguard, which it is.

### 9.4 Stopped

```
┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
   ○ Stopped after 4.2s · 2 of 4 steps completed
                                  [ Ask again ]
└ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
```

Grey, not red. Cancellation is a normal shutdown path — the route already
declines to treat it as an error, and the UI should agree. Completed stages
remain visible.

### 9.5 Copy rules

- Never "Oops", "Something went wrong", "Please try again later".
- Always name the subsystem: *"The Intellicar dashboard could not be read."*
- Always state what still works: *"Recorded telemetry is unaffected."*
- Never invent a cause the backend did not report.
- Never offer a retry that the backend will refuse.

---

## 10. Empty states

### 10.1 First run — a capability map, not a greeting

The current placeholder is one line of grey text. Replace it with something that
answers *"what can this thing actually tell me?"* — generated from
`QUANTITY_REGISTRY`, so it can never advertise a metric the engine cannot answer.

```
┌──────────────────────────────────────────────────────────────────┐
│  TARANG                                                          │
│  AI data analyst for EV battery fleets.                          │
│  Every number is traceable to the source that produced it.       │
│                                                                  │
│  ┌ THIS FLEET ────────────────────────────────────────────────┐  │
│  │  70 vehicles registered      320 on the Intellicar portal ⚠ │  │
│  │  Recorded telemetry  battery · CAN · GPS                   │  │
│  │  Live dashboard      fleet overview · vehicle · battery    │  │
│  └────────────────────────────────────────────────────────────┘  │
│                                                                  │
│  ASK ABOUT THE FLEET                                             │
│  ▸ How many vehicles are running right now?          ◆ live      │
│  ▸ What is the fleet's average state of charge?      ◇ recorded  │
│  ▸ Which vehicle has the lowest charge?              ◇ recorded  │
│                                                                  │
│  ASK ABOUT ONE VEHICLE                                           │
│  ▸ State of health for TK-51105-02AZ-179386          ◇ recorded  │
│  ▸ Where is TK-51105-02AZ-179386?                    ◆ live      │
│  ▸ Pack temperature trend over 90 days               ◇ recorded  │
└──────────────────────────────────────────────────────────────────┘
```

Each suggestion is pre-tagged with the source class it will use, which teaches
the live/historical distinction before the user's first question rather than
after.

### 10.2 Portal not configured (development / partial deployments)

```
┌──────────────────────────────────────────────────────────────────┐
│  ◇ RECORDED TELEMETRY ONLY                                       │
│  Intellicar access is not configured on this deployment.         │
│  Historical questions work normally; live readings and fleet     │
│  status counts are unavailable.                                  │
└──────────────────────────────────────────────────────────────────┘
```

A persistent, calm strip under the header — not a modal, not a toast. This is a
deployment fact, not an incident, and `isAuthEnvConfigured()` answers it without
launching a browser.

### 10.3 Empty fleet

```
   No vehicles are registered.
   Tarang answers questions about telemetry that has been imported
   into its database. See docs/DATA-IMPORT.md.
```

The engine already resolves an empty fleet to a population of zero rather than
throwing; the UI matches that posture.

### 10.4 Metric with no data

Covered by §4.3. Never a spinner that ends in nothing, never a blank card.

---

## 11. Response templates

Nine templates. All render from `envelope.data` + streamed tokens; none requires
a new backend capability beyond the `data` frame in §5.5.

### 11.1 Single metric

```
▸ 3 steps · 1.9s · 1 source

┌──────────────────────────────────────────────┐
│  STATE OF HEALTH                ◇ HISTORICAL │
│  TK-51105-02AZ-179386                        │
│      100.00 %                                │
│  Measured 16 Jun 2026 14:02 · 48 days ago    │
└──────────────────────────────────────────────┘

ANALYSIS
The pack reports full state of health. This value reads exactly
100.00 across every sampled row in this dataset, so it reflects
what the BMS reports rather than a measured decline.

▸ Evidence          ▸ Sources · 1
```

### 11.2 Vehicle health report (multi-metric)

Facts first, as a grid; one narration for all of them.

```
▸ 6 steps · 12.4s · 3 sources

VEHICLE HEALTH · TK-51105-02AZ-179386
Recorded 16 Jun 2026 · live dashboard 3 Aug 2026

┌──────────────────┬──────────────────┬──────────────────┐
│ STATE OF HEALTH  │ STATE OF CHARGE  │ PACK VOLTAGE     │
│ ◇ historical     │ ◇ historical     │ ◇ historical     │
│   100.00 %       │    62.41 %       │    52.914 V      │
│   16 Jun 14:02   │    16 Jun 14:02  │    16 Jun 14:02  │
├──────────────────┼──────────────────┼──────────────────┤
│ PACK TEMPERATURE │ CELL SPREAD      │ CHARGE CYCLES    │
│ ◇ historical     │ ◇ historical     │ ○ unavailable    │
│    41.05 °C      │     0.012 V      │  no usable       │
│    16 Jun 14:02  │    16 Jun 14:02  │  measurement     │
└──────────────────┴──────────────────┴──────────────────┘

┌──────────────────────────────────────────────────────────┐
│ LOCATION                                    ◆ LIVE       │
│ 📍 Sector 62, Noida, Uttar Pradesh                       │
│    25.496010, 81.850116                                  │
│ Measured 3 Aug 13:53 · 2 min ago                         │
└──────────────────────────────────────────────────────────┘

ANALYSIS
…

▸ Evidence · per metric        ▸ Sources · 3
```

All six recorded metrics share one measurement time here because the engine
deduplicates the CAN read — one row, one instant. That is worth surfacing as the
report subtitle rather than repeating on every tile.

### 11.3 Fleet summary

```
▸ 5 steps · 9.1s · 2 sources

FLEET SUMMARY
Live status read 3 Aug 13:55 · recorded telemetry 16 Jun

LIVE NOW  ◆ from the Intellicar dashboard
┌──────────┬──────────┬──────────┬──────────────────┐
│ RUNNING  │ STOPPED  │ NO COMM. │ ALL VEHICLES     │
│   128    │    94    │    98    │   320  ⚠ disputed│
└──────────┴──────────┴──────────┴──────────────────┘
Counted by the dashboard. Tarang computed nothing.

RECORDED  ◇ from Tarang's telemetry database · 70 vehicles
┌──────────────────────────┬──────────────────────────┐
│ MEAN STATE OF CHARGE     │ MEAN PACK TEMPERATURE    │
│      62.41 %             │       38.72 °C           │
│ ████████████████ 70/70   │ ███████████████░ 69/70   │
│ span 0.3 days            │ span 59.4 days ⚠         │
└──────────────────────────┴──────────────────────────┘
```

**The two source classes are separated into labelled bands rather than mixed
into one grid.** This is the structural expression of the brief's live /
historical requirement: a fleet manager must never have to read a badge to know
whether they are looking at now or at June.

### 11.4 Vehicle comparison

```
                      TK-…179386      TK-…157748
STATE OF CHARGE         62.41 %         58.02 %      ◇
PACK TEMPERATURE        41.05 °C        39.11 °C     ◇
STATE OF HEALTH        100.00 %        — no data     ○
MEASURED             16 Jun 14:02    12 Apr 09:33
```

Rules: one row per metric, one column per vehicle; the measurement time is its
own row because vehicles are rarely measured at the same instant; missing values
render as `— no data`, never blank and never zero; **no automatic winner
highlighting** (that would be a judgement with no declared threshold — §0.5).

### 11.5 Alert response

There is no alerts capability today (`alerts_rules` is a named module with no
registered extractor). Template reserved, shape fixed so it slots in without
redesign:

```
┌────────────────────────────────────────────────────────┐
│ ⚠ <alert name>                          ◆ LIVE         │
│   <n> vehicles                                         │
│   Raised by the Intellicar dashboard · read 13:55      │
│   ─────────────────────────────────────────────────    │
│   TK-…179386   TK-…157748   TK-…148201   +4 more       │
└────────────────────────────────────────────────────────┘
```

Not built. Listed so the design system covers it.

### 11.6 Error response

See §9. One rule for this template specifically: **a partial answer is never
replaced by an error.** If three metrics resolved and one failed, the response is
the three cards plus one unavailable card — not an error page.

### 11.7 Partial data response

```
▸ 4 steps · 7.7s · 2 sources · 1 source unavailable

┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
   ◑ PARTIAL — 2 of 3 metrics available
└ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘

[ available card ]  [ available card ]  [ unavailable card ]

ANALYSIS
…names the gap explicitly…
```

The banner is informational grey, not amber. Partial is the *normal* shape of an
answer on this dataset — GPS reaches 1 of 70 vehicles, battery telemetry covers
1 — and styling it as a warning would make the normal case feel broken.

### 11.8 Portal unavailable

Two distinct cases, deliberately styled differently:

**(a) The question could still be answered** → §9.2 substituted card. Answer
delivered, substitution disclosed, `[ Retry live ]` offered.

**(b) Only the portal could have answered** — `fleet_running`, `fleet_stopped`,
`fleet_non_communicating` are live-only by design; the database records no
counterpart and none can be invented:

```
┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐
   VEHICLES RUNNING                    ○ UNAVAILABLE
                                                       
   Only the Intellicar dashboard reports vehicle       
   status, and it could not be read.                   
   Reason: The Intellicar portal could not be reached. 
                                                       
   There is no recorded equivalent to fall back to.    
                                        [ Retry ]      
└ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
```

Stating *"there is no recorded equivalent"* is the honest and useful line — it
tells the user not to wait for a fallback that is never coming.

### 11.9 Database unavailable

Postgres is the system of record. A failed telemetry query is a genuine fault
and does throw — unlike a portal failure, which is data.

```
┌────────────────────────────────────────────────────────┐
│ ⛔ TELEMETRY DATABASE UNAVAILABLE                      │
│                                                        │
│ Recorded telemetry could not be read, so no historical │
│ question can be answered right now.                    │
│                                                        │
│ Live dashboard readings are unaffected — fleet status  │
│ counts still work.                                     │
│                          [ Retry ]                     │
└────────────────────────────────────────────────────────┘
```

Red, because unlike every case above this one genuinely blocks the product's
core function. The header lamp goes red simultaneously. Note the asymmetry with
§11.8 is intentional and mirrors the backend's own asymmetry.

---

## 12. Design system

### 12.1 Colour — provenance only, never value

```
--live          teal    #0E9488   live source class
--historical    slate   #475569   recorded source class
--disputed      amber   #B45309   sources disagree · thin coverage · wide span
--unavailable   grey    #94A3B8   no data (dashed borders)
--error         red     #B91C1C   blocked or faulted
--estimated     violet  #7C3AED   RESERVED — no component may use it
```

Neutrals: `#0F172A` ink, `#475569` secondary, `#94A3B8` tertiary, `#E2E8F0`
rules, `#F8FAFC` surface. Dark mode inverts through the same tokens.

Every state is carried by **icon + label + colour**, never colour alone —
required for accessibility and for the ~8% of male fleet managers with colour
vision deficiency.

### 12.2 Typography

| Role | Face | Size / weight | Notes |
|---|---|---|---|
| Metric value | sans, **tabular-nums** | 40 / 600 | tabular is mandatory — values align in grids and update in place |
| Metric unit | sans | 18 / 500, tertiary | same baseline as value |
| Metric label | sans | 11 / 600, letterspaced caps | |
| Identifiers, origins | **mono** | 12 / 400 | `TK-…`, `postgres:can_telemetry`, `payload.soc` |
| Timestamps | mono, tabular | 12 / 400 | |
| Analysis prose | sans | 15 / 400, 1.6 | max 68ch |
| Section headers | sans | 11 / 600 caps | |
| Evidence body | sans | 13 / 400 | |

Two families total: one sans (Inter/Geist), one mono (Geist Mono/JetBrains Mono).
**Note:** `globals.css` currently sets `font-family: Arial, Helvetica, sans-serif`
on body while declaring `--font-geist-sans` in the theme — the declared fonts are
not actually applied. Worth fixing in Phase 1; it costs one line.

### 12.3 Spacing

4px base. Card padding 20px desktop / 16px mobile. Metric grid gap 12px. Section
gap inside a response 20px. Gap between responses 40px — the largest gap in the
layout, because the boundary between two answers is the most important
separation on the screen.

### 12.4 Icons

Geometric, single-weight, 16px, no filled illustrative icons.

```
◆ live          ◇ historical      ○ unavailable     ⚠ disputed
◷ substituted   ◶ demoted         ▣ computed        ◯ narration
✓ stage done    ◉ stage active    · stage pending   ⛔ blocked
📍 location     ⓘ note            ▸/▾ disclosure
```

The one deliberate emoji is 📍, because the brief asks for it and location is
the one metric users scan for spatially.

### 12.5 Motion

- Stage rows: 120ms fade-in on append. Nothing else animates in the timeline.
- Metric cards: no entrance animation — they appear when data arrives, which is
  itself the signal.
- Disclosure: 150ms height transition.
- **No pulsing, no shimmer, no skeleton loaders.** A skeleton implies a known
  shape arriving on a known schedule; neither is true here, and the progress
  timeline is a strictly better answer to the same problem.

---

## 13. Fleet visualization opportunities

Ranked by honesty-per-effort. Every one uses data that already exists.

**1. Battery Analytics distributions — highest value, lowest risk.**
`battery_analytics` already extracts three distributions × seven bands, live and
validated. This is a histogram that already exists in the data and currently
renders as nothing.

```
STATE OF CHARGE · 320 vehicles · live 13:55
  >75%   ████████████████████████████  142
  50-75% ██████████████████            89
  25-50% ████████████                  61
  1-25%  ████                          19
  0%     █                             6
  <0%                                  0
  No SoC ▓                             3
```

Note `total` is nullable by design and the Battery-Temp row summed to 317 while
the fleet was 320 — so the chart must render its own total and never imply it
equals the fleet size.

**2. Fleet status band** — the twelve `FLEET_OVERVIEW_METRICS` as a single
proportional bar. Already extracted, currently unused beyond four counts.

**3. Coverage and span strips** — §4.5/§4.6. Micro-visualizations, very high
value per pixel, trivial to build.

**4. Sparkline on a derived metric** — a windowed derivation already collects the
full sample series (`collectSamples`). Rendering the series behind a mean or
trend would be genuinely informative, but the series is not currently returned
by the tool. Requires a wire addition. Phase 3.

**5. Map** — real, but defer. Needs a tile provider (external network, CSP,
cost), and GPS reaches **1 of 70 vehicles** on this dataset, so a fleet map
would render one pin and read as a broken map. Revisit when GPS coverage
improves. A single-vehicle location card with a static map thumbnail is the
cheaper honest version.

**Explicitly not recommended:** gauges and dials (the portal's own dial set is
ICE-oriented and misleading here), donut charts for two-value comparisons, and
any time-series axis on fleet aggregates — the CAN feed is a last-known-value
snapshot, so points would be 59 days apart while looking like a trend line.

---

## 14. Implementation roadmap

### Phase 1 — Quick wins (highest impact, lowest effort)

Ship-order matters: each step is independently valuable and independently
revertible.

| # | Change | Files | Why first |
|---|---|---|---|
| 1 | Emit `{type:"data"}` frames — stop discarding `envelope.data` | `route.ts`, `types/chat.ts` | Unlocks everything. ~10 lines. |
| 2 | Metric card component + facts/analysis split | `page.tsx` → `components/` | The single biggest perceived change |
| 3 | Live / historical / unavailable / disputed badges | components | Requirement 7, entirely from existing fields |
| 4 | Rewrite Sources block: grouped, labelled timestamps, no raw JSON | `page.tsx` | Requirement 4, pure rendering |
| 5 | Design tokens + typography fix (Geist actually applied, tabular numerals) | `globals.css` | Prerequisite for everything visual |
| 6 | Coarse progress timeline from `on_tool_start`/`on_tool_end` | `route.ts`, components | Real feedback with zero service changes |
| 7 | Empty state → capability map | components | First impression; removes "generic chatbot" read |
| 8 | Error taxonomy + verbatim safe messages | components | Removes the biggest trust gap |

**Outcome:** looks and behaves like an analyst tool. No service file is modified.

### Phase 2 — Medium improvements

| # | Change | Files |
|---|---|---|
| 9 | `run-progress.ts` emitter + `{type:"stage"}` frame + eslint zone entry | `lib/`, `route.ts`, `eslint.config.mjs` |
| 10 | Real stage emission at existing log sites | `session-manager.ts`, `portal.service.ts`, `acquisition.ts`, `analysis-engine.ts` |
| 11 | Plan-preview pending stages | `planner.ts` → emitter |
| 12 | Evidence drawer: derivation, aggregation, reconciliation | components |
| 13 | Coverage bars + span strips | components |
| 14 | Disputed split card | components |
| 15 | App shell: header status lamps, fleet rail | layout, `/api/status` over `getSessionStatus()` |
| 16 | Reverse geocoding service + `/api/geocode` + location card | `services/geocoding/` |
| 17 | Mobile responsive pass | components |

**Outcome:** the full brief. Requires the one new transport and one new leaf
service; no architectural boundary moves.

### Phase 3 — Advanced

| # | Change |
|---|---|
| 18 | Battery Analytics distribution charts |
| 19 | Fleet status proportional band |
| 20 | Sparklines (needs the sample series on the wire) |
| 21 | Vehicle comparison view |
| 22 | Export a report to PDF (this is what the unbuilt Report Tool + Inngest are for) |
| 23 | Saved questions / scheduled fleet digests (Inngest) |
| 24 | Map, if GPS coverage improves |

### Sequencing note

Phase 1 items 1 and 2 should be one PR — the frame is useless without a renderer,
and the renderer is impossible without the frame. Everything after item 2 can
land independently.

---

## 15. Open decisions for you

1. **Geocoding provider** — self-hosted Nominatim (fleet positions never leave
   your infrastructure) vs a commercial API (better Indian address coverage) vs
   none for now (§8.3's labelled-coordinate fallback is already an improvement).
2. **Left rail in Phase 1 or Phase 2?** It needs a `/api/status` route. Phase 2
   in this plan; movable to Phase 1 if the fleet-context panel matters more than
   the progress timeline to you.
3. **Should stage detail include row counts?** *"can_telemetry · 70 rows"* is
   informative to an analyst and slightly leaky about schema. My recommendation:
   yes — this audience is operational, and it reinforces traceability.
4. **Dark mode: ship in Phase 1 or defer?** Tokens support it from day one;
   verifying both themes costs real time. Recommendation: define tokens in
   Phase 1, verify in Phase 2.
```
