> Generated from the SAD v3.1 Word master for AI-assisted development. Figures live in the Word document.

# Software Architecture Document — Tarang, Level 1 AI Data Analyst Agent (SAD v3.1)

Tarang — Level 1 AI Data Analyst Agent

*Single agent · Unified Next.js runtime · LangChain JS · Playwright · Prisma + PostgreSQL*

| **Field** | **Detail**                                                                                                   |
|-----------|--------------------------------------------------------------------------------------------------------------|
| Document  | Consolidated SAD — Node.js / TypeScript refactor of the v2.0 draft; v3.1 adds grounding & source attribution |
| Level     | 1 — single-agent foundation                                                                                  |
| Version   | 3.1 · unified Next.js runtime                                                                                |
| Status    | Baseline architecture for build                                                                              |

## 1. Overview & Objectives

Tarang is a Level-1 AI Data Analyst Agent that answers fleet and battery questions in natural language by combining live Intellicar dashboard data, historical PostgreSQL telemetry, TypeScript analytics and AI reasoning. Version 3.0 replaces the earlier dual-codebase design (Next.js frontend + FastAPI/Python backend) with a single Next.js application: one repository, one Node.js runtime, one deployable unit.

The intent of the original architecture is preserved — one agent, a small set of tools, one conversational endpoint — but the implementation is redesigned to be native to the Next.js + TypeScript ecosystem rather than a line-for-line translation of the Python design. Cross-service HTTP calls become typed in-process function calls; Python analytics becomes SQL-first aggregation finished in TypeScript; and all security-sensitive concerns (credentials, browser sessions) are pulled out of the agent into dedicated services.

### Objectives

- Answer battery and fleet questions conversationally through a streaming chat interface.

- Fetch live dashboard data from Intellicar via Playwright, behind a dedicated Portal Service.

- Read historical telemetry from PostgreSQL through Prisma.

- Run battery analytics with SQL-first aggregation finished in TypeScript.

- Generate concise business reports as Markdown and downloadable PDF.

- Keep credentials and browser sessions fully isolated from the AI agent.

- Remain structurally ready for Level-2 / Level-3 expansion (LangGraph workflows, multi-tenant use).

## 2. Technology Stack

| **Layer**           | **Technology**                           | **Purpose**                                                                         |
|---------------------|------------------------------------------|-------------------------------------------------------------------------------------|
| Frontend            | Next.js 16 + React 19                    | Chat interface (App Router, Server Components)                                      |
| Backend             | Next.js Route Handlers                   | Streaming /api/chat endpoint and API surface                                        |
| Internal operations | Server Actions                           | Credential submission, settings, report actions                                     |
| Language            | TypeScript                               | End-to-end static typing across UI, agent and services                              |
| AI framework        | LangChain JS                             | Agent orchestration and tool execution                                              |
| LLM                 | OpenAI / OpenRouter                      | Reasoning                                                                           |
| Browser automation  | Playwright (Node.js)                     | Intellicar login and scraping                                                       |
| ORM                 | Prisma                                   | Type-safe data access and migrations                                                |
| Database            | PostgreSQL                               | Telemetry, app data, memory, audit                                                  |
| Validation          | Zod                                      | Tool schemas, API input, environment validation                                     |
| Authentication      | Custom sealed-cookie sessions (Phase 4D) | Application user authentication. NOT Clerk and NOT Auth.js — see §10 |
| Background jobs     | Inngest                                  | Scheduled sync, session refresh, retries                                            |
| Reports             | Markdown + PDF (rendered via Playwright) | Business output                                                                     |
| Observability       | LangSmith                                | Agent tracing and monitoring                                                        |
| Logging             | Pino                                     | Structured application logs with secret redaction                                   |
| Configuration       | Environment variables (Zod-validated)    | Twelve-factor configuration, fail-fast at boot                                      |
| Deployment          | Docker                                   | Single long-lived container; PM2-compatible on a VPS                                |

## 3. High-Level Architecture

<img src="media/d61e5b4d946bfab8f9d292066c79b9cc0fbb1376.png" style="width:5.83333in;height:3.22917in" />

*Figure 1 — Request path through the single Next.js application to external systems*

A user's question enters the React 19 chat interface, passes the application session check in the Route Handler (Phase 4D — there is no middleware), and posts to the /api/chat Route Handler. The handler runs on the Node.js runtime and streams tokens back to the browser while the LangChain JS agent works. The agent reasons over the request, selects tools from the Tool Registry, and delegates every real-world side effect — scraping, database reads, report generation — to the service layer. Playwright reaches Intellicar, Prisma reaches PostgreSQL, every agent run is traced to LangSmith, and Inngest executes scheduled and background work through the same codebase. Everything ships as one long-lived Node.js process.

### From two codebases to one

The v2.0 design ran two services: a Next.js frontend calling a FastAPI backend that hosted the agent and Python tooling. v3.0 removes the FastAPI service, the Python analytics stack, the frontend/backend HTTP contract, CORS handling and the second deployment pipeline. What replaces them: Route Handlers as the API surface, TypeScript modules as the analytics layer, and direct in-process function calls between agent, tools and services — all sharing one type system, one build and one deploy.

## 4. Component Architecture — Service Layer

The application is organised as a modular service layer inside the Next.js codebase. Route Handlers stay thin: they authenticate, validate input with Zod, invoke a service or the agent, and stream the result. Every capability lives in a dedicated service module under src/services with a clearly typed interface. Tools are thin adapters over services, and the agent never reaches infrastructure directly.

<img src="media/128dc38b4cbf14101d33ec0d5e580b34f27ce19d.png" style="width:5.83333in;height:3.42708in" />

*Figure 2 — Services, tools and infrastructure inside the single application*

| **Service**        | **Responsibility**                                                                                                                                                   |
|--------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| AI Agent Service   | Owns the LangChain JS agent: prompt assembly, reasoning loop, tool selection, response and report composition. Knows nothing about credentials, cookies or browsers. |
| Tool Registry      | Central catalogue of Zod-typed tools; binds tools to the agent at construction. The single place where capabilities are added or removed.                            |
| Portal Service     | The only component that talks to Intellicar: module navigation, data extraction and JSON normalisation across the seven dashboard modules.                           |
| Session Manager    | Browser session lifecycle: storageState persistence, validation, silent refresh, expiry detection and invalidation.                                                  |
| Credential Manager | Encrypted storage and retrieval of Intellicar credentials; update and revocation; never returns secrets to the agent.                                                |
| Playwright Manager | Singleton Chromium lifecycle, browser context creation and crash recovery. Pure infrastructure — contains no business or AI logic.                                   |
| Database Service   | Two access layers in one folder: `telemetry.*` is the Prisma layer over the application database, `iot.*` is the read-only `pg` layer over the IoT database. Both expose typed reads only; neither accepts SQL from a caller. |
| Analysis Engine    | Deterministic reasoning over grounded sources: plans what to acquire, deduplicates the reads, reconciles live against historical by declared precedence, computes metrics, and assembles findings that carry their own provenance. Calls no LLM. |
| Memory Manager     | Short-term conversation state and long-term user preferences; enforces the memory storage exclusions in Section 7.                                                   |
| Report Service     | Markdown assembly, PDF rendering, report persistence and download links.                                                                                             |

## 5. AI Agent Architecture

<img src="media/cf08afc490b4f2d26c9bfa3f2a01090df73f5748.png" style="width:5.83333in;height:2.61458in" />

*Figure 3 — Agent internal flow: reason, select a tool, execute, observe, respond*

Tarang remains a single agent. It is built with LangChain JS using the modern tool-calling executor (the prebuilt ReAct-style agent from @langchain/langgraph/prebuilt), which gives a bounded reason–act–observe loop today and a clean upgrade path to full LangGraph multi-agent workflows at Level 2.

The agent is responsible for:

- Prompt management — versioned system and tool prompts kept in src/agent/prompts.ts. Currently SYSTEM_PROMPT_VERSION 1.3.0. As of Phase 4A the prompt is assembled by a FUNCTION of the run's state and config rather than being a fixed string, which is how a singleton agent carries per-run context; with no context it produces the fixed string unchanged.

- Conversation memory — short-term only. The transcript is held by the browser and resent per request, bounded by Phase 4B; structured references arrive as the Phase 4A run context. There is no Memory Manager and no long-term memory (Section 7).

- Tool selection — LLM tool-calling against the Zod schemas published by the Tool Registry.

- Reasoning — a bounded loop with a maximum iteration count and per-tool timeouts.

- Response generation — token streaming back through the /api/chat handler.

- Grounded answers — numeric claims carry the sources they came from (see Grounding & Source Attribution, Section 6).

- Report generation — delegated to the Report Tool when the user asks for a document.

Equally important is what the agent must not do. The agent never authenticates, never holds credentials, cookies, tokens or Playwright handles, and never manages browser sessions. It requests outcomes ('Fleet Overview data for fleet X') and receives normalised JSON. Authentication, session recovery and credential handling happen entirely inside the Session Manager and Credential Manager, invisible to the agent — the agent only ever learns whether a session is active. This keeps the security blast radius of any prompt-injection or model error small by construction.

## 6. Tool Architecture & Tool Registry

Four LangChain tools are registered at Level 1. Each tool is a thin, Zod-validated adapter over a service — tools contain no scraping, SQL or rendering logic of their own.

| **Tool**      | **Backed by**         | **Input (Zod-validated)**                 | **Output**                                                      |
|---------------|-----------------------|-------------------------------------------|-----------------------------------------------------------------|
| Portal Tool   | Portal Service        | Dashboard module + battery / fleet target | Live normalised JSON from Intellicar                            |
| Database Tool | IoT Database Service (src/services/database/iot.*) | A named query INTENT plus typed parameters | Rows of live and historical IoT telemetry                   |
| Analysis Tool | Analysis Engine (src/services/analytics/) | Subject + quantities (+ window, from 5C)  | Findings over the DEVELOPMENT SAMPLE, each carrying the source that answered it |
| Report Tool   | Report Service        | Results + report template                 | Markdown / PDF report with download link                        |

**A TOOL DECLARES ITS OWN STANDING, in its description AND its envelope `origin`.** The Analysis Tool reads a manually imported development sample — 70 vehicles of about 335, with readings weeks old — and its origin said only `postgres:tarang_dev`. That is accurate and was read by a model as an authoritative database: a fleet-wide "right now" question was answered from seven-week-old sample rows and presented as a current finding. Both surfaces now say what the dataset is, because the description is what the model reads when CHOOSING a tool and the origin is what travels with every answer it produces. Precedence in the system prompt is necessary and was not sufficient.

The Tool Registry (src/agent/tool-registry.ts) is the single catalogue of capabilities. Each entry pairs a Zod input schema, a description the LLM reasons over, and the service call it wraps. Adding a capability at Level 2 means adding a service, a thin tool adapter and one registry entry — the agent core does not change.

**The Database Tool takes an INTENT, never SQL.** The earlier sketch of this row read "typed query intent or read-only SQL", leaving open a free-text SQL parameter guarded by a validator. That option is now closed: the tool's Zod schema exposes `intent: z.enum([...])` and typed parameters, every statement is a module-level constant with `$n` placeholders in `iot.queries.ts`, and no string supplied by the model ever becomes SQL. A validator can only reject the write attempts it anticipates; an enum makes a write attempt *unrepresentable*, which is the stronger guarantee and costs only the flexibility of asking an un-anticipated question without a code change. The read-only database role and its session settings (§12) remain in force underneath as defence in depth, not as the primary control.

**Three registries answer "which vehicles exist", and they genuinely differ.** The Intellicar portal lists the whole account, the IoT database holds what the IoT platform has registered, and the local Prisma telemetry tables hold only what was manually imported for development. §19 already records the first gap as a genuinely DISPUTED `fleet_size` rather than a fault to reconcile away; the IoT database is a third member of that disagreement, not a resolution of it. Source precedence is stated in §12 and enforced in the system prompt, never inferred by the model.

Note: the v2.0 Script Runner tool (LLM-generated Python executed in a container) is intentionally deferred to Level 2 as a sandboxed capability. Its analytical duties are covered by the SQL-first Database Tool and the TypeScript Analysis Tool; the rationale is recorded in Section 19.

### Grounding & Source Attribution

Tarang is a data analyst: every number it reports must be traceable to where it came from. Attribution is implemented as a cross-cutting convention, not a separate service:

- Result envelope — the Tool Registry wrapper returns every tool result as { data, source: { tool, origin, params, timestamp } }. Attribution therefore exists for every capability automatically; individual tools cannot forget it. From Milestone 5D-4 the source may also carry contributingSources — every source that took part, each with its class, its role (chosen or alternative), its availability and its measurement time — present only when more than one was consulted.

- Method metadata — the Analysis Tool includes how each metric was computed in its envelope (for example the analysis window: 'last 90 charging cycles'). From Milestone 5C this is the Derivation record: the operation, the absolute window, how many rows were read, how many distinct measurements they yielded, and the span those measurements covered. It is attached whether the computation succeeded or not — see the insufficiency contract in §19.

- Prompt contract — the system prompt requires the agent to attach sources to numeric claims, and the response composer renders a Sources block beneath the answer.

- Grounded, never asserted — the Sources block is derived from the envelopes of tool calls that actually executed in the run, never from the model's own claims. An LLM asked to cite without grounding will fabricate citations; the envelope makes citation mechanical.

- Two audiences — LangSmith traces remain the full internal lineage for developers; the user-facing Sources block is the distilled view of the same run.

Example response shape: 'Battery Health: 87% — Sources: Intellicar Battery Analytics (live), Historical Telemetry (PostgreSQL), calculated over the last 90 charging cycles.'

This enforces the project's computed-only rule: metrics originate from tool output; the LLM narrates and formats, but never invents a number.

## 7. Memory Architecture

The Memory Manager separates two kinds of memory with different lifetimes, storage and rules.

### Implementation status — read this before the tables below

The two tables in this section are the DESIGN TARGET, not a description of the running system. As of Phase 4B:

| Capability | Status | Where it actually lives |
|---|---|---|
| Short-term conversation turns | **Built** (Phase 4A / 4B) | Held by the BROWSER and resent per request; never persisted. See §15 "Short-term run context". |
| Short-term structured references | **Built** (Phase 4A) | `TurnContext`, derived from tool envelopes; injected into the system prompt for one run. |
| Reasoning state / intermediate tool outputs | **Built** | In-process LangGraph state, discarded when the run completes. There is no checkpointer. |
| **Long-term memory (per user)** | **BUILT** (Phase 4E) | `MemoryEntry` table + `src/services/memory/`. Four preference kinds, owner-scoped. |

**Long-term memory is implemented as of Phase 4E**, and its prerequisite — a verified application identity — arrived in Phase 4D (§10). Everything below describes what the code does today; anything still planned is marked as such.

The `Conversation` and `Message` models of §12 remain UNBUILT: conversation transcripts are still held by the browser (Phase 4A/4B) and are not persisted. `UserMemory` was superseded by `MemoryEntry`, described below.

### Long-term memory — BUILT (Phase 4E)

Durable, user-owned context that survives across conversations. **It never replaces telemetry**: PostgreSQL's telemetry tables and the Intellicar portal remain the authoritative sources for every operational number, and memory stores no measurement of any kind.

#### The model

`MemoryEntry` — `prisma/schema.prisma`, migration `20260809162449_add_memory_entries`.

| Field | Notes |
|---|---|
| `id` | `BigInt`, autoincrement. Never exposed by the API — it does not survive `JSON.stringify`, and `(ownerId, kind)` already identifies a row. |
| `ownerId` | **Mandatory, no database default.** The application user id, derived server-side from the sealed session cookie (§10). Not a foreign key: there is no `User` table, users live in `APP_USERS`. |
| `kind` | Postgres enum `memory_kind`. |
| `value` | `jsonb`, shape decided by `kind`, Zod-validated on write AND on read. |
| `source` | Postgres enum `memory_source`. |
| `createdAt` / `updatedAt` | `timestamptz(3)`, matching every other model. |

**Approved kinds, and only these four:** `preferred_vehicle`, `preferred_metric`, `default_window_days`, `report_style`.

**Approved sources, and only these two:** `user_stated` (the user set it outright) and `user_confirmed` (the system proposed, the user accepted). There is deliberately **no `inferred`** — the agent never writes memory, so a model-generated preference has no member to be filed under.

#### Uniqueness — `@@unique([ownerId, kind])`

**One value per preference kind per user.** This single constraint IS the update-and-conflict policy: setting a preference REPLACES that user's existing value for that kind. There is no history, no second row and no read-time reconciliation, because two conflicting values are unrepresentable rather than resolved.

That is deliberately the opposite of the Analysis Engine's problem. The engine must reconcile because it has two independent sources with their own measurement times; memory has exactly one source — the user — so there is nothing to adjudicate. A user who contradicts themselves has changed their mind, and the later statement wins.

#### What memory may and may not hold

**MAY:** a preferred vehicle, a preferred metric, a default window, a reporting style — stable, user-authored, non-authoritative.

**MAY NOT, and cannot:** state of health, state of charge, temperature, location, speed, fleet counts, telemetry readings, tool results, portal data, transient reasoning, model-generated claims or session state. There is no field any of them could occupy, the value schemas are `.strict()` so an unknown key is REFUSED rather than silently dropped, and there is **no free-text kind in v1** — which is what makes an injected sentence unstorable.

A stale preference is a default the next message overrides. A stale measurement would be a wrong number presented as a fact, and would additionally be a source class the reconciliation engine knows nothing about: no provenance, no honest `measuredAt`, nothing for precedence to select between.

#### The Memory Service — `src/services/memory/memory.service.ts`

The only module that touches `prisma.memoryEntry`, which makes the isolation boundary reviewable with one grep. It owns list/read, create/update (upsert) and delete, and nothing else: it resolves no telemetry, calls no tool, reaches no Portal Service, Analysis Engine, Planner or Session Manager, and performs no authentication of its own.

**Ownership is enforced by the compiler, not by discipline.** Every function takes `OwnerId` as its first parameter, and `OwnerId` is a branded type whose only constructor lives in `principal.ts`, reached only after a sealed cookie has been opened and found current. So there is no zero-argument "list all memory", a client-supplied string cannot be passed as an owner (`OwnerId` is assignable to `string` but never from one), and no principal means no call — anonymous persistence is unreachable rather than merely forbidden. Every query additionally carries `ownerId` in its `WHERE`, so the database enforces what the types already do.

#### Creation policy — THE AGENT NEVER WRITES MEMORY

Writes happen only through `PUT`/`DELETE /api/memory` on an authenticated request: a deliberate user action, outside the agent loop. There is no memory tool, no registry entry and no prompt text describing the route, so **prompt injection has no write primitive at all** — the same argument §19 makes for why authentication is an internal service and never a tool. Level 1's four-tool ceiling is untouched.

There is no automatic extraction, and no parsing of model output into memory.

**Not built, deliberately:** a memory management UI. `/api/memory` is the approved route surface; a preferences screen is a later decision.

#### Retrieval

Read in `/api/chat`, **beside the agent and before the prompt is built** — never inside the Planner, which is pure and deterministic and whose reproducibility a preference would destroy.

```
Authenticated request -> principal -> getPreferences(ownerId)
                                          |
                                          v  configurable (the Phase 4A seam)
                                    prompt function -> Agent
                                          |
        Planner -> Tools -> Analysis Engine -> Portal -> Report
        (none of these know memory exists)
```

It reuses the **existing** `configurable` + prompt-function seam, so no new mechanism was added and **`ChatStreamFrame` is unchanged** — memory is not a frame, and is never sent as a `tool_result`, because it is user preference and not evidence. `MEMORY_ZONE` forbids the Planner, Analysis Engine, Tool Registry, tools, Portal Service, Session Manager and telemetry services from importing it.

The prompt block states, before any value: these are settings the user chose, they are not measurements, they fill a gap rather than override the question, and a preferred vehicle is a SUBJECT and never a value — the tool is still called for every number.

**No feature flag, and none is needed.** With no rows the block renders nothing and the prompt is byte-identical to Phase 4A's; with no authenticated principal the query is not even issued. An empty table IS the off switch, which is why §19's objection to a meaningless flag applied here too.

#### Write-time validation — shape at the service, EXISTENCE at the route (Phase 4F)

Phase 4E bounded the **characters** of a stored value, not its **membership**. `preferred_vehicle` accepted any identifier-shaped string and `preferred_metric` any lower-case token, so `{"vehicleNo":"SOH-92.5-percent"}` was storable: it could never become a *cited* number, because the Sources block is built mechanically from tool envelopes, but it persisted across sessions and rendered as a labelled line in a system prompt. That is a longer life than the Phase 4A run context the bound was borrowed from, so the trade no longer holds.

Validation is therefore **split across two layers**, and the split is structural rather than stylistic:

| Layer | Validates | Why there |
|---|---|---|
| `memory.service.ts` | **Shape.** `.strict()` Zod per kind, on write and again on read. | It is the only module that may touch `prisma.memoryEntry`, so shape has exactly one home. |
| `/api/memory` `PUT` | **Existence.** `preferred_vehicle` must name a row in `vehicles`; `preferred_metric` must be a member of `QUANTITIES`. | `MEMORY_ZONE` forbids the memory service from importing the Database Service, the Portal Service or the Analysis Engine — *"a preference that could read them would be the first step toward one that caches them"*. The zone's own comment already prescribes this: **if a stored value needs checking against the fleet, the ROUTE does it and hands memory an already-validated value.** |

A nonexistent reference is a **400** that names what was rejected, distinct from the 400 a malformed value gets. `default_window_days` and `report_style` name nothing outside themselves, so the service's schema is the whole of their validation. The check costs one `findUnique` on the vehicle dimension and an array membership test — no telemetry row is read and no portal call is made.

#### What the prompt block may and may not do (Phase 4F)

Phase 4E's block listed what was stored and stopped there, which left the model an **open world**. Asked about "my preferred battery" — not a preference this system has, can store, or will ever store — it had no rule to meet, so it answered from the nearest listed neighbour and reported the user's preferred *vehicle*. Retrieval was correct; the prompt simply never said the four kinds are all there are.

`SYSTEM_PROMPT_VERSION` **1.5.0** closes it. The block now states that the vocabulary is CLOSED and exhaustive, that one preference may never be read as another, that a preference which is not listed must be reported as **not stored** rather than substituted, that no further preference may be inferred from the ones shown, and that every measurement still comes from the tool that produces it.

`report_style` is also no longer rendered as a bare `Preferred answer style: detailed` line underneath a Style section that says "keep it brief" — two live instructions with no rule for choosing. It is rendered as an explicit amendment to that section instead, and the three cases are deterministic:

| Stored | Effect |
|---|---|
| *(absent)* | The base Style section stands unchanged. No style block is emitted at all. |
| `brief` | The block **confirms** the Style section: lead with the number, stop there. |
| `detailed` | The block **replaces** "keep it brief" and says so. Every other rule in the Style section still holds. |

The 1.2.0 guarantee is untouched: a run with neither context nor stored preferences still produces `SYSTEM_PROMPT` byte for byte, and `scripts/memory-check.ts` asserts it.

#### Known limitation — `ownerId` is a mutable username

`ownerId` is the `APP_USERS` record name, not a stable immutable id. Rows survive a user being removed from `APP_USERS`, so **re-minting a user with a name that was used before makes the new user inherit the old one's stored preferences.** Nothing in the type system prevents it: the brand guarantees the id came from a verified session, not that the id refers to the same person over time.

Until application users move into a table, **an `APP_USERS` name must be treated as permanent and never reused.** The upgrade path is the one §10 already records — a `User` table replaces the parser in `users.ts`, `ownerId` becomes a surrogate key, and no query changes.

#### Lifecycle

| Stage | Behaviour |
|---|---|
| Created | Only by an authenticated user action via `/api/memory`. |
| Retrieved | One owner-scoped query per authenticated chat request. |
| Updated | Upsert on `(ownerId, kind)` — replaces, never accumulates. |
| Stale | Validated on read; a value that no longer parses degrades to "no preference" rather than reaching a prompt. |
| Deleted | Hard delete, idempotent: one kind via `?kind=`, or all of a user's entries. No soft delete — a soft-deleted preference that still matched a query would be a leak. |

#### Security summary

| Requirement | How |
|---|---|
| Authenticated principal required | `getAppPrincipal()`; 401 otherwise, on every verb |
| `ownerId` server-derived only | Branded `OwnerId`, minted only in `principal.ts` from the sealed cookie |
| Client cannot supply `ownerId` | No such request field; a `string` is not assignable to `OwnerId` |
| Reads/updates/deletes scoped | `ownerId` in every `WHERE`, and in the upsert's compound key |
| No anonymous persistence | No principal means no `OwnerId` means no call |
| No model-generated writes | No memory tool exists; the agent has no path to the route |
| No telemetry stored | Four preference kinds, `.strict()` values, no free text |
| No cross-user retrieval | No function returns memory without an `OwnerId` argument |

#### Migration and deployment

Local migration `20260809162449_add_memory_entries` is purely additive: two `CREATE TYPE`, one `CREATE TABLE`, one `CREATE UNIQUE INDEX`. No existing table is altered and no data is moved, so applying it cannot change any existing answer.

**Production migration on Railway remains a MANUAL step and was not performed.** `docker-entrypoint.sh` deliberately runs no migrations ("no migrations, no schema push"), so deploying this code without running the migration leaves the table absent — memory reads would then fail while every telemetry answer continues to work.

### Short-term memory (per conversation)

| **Holds**                         | **Storage**                                              |
|-----------------------------------|----------------------------------------------------------|
| Current conversation turns        | Conversation / Message tables, loaded per thread         |
| Reasoning state of the active run | In-process during the agent loop                         |
| Intermediate tool outputs         | In-process; large payloads truncated before re-prompting |
| Temporary execution context       | In-process; discarded when the run completes             |

### Long-term memory (per user) — the ORIGINAL sketch, superseded

The table below was the v3.1 design target. Phase 4E built a deliberately smaller thing; what shipped is described in "Long-term memory — BUILT (Phase 4E)" above, and the differences are decisions rather than omissions.

| **Holds**                                     | **Original storage**                              | **As built** |
|-----------------------------------------------|---------------------------------------------------|---|
| Preferred fleet and preferred dashboard       | UserMemory table, injected into the system prompt | **Dropped.** This deployment is single-fleet — Fleet Overview reports `fleet: null` — so a preferred fleet is a field with nothing to put in it. `preferred_vehicle` covers the real need. |
| User preferences (units, report format, tone) | UserMemory / UserSettings tables                  | **Built**, as `report_style`, `preferred_metric` and `default_window_days`. |
| Previous reports (index and summaries)        | Report table metadata                             | **Not built** — the Report Service does not exist yet. |
| Frequently asked questions                    | UserMemory table                                  | **Dropped.** That is usage analytics, not memory. |
| Business context supplied by the user         | UserMemory table                                  | **Deferred.** Free text is the prompt-injection carrier and the poisoning vector; v1 has no free-text kind. |

### What memory must never store

The memory system is architecturally forbidden from persisting any of the following. These belong exclusively to the Credential Manager and Session Manager, and the Memory Manager's write path rejects them:

- Passwords

- Session cookies

- Browser tokens

- Authentication tokens

- Encrypted credentials

- Playwright storageState

## 8. Session Architecture

The Session Manager owns the full lifecycle of authenticated Intellicar browser sessions, independent of the AI agent. The agent only ever asks 'is a session active?' — it never learns how sessions are created, stored or refreshed.

Responsibilities:

- Reuse browser sessions whenever possible; logging in is the exception, not the rule.

- Manage Playwright storageState: persist it encrypted to the session store on disk, with only a metadata row (status, lastValidatedAt, storage reference) in PostgreSQL.

- Maintain authenticated browser contexts through the Playwright Manager.

- Detect expired sessions with a lightweight authenticated probe before scraping.

- Refresh sessions silently using stored credentials via the Credential Manager.

- Invalidate sessions on credential revocation or repeated authentication failure.

- Support multiple users in future: every session is keyed by user, ready for multi-tenant use.

Lifecycle: create → encrypt and persist storageState → restore on demand → validate → silently refresh on expiry → invalidate on revocation. Raw cookies and storageState never enter the database or the agent's context.

## 9. Credential Architecture

The Credential Manager is the only component that can read Intellicar credentials, and it does so only at the moment a login is required.

- Credentials are encrypted with AES-256-GCM before storage; the key comes from the CREDENTIAL_ENCRYPTION_KEY environment variable, with a key-version field to allow rotation.

- PostgreSQL stores only ciphertext, IV, auth tag and key version in the CredentialVault table — never plaintext.

- Decryption happens exclusively inside the Credential Manager, in memory, during a login attempt; plaintext is never returned to the agent, written to logs (Pino redaction paths enforce this) or persisted anywhere.

- Credential updates overwrite the vault entry and trigger a session refresh; revocation wipes the vault entry and invalidates all sessions for that user.

- Every store, retrieval, update and revocation writes an AuditLog entry.

- If stored credentials fail during silent re-authentication, the system requests updated credentials from the user through a Server Action — the agent simply reports that the portal is temporarily unavailable pending credentials.

## 10. Authentication & Secure Login Flow

### Two authentication domains

Tarang deliberately separates two unrelated concerns. The **application identity layer** (`src/services/identity/`) answers 'who may use Tarang', and its user id keys all per-user data. The Credential Manager and Session Manager answer 'how Tarang reaches Intellicar'. The two never mix, and `IDENTITY_ZONE` in `eslint.config.mjs` enforces it in both directions.

**As built (Phase 4D) — this is NOT Clerk and NOT Auth.js.** Both were considered and rejected: neither was wanted as a dependency, and Auth.js additionally needs a user store, which would have dragged a Prisma model into a phase that deliberately has none. What exists instead is a small self-hosted session mechanism with **zero new dependencies**:

| Piece | What it is |
|---|---|
| Session token | An **AES-256-GCM sealed** cookie — `tarang_session`, `HttpOnly`, `SameSite=Lax`, `Path=/`, `Secure` in production. Sealed rather than merely signed, so it is opaque to the client as well as tamper-evident. |
| Crypto | The existing `src/services/credentials/crypto.ts`, unchanged. Its purpose-bound AAD (`tarang.app-session.v1`) means an application session can never be opened as a stored Intellicar session, or the reverse — the second caller that module's header was written for. |
| Users | `APP_USERS`, as `name:scrypt.N.r.p.salt.hash` records separated by `;`. Verified with scrypt and `timingSafeEqual`; an unknown user still pays for one derivation against a decoy hash, so the endpoint is not a timing oracle. A plaintext secret is rejected at parse time, never compared. Mint a record with `npm run app:user -- <name>`; a hash cannot be written by hand. |
| **Hash separator — `.`, not `$`** | The fields inside a hash are **dot-delimited**, which is deliberate and is the one place this format departs from every other scrypt/PHC string. `.env` files interpolate, and `@next/env` expanded each `$…` segment to nothing — a correct record on disk reached the application gutted, and every sign-in failed as "invalid username or password". `HASH_SEPARATOR` in `users.ts` carries the same warning. Do not "correct" it. |
| Expiry | `exp` is sealed INSIDE the payload and checked server-side. The cookie's own `Max-Age` is advisory. |
| Modules | `app-session.ts` (seal/read/clear), `principal.ts` (the only place an identity enters the system), `users.ts` (credential verification). |
| Config | `APP_AUTH_ENABLED` (default **false**), `APP_SESSION_KEY` (deliberately separate from `CREDENTIAL_ENCRYPTION_KEY` — different blast radius), `APP_USERS`, `APP_SESSION_TTL_HOURS` (default 12). A fourth lazy env schema, so an unconfigured deployment still boots and answers telemetry questions. |
| Enforcement | At the ROUTE, before the body is read. **There is no `middleware.ts`.** |

Users in the environment is the same trade §19 already recorded for Intellicar credentials, with the same upgrade path: a `User` table replaces the parser in `users.ts` and no caller changes. The known limits are explicit — no self-service signup, no password reset, no MFA, adding a user needs a redeploy, and sessions are **stateless**, so signing out clears the browser's cookie but cannot revoke a copy of it before `exp`. A user id is also not permanent; see "Known limitation — `ownerId` is a mutable username" in §7.

### Sign-in and sign-out in the UI (Phase 4F)

Phase 4D shipped `/sign-in` and `POST /api/auth/logout` with **nothing linking to either**: a user had to type the path by hand, and once signed in had no way to sign out. Phase 4F adds the affordance and **no new authentication mechanism** — no endpoint, no client-side session state, no second source of identity.

The obstacle is that the cookie is `HttpOnly`, so a Client Component cannot tell whether anyone is signed in. The fix is a split, not a new API:

| Piece | Role |
|---|---|
| `src/app/page.tsx` | Now a **Server Component**. Calls the existing `isAppAuthEnabled()` and `getAppPrincipal()`, and passes down two props: `authEnabled` and `userId`. Nothing else crosses — not the cookie, not the sealed payload, not `issuedAt`/`expiresAt`. |
| `src/components/chat/ChatSurface.tsx` | The former `page.tsx` body, **streaming logic unchanged**. Renders a `Sign in` link to `/sign-in` when signed out, and a `Logout` button when signed in. |

- **`export const dynamic = "force-dynamic"` on the page is load-bearing.** `getAppPrincipal()` returns null *without touching cookies* when authentication is disabled, so Next has nothing to infer dynamism from on that path and would prerender the page at build time — baking the **builder's** `APP_AUTH_ENABLED` into the image, which on Railway is not the value the container runs with.
- **Logout is a `POST` to the existing route, then a full navigation** to `/sign-in`. A router push would keep the old cookie on the next request; the sign-in page already documents the same reasoning for the opposite direction.
- **`APP_AUTH_ENABLED=false` renders neither control.** That deployment is supported and is the default; `/api/auth/login` answers 503 in it, so a Sign in button would lead to a dead end and a Logout button would describe a session that does not exist.
- **A 401 from `/api/chat` is reported as an ended session**, not as a failed answer. The route's semantics are unchanged — it still answers 401 with `{"error":"Authentication required."}` before reading the body — but the browser now shows *"Your session has ended. Please sign in to continue."* with a Sign in button, instead of rendering that JSON into the transcript. A session can expire inside a long-lived tab, so the client flag that records this also flips the header control from Logout to Sign in; it only ever moves toward "signed out" and never overrides the server the other way.

Still **not built, deliberately**: a memory management UI. `/api/memory` remains the approved surface for reading and writing preferences.

### First login

1.  The user is asked for their Intellicar email and password through a dedicated form (Server Action).

2.  The Credential Manager encrypts and stores the credentials (AES-256-GCM → CredentialVault).

3.  The Session Manager authenticates against Intellicar using Playwright.

4.  The authenticated browser session (storageState) is saved encrypted to the session store.

5.  The user's original request continues immediately — scraping proceeds in the same run.

### Subsequent requests

1.  The Session Manager restores the existing storageState into a browser context.

2.  The login screen is skipped entirely.

3.  Scraping starts immediately.

### Expired session

1.  The validation probe detects that the session has expired.

2.  The Session Manager silently re-authenticates using securely stored credentials.

3.  On success, the refreshed storageState is saved and the request continues without user involvement.

4.  If the credentials are invalid, the user is asked to update them; nothing is retried until they do.

The user is never asked to log in again unless it is absolutely necessary — silent recovery is always attempted first.

<img src="media/1b9d068705b1cca7a7648546af41fc8806e743f3.png" style="width:5.83333in;height:3.69792in" />

*Figure 4 — Session validation, silent refresh and credential recovery flow*

## 11. Playwright Flow

Playwright is treated as an infrastructure service, not AI logic. The Playwright Manager launches one singleton headless Chromium per process (held on globalThis so development hot-reload does not leak browsers) and hands out isolated browser contexts on request.

A scraping run proceeds as follows:

1.  Launch (or reuse) the singleton Chromium instance.

2.  Create a browser context restored from the user's storageState.

3.  Validate the session with a lightweight authenticated probe; escalate to the Session Manager if it fails.

4.  Navigate to the target Intellicar module.

5.  Wait for data readiness (selectors / network idle), then extract tables, cards and charts.

6.  Normalise the raw extraction into Zod-typed JSON.

7.  Return the normalised payload to the Portal Service and release the context.

The Portal Service covers the same seven Intellicar modules as v2.0 — Fleet Overview, Battery Analytics, Fleet Activity, Health & Analytics, Alerts & Rules, Device Management and Database Health — plus Vehicle Summary, an eighth module added at Milestone 4C (see §19). Each is implemented as its own extractor module under src/services/portal/extractors. On failure the run is retried once, a screenshot is captured for diagnostics, and a crashed browser is relaunched automatically.

Modules divide into two kinds. An ACCOUNT-WIDE module renders a whole fleet and is reached by navigating to its path — Fleet Overview and Battery Analytics are both of this kind. A TARGETED module reports one entity named by the request, and the portal exposes no route for it, so reaching it is an extra in-page phase between navigation and extraction. The capability lifecycle is therefore: navigate → resolve (targeted only) → wait for readiness → assert identity (targeted only) → extract → normalise → validate. Steps 4-7 of the scraping run above are unchanged for account-wide modules.

Three of the nine are implemented: Fleet Overview (Milestone 4B), Vehicle Summary (4C) and Battery Analytics (4D). Battery Analytics reports the fleet's live battery picture as three distributions — state of charge, battery temperature and cell temperature — each a count of vehicles per band. It is account-wide because the portal has no per-vehicle battery view at all (see §19).

## 12. Database Architecture

Tarang reads **two** PostgreSQL databases. They are separate systems with separate clients, separate schemas, separate credentials and separate lifecycles, and neither knows the other exists.

| | **Application database** | **IoT database** |
|---|---|---|
| Variable | `DATABASE_URL` | `IOT_AGENT_DATABASE_URL` |
| Client | Prisma + `@prisma/adapter-pg`, `src/lib/prisma.ts` | `pg.Pool`, `src/services/database/iot.pool.ts` |
| Owned by | Tarang — migrations ship with the repo | The IoT platform — Tarang is a guest, never a migrator |
| Access | read/write (`memory_entries`) | **read-only, enforced by the server** |
| Holds | `memory_entries` + the manually imported development telemetry | the live fleet: `vehicle_state`, `vehicles`, `alerts`, `distance_rollup`, `telemetry_battery/gps/can` |
| Reached by | Analysis Engine, Memory Service | Database Tool only |

Everything in this section below this table describes the **application database** unless it says otherwise. The IoT database has no Prisma model, no migration and no generated client, and it must never acquire one: its schema belongs to another team, and a Prisma model would turn their DDL into our build failure. See docs/IOT-DATABASE.md for its schema, its measured quirks and its operational limits.

PostgreSQL, accessed exclusively through Prisma, is the system of record for everything except secrets-in-plaintext. A singleton PrismaClient (globalThis pattern) serves the whole process; schema changes ship as Prisma migrations.

| **Model**              | **Purpose**                                                                               |
|------------------------|-------------------------------------------------------------------------------------------|
| User / UserSettings    | *Planned.* Application users live in APP_USERS today (§10); preferences are the MemoryEntry table below |
| CredentialVault        | Encrypted Intellicar credentials: ciphertext, IV, auth tag, key version — never plaintext |
| PortalSession          | Session metadata only: status, last validated time, storage reference — never raw cookies |
| Vehicle                | Vehicle / device dimension; the shared join key for all three telemetry tables            |
| BatteryTelemetry       | Historical battery telemetry, typed to the Battery dataset                                |
| GpsTelemetry           | Historical position and movement telemetry, typed to the GPS dataset                      |
| CanTelemetry           | Historical CAN bus telemetry, typed to the CAN dataset                                    |
| Conversation / Message | Chat threads; the persistence layer for short-term memory                                 |
| MemoryEntry            | **BUILT (Phase 4E).** Long-term memory: four preference kinds, one row per (ownerId, kind). Supersedes the UserMemory sketch |
| Report                 | Generated report metadata and file references                                             |
| AuditLog               | Security-relevant events: credential and session operations, logins, report access        |

**Built so far:** `Vehicle`, `BatteryTelemetry`, `GpsTelemetry`, `CanTelemetry` and — as of Phase 4E — `MemoryEntry` with its two enums. Every other model in the table above — `User`, `UserSettings`, `CredentialVault`, `PortalSession`, `Conversation`, `Message`, `UserMemory`, `Report`, `AuditLog` — is the target design and does not exist in `prisma/schema.prisma`. In particular there is no `Conversation`/`Message` persistence: short-term conversation state is held by the browser (§7, §15). Long-term memory **is** implemented — as `MemoryEntry`, which superseded the `UserMemory` sketch; see "Long-term memory — BUILT (Phase 4E)" in §7.

Telemetry is modelled as three dataset-shaped tables rather than one generic reading table. The Battery, GPS and CAN datasets carry genuinely different columns, and a single wide table would be mostly nulls and would hide unit and precision differences behind a shared column name. They join through the Vehicle dimension on (vehicleId, recordedAt). Telemetry is loaded manually from files (see docs/DATA-IMPORT.md); there is no seed script.

Prisma 7 note: the client has no built-in database driver — a WASM query compiler builds query plans and a driver adapter (@prisma/adapter-pg) executes them. The adapter is constructed from the same DATABASE_URL and is confined to src/lib/prisma.ts; nothing else in the system observes it.

Two rules are absolute: raw credentials and browser cookies never enter the database, and the agent's SQL path is SELECT-only, executed under a read-only database role. As of the IoT integration the second rule is discharged more strongly than "escape hatch" implied — there is no escape hatch, because there is no free-text SQL parameter anywhere in the system (§6).

### The IoT database — read-only, and enforced where it cannot be argued with

The role `iot_agent_ro` carries no INSERT, UPDATE or DELETE grant on any table and no CREATE on the schema. It additionally carries role-level session settings, so the guarantee does not rest on the grant matrix alone:

```
default_transaction_read_only = on      -- every session starts read-only
statement_timeout             = 20s
lock_timeout                  = 3s
idle_in_transaction_session_timeout = 30s
search_path                   = public
rolconnlimit                  = 5
```

A write is therefore rejected twice — once because the transaction is read-only, once because the grant is absent — and neither rejection depends on application code being correct. `iot.pool.ts` adds a third layer by issuing `BEGIN TRANSACTION READ ONLY` explicitly, and caps the pool at 3 of the 5 permitted connections so an operator's `psql` never contends with the running app.

**`statement_timeout` is 20 s and is never raised.** It is a property of the role we are a guest under, not a tuning knob. Queries are shaped to fit it.

### A dead pooled connection is a connectivity failure, and is retried once

The application is a long-lived process holding a `globalThis` pool, so a socket that dies between checkouts — a tunnel blip, or the server closing an idle backend — is not an edge case but the normal appearance of a stale pool. `pg` reports it as a bare `Error` reading "Connection terminated unexpectedly" carrying **no `code`**, so it fell through every branch of the error classifier and surfaced as a generic `QUERY_FAILED`: a message telling the model the read failed for unknown reasons, when the remedy was simply a new connection.

`isConnectionFailure()` now recognises both socket codes and those codeless messages, and `iotQuery` retries on an **allow-list of `TUNNEL_UNREACHABLE` only** — the same shape as `isRetryable` in `portal.service.ts`, and for the same reason: everything else returns identically on a second attempt. Two attempts. A socket-level failure **destroys** the client instead of releasing it, which is the whole mechanism — releasing a dead client back would hand attempt two the same dead socket. `ROLLBACK` is skipped on a dead connection, because it raises a second error that masks the first.

Retrying is safe by construction here in a way it would not be elsewhere: every statement in the catalogue is a `SELECT` inside a read-only transaction, so re-running one cannot double an effect.

### Source precedence — which database answers what

1. **Intellicar portal** — preferred for live/current questions *when the portal can answer them*.
2. **IoT database** — the authoritative source for IoT telemetry, and the source for every current question the portal cannot serve.
3. **Local Prisma telemetry** — an incomplete development dataset. It is **never** a source of truth for current telemetry, and an answer drawn from it says so.

This ordering is stated in the system prompt rather than inferred. A model left to choose between three registries that disagree will choose the one that answers fastest.

### The 20-second boundary, measured

A fleet-wide `DISTINCT ON (vehicleno)` over `telemetry_battery` does not reliably fail and does not reliably succeed — it STRADDLES the ceiling, and which side it lands on depends on the buffer cache and the window:

| Window | Cache | Result |
|---|---|---|
| 1 day | cold | cancelled at 20,295 ms |
| 1 day | warm | ~4.0 s |
| 7 days | warm | ~9.3 s |
| 30 days | warm | cancelled at 20,479 ms |

The cause is structural rather than incidental: pg_partman's daily partitions stop at `p20260704`, so all current rows land in `telemetry_*_default` and partition pruning buys nothing, while the only index is `(vehicleno, time DESC)` — which a time-only predicate cannot use. The query full-scans the default partition, so cost grows with both the window and the table.

An intermittently-succeeding query is worse than a reliably failing one, and this project has already paid for that lesson: the Vehicle Summary resolver's 15 s readiness budget met a portal rendering in 12 s, 14 s and ~67 s, so the same vehicle read correctly in one request and "did not exist" in the next. The rule adopted there applies unchanged — **size from the worst observation, never the median**.

**Therefore no fleet-scope read may SCAN a raw telemetry table by time.** Fleet questions are answered from `vehicle_state` (334 rows, pre-materialised, ~150–360 ms) or `distance_rollup`. Every raw-telemetry intent binds a `vehicleNo` and a bounded window, which together drive `idx_*_vehicle_time` and stay comfortably inside the ceiling.

### The one fleet-scope raw-telemetry read, and why its shape makes it safe

One question cannot be answered any other way: **how many assets communicated over a past window.** `fleet_communication_window` answers it, and it is the only fleet-scope intent that reads a `telemetry_*` table.

It is permitted because of its SHAPE, not as an exception. Instead of filtering by `time` across the fleet — the pattern measured at 20,273 ms and cancelled — it performs a **loose index scan**: it walks the 335-row registry and issues one index-only `EXISTS` seek per vehicle, so `vehicleno` is always the bound leading column.

```
Nested Loop Semi Join
  -> Index Only Scan using vehicles_pkey on vehicles v
  -> Append
       Subplans Removed: 19
       -> Index Only Scan using telemetry_gps_default_vehicleno_time_idx
            Index Cond: (vehicleno = v.vehicleno) AND (time >= $1) AND (time <= $2)
```

VERIFIED 2026-08-13. Both sides are index-only, there is **no `Seq Scan`**, and `Subplans Removed: 19` shows partition pruning working — pruning contributes nothing to a time-only predicate but everything once `vehicleno` is bound. The query plan is the safety property here, so it is asserted by `EXPLAIN` in the test suite rather than assumed.

Answers are stable; timings are not:

| Window | Communicating | Registered | Warm (3 runs) | Observed worst |
|---|---|---|---|---|
| 30 days | 313 | 335 | 91 / 106 / 100 ms | 406 ms |
| 60 days | 319 | 335 | 210 / 108 / 102 ms | **cancelled at 20 s** |
| 90 days | 320 | 335 | 408 / 111 / 113 ms | 2,515 ms |

**The 90-day cap is a cost ceiling, not a safety guarantee, and it buys no headroom.** A 60-day window was cancelled by `statement_timeout` during a full suite run while 90 days completed in 2.5 s in the same run, and all three finish in roughly 100 ms warm. Cost is dominated by **cold-cache random I/O across 335 index seeks**, not by window length, so no cap of any size removes the risk — the second time on this integration that a measurement taken once proved to be the wrong end of a wide distribution.

What protects the caller is classification rather than avoidance: a timeout surfaces as `TIMEOUT` with a message telling the model to report it and not to retry in-turn, and the retry allow-list deliberately excludes it, because retrying a query that exhausted the budget spends it twice. The intent degrades to an honest "could not be read", never to a wrong number. The cap is still enforced twice — refused at the schema (naming the number, so the model learns it) and clamped in the reader (so the bound holds even if the schema is bypassed) — because bounding requested work is worth doing even when it cannot bound elapsed time.

`windowDays` is **required** for this intent. "How many assets communicated" is not a question until it says over what period, and a default would hand back an answer over a window nobody chose.

### What "communicated" means, and what it does not

The count is measured from **`telemetry_gps` alone**. An asset reporting battery or CAN data without GPS is not counted, so the figure is a **floor**, not a total for every form of communication. Every result carries `feed` and a `feedNote` saying exactly that, because "313 assets communicated" and "313 assets reported GPS telemetry" are different claims and only the second is what was measured.

Two sources are **deliberately not used**, and the test suite re-measures both reasons rather than trusting this note:

- **`vehicle_state.last_seen` cannot answer it.** Its `last_seen` and `updated_at` are written within 1.3 ms of each other and the table's whole history begins 2026-08-11 — a two-day horizon. It returns 334 for 30, 60 and 90 days alike. That is not a fleet that has been fully active for three months; it is a table that cannot see that far back.
- **`distance_rollup` cannot answer it.** It holds zero rows with `distance_km = 0` or null across all 25,163, so it records only days a vehicle *moved*. An asset reporting from a depot all month is absent. It agrees with GPS on this fleet (313/320), but that is a property of these vehicles, and "moved" is not "communicated".

### Current state and a historical window are different questions

`fleet_current_state` and `vehicles_offline` describe the fleet **now**; `fleet_communication_window` describes a period that has **passed**. Conflating them is not a hypothetical: asked "how many assets communicated within the last month?", the agent called `fleet_current_state` and returned 200 current rows, which establishes nothing about the preceding thirty days. That was not model error — the catalogue held no intent for the question and the schema rejected `windowDays` on every fleet intent except `distance_fleet`, so it was unaskable. The fix is an intent that exists and a description that names the wrong answers explicitly.

## 13. Workflow Orchestration — Inngest

Inngest provides durable background execution inside the same repository, served through the /api/inngest Route Handler. It moves slow or scheduled work off the interactive chat path and adds retries, backoff and concurrency control (browser work is capped at one concurrent job per user to protect the Intellicar session).

Inngest is Tarang's workflow orchestration layer — there is deliberately no separate orchestrator between the Route Handler and the agent. The dispatch rule is fixed: /api/chat runs exactly one thing, the interactive agent loop. Anything that is not 'answer this question now' — report builds, scheduled synchronisation, and future needs such as email delivery, webhook handling, long-running workflows or human approval steps — is emitted as an Inngest event and handled by a durable function (approvals map directly to Inngest's waitForEvent).

| **Function**    | **Trigger**   | **Purpose**                                                                                                   |
|-----------------|---------------|---------------------------------------------------------------------------------------------------------------|
| dashboards/sync | Cron schedule | Scheduled scrape of key Intellicar modules into PostgreSQL, so common questions answer from fresh cached data |
| session/refresh | Cron schedule | Validate sessions and silently refresh them before they expire mid-request                                    |
| report/generate | Event         | Heavy report builds executed off the request path, with a link delivered when ready                           |

## 14. Report Service

The Report Service turns analysis results into business documents: executive summaries, fleet reports and battery reports. Results are composed into Markdown templates, rendered to HTML, and printed to PDF using Playwright's built-in page.pdf() — deliberately reusing the Chromium instance the system already manages instead of adding a second headless-browser dependency.

- Outputs: Markdown, PDF, executive summaries, fleet reports, battery reports, downloadable documents.

- Generated files live in the reports/ volume; each report gets a Report row with metadata.

- Downloads are served through /api/reports/\[id\] (session-protected, per §10); chat replies link the artifact.

## 15. End-to-End Workflow

| **\#** | **Step**                                                                                                                               |
|--------|----------------------------------------------------------------------------------------------------------------------------------------|
| 1      | A session-authenticated user asks a question in natural language in the chat UI (§10)                                                  |
| 2      | /api/chat (Node runtime, streaming) validates the request and invokes the agent                                                        |
| 3      | The Memory Manager loads the conversation thread and long-term user context                                                            |
| 4      | The agent reasons about what the question needs and selects tools via the Tool Registry                                                |
| 5      | Portal Tool → Portal Service → Session Manager ensures a valid session (silent login if needed) → Playwright scrapes the target module |
| 6      | Database Tool supplies historical telemetry through Prisma                                                                             |
| 7      | Analysis Tool computes metrics in TypeScript over the gathered data                                                                    |
| 8      | Report Tool renders Markdown / PDF when a document is requested                                                                        |
| 9      | The agent composes the answer and its Sources block; tokens stream to the UI; the full run is traced in LangSmith                      |
| 10     | The Memory Manager persists messages and learned preferences; audit and log entries are written                                        |

### The /api/chat streaming protocol

Step 9 streams NDJSON — one JSON object per line, `Content-Type: application/x-ndjson`. The contract is declared in `src/types/chat.ts` as the discriminated union `ChatStreamFrame`; this section records the rules a consumer may rely on.

| Frame | Cardinality | Consumer action |
|--------------|-----------------------|-----------------------------------------------|
| `token` | many | Append to the answer text |
| `tool_result` | one per parsed tool call | Accumulate — this is the report's EVIDENCE |
| `stage` | many, discardable | Replace by `id` — real backend progress |
| `sources` | once, before `done` | Replace the attribution list |
| `error` | 0–1, terminal | Show the message; the run failed |
| `done` | once, terminal | The run completed |

**Ordering guarantees.** Frames arrive in emission order, and each is a complete line — a reader must buffer partial lines, because one frame may be split across two network chunks and one chunk may carry several frames. `done` and `error` are terminal; nothing follows either. `sources` is sent exactly once on a successful run, immediately before `done`, and every `tool_result` precedes it, so the union of `tool_result` frames corresponds to the entries in `sources`. `token` and `tool_result` may interleave in either direction. `stage` frames arrive in causal order — each is emitted synchronously at the point its operation begins or ends — and a repeated `id` supersedes the earlier frame rather than adding a row; the same `(id, status)` pair is never sent twice.

**Not guaranteed:** that any frame type appears at all. A cancelled run ends without `done`; a run that calls no tool emits no `tool_result`. A run may end with a stage still `active` — that is not a violation, it is how the stream reports where execution stopped. A consumer renders from what arrived and never waits for what did not.

### Run progress (Phase 2)

A `stage` names one real backend operation. Progress exists only because a component performed work and said so: nothing is timed, interpolated, predicted or padded, there is no percentage — the pipeline has no denominator — and a run that never touches the portal emits no portal stage.

Stages are reported through `src/lib/run-progress.ts`, an `AsyncLocalStorage` scope opened by `/api/chat` and read implicitly by the services beneath it. It is shaped like `childLogger` for the same reason: a service says what it is doing and never learns that an HTTP stream exists. Outside a request there is no store, so `reportStage` is a no-op and `npm run auth:login` and `npm run portal:fetch` exercise identical code paths while emitting nothing.

The emitter guarantees four things, and they are what make an emit call safe inside a module whose behaviour must stay identical: it never throws, never awaits, never changes control flow, and never emits a duplicate `(id, status)`.

| Stage | Emitted by | When |
|--------------------|--------------------|------------------------------------------------|
| `planning` | Agent loop | First model turn |
| `tool` | Agent loop | Tool start → tool end, keyed by run id |
| `vehicle_resolved` | Analysis Engine | After the vehicle is proven to exist |
| `fleet_resolved` | Analysis Engine | After the population is enumerated |
| `database_read` | Analysis Engine | Per distinct read, dispatch → settle |
| `portal_connect` | Session Manager | Once browser work is committed to |
| `session_reused` | Session Manager | The stored session probed valid — no login |
| `session_expired` | Session Manager | The stored session had expired |
| `session_login` | Session Manager | A real sign-in, start → saved |
| `portal_read` | Portal Service | Navigate → extract, per module |
| `reconciling` | Analysis Engine | Precedence begins selecting sources |
| `writing` | Agent loop | First answer token |
| `completed` | Agent loop | Run finished, with measured duration |

A stage may never carry a credential, cookie, storageState, URL, selector, SQL fragment, page content or tool parameter. `detail` is a feed name, a module name or a tool name. `/api/chat` already declines to log tool parameters; a stage must not become the channel that does what the log policy refused.

**Failure is reported by absence, not by invention.** A stage left `active` when a run ends *is* the marker for where execution stopped, so no recovery stage is emitted for work that never happened. Tool failures close their own stage as `failed`, reusing the outcome the log record already computed, so the timeline and the log cannot disagree.

**Forward compatibility.** A consumer MUST IGNORE frames whose `type` it does not recognise, and must do so explicitly — an exhaustive `switch` with an `assertNever` default would satisfy the compiler today and turn the first new frame type into a runtime crash for every browser holding a cached bundle. This rule is what lets the union stay specific instead of becoming a general `payload` container: adding a member costs a branch in whoever wants it and nothing at all in whoever does not.

There is deliberately no protocol version field. The client and the route ship in one build and deploy as one container (Section 17), so there is no independently-versioned consumer to negotiate with, and a version nothing can disagree about is unreachable ceremony — the judgement Section 19 already records for `TARGET_AMBIGUOUS`.

**Reserved, and not declared until something emits it.** `artifact` carries a REFERENCE to a generated report — id, kind, title, href, size — and never inline bytes: NDJSON is line-delimited, so a base64 document is one enormous line that defeats a line-buffered reader; the stream serialises synchronously, so a large frame would block the run; and an artifact downloaded tomorrow cannot live in a stream that ended today. Reports are already assigned to Inngest (Section 13) with their own download route (Section 18). `stage` was reserved on the same terms and is declared as of Phase 2, below.

Markdown, charts and fleet summaries need no new frame: prose already arrives as `token`, and a chart or a summary is a rendering of data that already arrives as `tool_result`. A frame for either would move a presentation decision to the server.

### Reverse geocoding (Phase 3)

A coordinate is telemetry; the address shown above it is a label. The two are never merged, and the coordinate is never replaced, abbreviated or discarded — `LocationDisplay.coordinates` is non-nullable, so a component cannot render a location without it even by mistake.

```
Location Card (LocationValue)
      │
      ▼  formatLocation()          src/lib/location.ts        pure
Location Formatter
      │
      ▼  useReverseGeocode()       client hook, after render
Reverse Geocoder ──► /api/geocode ──► geocoder.service.ts ──► provider
                                            │
                                            ├─ address.ts    pure normalization
                                            └─ cache.ts      swappable cache
```

**Nothing that produces an answer knows this exists.** The Analysis Engine, Portal Service, Session Manager, Database Service, Planner, Tool Registry and agent neither import it nor are imported by it — enforced in both directions by `GEOCODING_ZONE` in `eslint.config.mjs`. The label is fetched by the BROWSER after a report has already rendered, so it never enters the model's context and can never be restated as though a vehicle had reported it.

**It cannot fail an answer.** `reverseGeocode()` never throws: a disabled deployment, an invalid coordinate, a rate limit, a timeout, a provider outage and a coordinate with no name all return `null`, and the UI then shows exactly what it showed before Phase 3. `/api/geocode` answers 200 with `{"address": null}` for every one of them — there is deliberately no error status and no error field, because an error the UI is required to ignore is noise, and a shape carrying one would invite a component to render "Failed to look up location" beside a perfectly good coordinate. The UI never displays "Unknown", "N/A" or a failure string.

**Caching** is keyed on the coordinate rounded to 4 decimal places, about 11 metres. That is calibrated rather than chosen: the Milestone 5D-1 pass measured consecutive GPS fixes for a *stationary* vehicle scattering by up to 11.26 m, so keying on the raw value would miss the cache on every read for exactly the vehicles that never move. Successful lookups live 24 hours; no-results live 10 minutes, so a transient outage cannot suppress addresses for a day. `GeocodeCache` is a two-method async interface with an in-process implementation; `setGeocodeCache()` is the seam a Redis-backed one slots into with no consumer change. Measured: 10 requests inside one bucket produce exactly 1 provider call.

**Provider calls are serialised and spaced** by `GEOCODING_MIN_INTERVAL_MS` (default 250 ms). The gap is courtesy rather than compliance — no published policy demands it here — and the cache already collapses repeat lookups, so it costs nothing while keeping a burst of distinct coordinates civil.

**The provider is BigDataCloud**, selected after the OpenStreetMap public Nominatim instance was measured returning `HTTP 403 Access denied` from a data-centre network — the condition a Railway deployment meets — which left the previous default architecturally sound and operationally dead. Of the providers compared (BigDataCloud, Geoapify, OpenRouteService, LocationIQ, Nominatim), BigDataCloud was the only one that answered a data-centre IP with **no credential**; the other three returned `401`. It also returns a structured administrative hierarchy rather than the nearest map object, so a rural coordinate resolves to its town and district instead of to whichever building happens to be closest — which matters for a fleet that does not operate in city centres.

**Two endpoints, one response schema, one environment variable:**

| `GEOCODING_API_KEY` | Endpoint | Use |
|---|---|---|
| unset *(default)* | `/data/reverse-geocode-client` | Zero configuration — a fresh clone resolves addresses immediately |
| set | `/data/reverse-geocode` | The endpoint BigDataCloud designates for server-to-server use |

Both return the same payload, so switching changes one URL and nothing else: no code path, no parsing, no cache behaviour. Setting a key is the recommended production posture — the keyless endpoint is named for client use, and while it serves a server correctly, a deployment should not rest on an endpoint whose name signals a different intent. A key is free and needs no card.

**Configuration** is `geocodingEnv()` in `src/lib/env.ts` — a third schema, lazy like `authEnv()` and with every field defaulted, so it cannot throw and cannot fail a boot or a build. `GEOCODING_ENABLED=false` removes the feature entirely.

> **Privacy.** Reverse geocoding sends vehicle positions to whatever endpoint is configured. That is inherent to the feature rather than a property of this provider. `GEOCODING_ENABLED=false` removes it, and the UI then shows exactly the coordinates it showed before Phase 3.

### Short-term run context (Phase 4A)

A conversation's durable part is WHAT IT ASKED ABOUT; its disposable part is the prose. Phase 4A separates the two, so that "that vehicle", "its temperature", "the same metric" and "that period" resolve to something specific instead of depending on whether the model happened to write a 20-character identifier into its own answer.

**Derived from executed tool calls, never from prose.** `TurnContext` is built only from `ToolEnvelope.source` of tool calls that actually ran — the same construction that makes the Sources block impossible to fabricate, applied to references instead of citations. `src/lib/turn-context.ts` reads `source.params` (the input a tool was called with, after Zod validation) and `source.method` (the resolved absolute window). **It never opens `envelope.data`.** An envelope carrying `error` is skipped: a failed call establishes nothing, so a rejected vehicle cannot become the next question's default subject.

| Field | Source | Resolves |
|---|---|---|
| `subjects[]` | `params.vehicleNo` (analysis) / `params.target` (portal); absent → `{kind:"fleet"}` | "that vehicle", "the other one" |
| `metrics[]` | `params.metric` (analysis only — a portal module is a source, not a metric) | "the same metric" |
| `window` | `method.windowFrom` / `method.windowTo`, present only when a derivation ran | "that period" |
| `now` | added by `/api/chat` from the instant the run already measures from | gives a period reference a referent |

Both lists are MOST-RECENT-FIRST and capped at 3 distinct entries, so element 0 is "the last one" and there is no separate `lastSubject` field — one value with two homes is a second thing to keep in step, the judgement §19 already records for the `population` field beside an `Aggregation`.

**THE CONTEXT NEVER CONTAINS TELEMETRY.** There is no state of charge, state of health, temperature, location, speed, fleet count, tool result payload or portal reading in it, and there is no field one could occupy. This is enforced by what is read rather than by a rule a caller must remember: measurements live in `envelope.data`, and no code path reads it. A value reaching the model without an envelope behind it would be a number the Sources block cannot account for.

**It resolves references; it never answers.** The prompt block states four rules: there are no measurements here · RESOLVE, THEN CALL THE TOOL · the current message always wins · if a reference is ambiguous, ask. A figure reported earlier in a conversation is never a figure that may be reported now — telemetry changes, and the grounding contract admits no exception for a number the model remembers.

**How it reaches the agent, and what it does not touch:**

```
browser derives from the tool_result envelopes it already holds
   │  request body `turnContext`   (client → server; NOT the stream protocol)
   ▼
/api/chat  ── Zod re-validation ──► adds `now` ──► streamEvents(..., { configurable: { runContext } })
   ▼
createReactAgent prompt FUNCTION → [SystemMessage(SYSTEM_PROMPT + block), ...state.messages]
```

The agent is a process-wide singleton, so nothing per-conversation may be baked in at construction; `prompt` therefore became a function of `(state, config)` and is the ONLY reader of the `configurable` key. The graph, the Tool Registry, every tool, the Analysis Engine, the Planner and every service neither read it nor know it exists. The function returns exactly the shape LangGraph builds for a string prompt, and `withRunContext(undefined)` returns `SYSTEM_PROMPT` itself — so **a run with no context is byte-identical to a pre-Phase-4A run.**

**THE STREAMING PROTOCOL IS UNCHANGED.** `ChatStreamFrame` gained no member and no frame was added. `tool_result` already carried the complete envelope to the browser, and the client already retained every one in `UiMessage.results`, so the context is derived client-side and travels UP the wire in the request body. The server → client NDJSON contract of §15 is untouched, and so is the ignore-unknown-frames rule.

**It is untrusted input**, because the browser sends it. Validation is on SHAPE and CHARACTERS, not membership: an identifier must match `/^[A-Za-z0-9._-]{1,64}$/` and a metric `/^[a-z0-9_]{1,64}$/`, both of which exclude whitespace and punctuation — so an injected sentence cannot be represented as a subject or a metric. Membership is deliberately not checked, because the Analysis Tool's own enum rejects an unknown metric and `requireVehicle` rejects an unknown vehicle; the worst a surviving value can do is make the model ask about the wrong REAL thing, visibly, in an answer that always names its subject. A malformed context DEGRADES to none (`.catch(undefined)`) rather than failing the question — the posture Phase 3 took for geocoding.

`SYSTEM_PROMPT_VERSION` is **1.3.0** as of this phase. The block is appended rather than woven in, and rendered from typed fields in a fixed order, so it is deterministic and two LangSmith traces of the same conversation state stay comparable.

### History bounding (Phase 4B)

A run was bounded in steps (`AGENT_RECURSION_LIMIT`) and in duration (`TOOL_TIMEOUT_MS`) and in NEITHER dimension of size. The whole transcript was resent on every turn, and `content: z.string().min(1)` set no upper bound on a single message. Phase 4B is the third bound, and it closes two independent dimensions.

| Bound | Value | Over the limit |
|---|---|---|
| `MAX_HISTORY_MESSAGES` | **20 messages** (ten exchanges) | **TRIMMED** — oldest turns dropped |
| `MAX_MESSAGE_CHARS` | **16,000 characters** per message | **REJECTED** — HTTP 400 |

**The two responses differ because the failures differ.** An over-long history means only that a conversation got long, which is not a mistake and must never 400 a perfectly good question. An over-long message means the caller sent something this system will not answer — and truncating it would answer a question the user did not ask, which is the same judgement the insufficiency contract already makes when it reports a gap rather than substituting for it.

`boundHistory` (`src/lib/history.ts`, pure) keeps the newest messages and trims the window to START ON A QUESTION, so a retained answer never appears as a reply to a question that is no longer present. It returns its input unchanged below the ceiling, so every short conversation puts byte-identical bytes on the wire. It is applied by the client to the complete array and again by `/api/chat` to the same array with the same function — which makes the route's pass a provable no-op for the Tarang UI and a real ceiling for anything else (a cached bundle, a script, a future consumer). The run log records `historyDropped`, a COUNT and never content, so a non-zero value identifies a consumer that did not apply the bound.

**A window, and deliberately not a summary.** Summarising dropped turns would put MODEL PROSE into the next run's context, where it is indistinguishable from a tool result: "SoH was 87%" would arrive as a fact with no envelope behind it — exactly the fabricated citation §6 exists to prevent. A window drops old turns; it never restates them.

**Phase 4A is what makes 4B safe.** What a dropped turn used to carry that mattered was its SUBJECT, and it carried it only as prose. That is now structured, and derived from every envelope the conversation ever produced rather than from the retained window — so a vehicle asked about forty turns ago still resolves after its prose has been discarded. The two phases are one design: 4A makes the durable part of a conversation structured, and 4B is what lets the disposable part actually be disposed of.

Neither phase adds a dependency, a table, a migration, a tool or a stream frame.

## 16. Observability, Logging & Configuration

### LangSmith

Every agent run is traced end to end: prompts, tool spans with inputs and outputs, latencies and token usage. Traces are the primary debugging surface for agent behaviour and the foundation for evaluation datasets at Level 2.

### Pino

Structured JSON logging with request IDs and per-service child loggers. Redaction paths cover credentials, cookies, storageState and authorization headers, so secrets cannot leak through logs even by accident. Log level is environment-controlled.

### Configuration

All configuration comes from environment variables, validated by a Zod schema in src/lib/env.ts at boot — a missing or malformed variable fails the process immediately instead of failing a request later.

| **Variable**                                        | **Purpose**                                                          |
|-----------------------------------------------------|----------------------------------------------------------------------|
| DATABASE_URL                                        | Application PostgreSQL connection string (Prisma)                    |
| IOT_AGENT_DATABASE_URL                              | IoT PostgreSQL connection string, `iot_agent_ro` role. Validated lazily; absent means the Database Tool reports itself unconfigured rather than failing the app |
| IOT_DB_POOL_MAX, IOT_DB_CONNECT_TIMEOUT_MS, IOT_DB_QUERY_TIMEOUT_MS | IoT pool bounds. Defaults 3 / 5,000 / 20,000. The last matches the server's `statement_timeout` and is never raised |
| IOT_BASTION_HOST, IOT_BASTION_USER, IOT_BASTION_KEY, IOT_RDS_ENDPOINT | Read by `scripts/tunnel.mjs` only. **The application never reads these and never spawns ssh** |
| OPENAI_API_KEY / OPENROUTER_API_KEY                 | LLM provider access                                                  |
| LANGSMITH_TRACING, LANGSMITH_API_KEY, LANGSMITH_PROJECT | Tracing configuration. All optional; tracing is OFF unless LANGSMITH_TRACING is "true", and a key is then required (§19, Milestone 3.5) |
| CREDENTIAL_ENCRYPTION_KEY                           | AES-256-GCM key for the credential vault (rotatable via key version) |
| CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY | Application authentication                                           |
| INNGEST_EVENT_KEY, INNGEST_SIGNING_KEY              | Background job delivery and verification                             |
| INTELLICAR_BASE_URL                                 | Portal entry point                                                   |
| INTELLICAR_EMAIL, INTELLICAR_PASSWORD               | Intellicar login credentials (Milestone 3; see §19 on the vault)     |
| SESSION_STORE_DIR                                   | Encrypted storageState location                                      |
| PLAYWRIGHT_HEADLESS, AUTH_TIMEOUT_MS                | Browser mode and the ceiling for one login attempt                   |
| LOG_LEVEL                                           | Pino log verbosity                                                   |

The Intellicar variables in this table are validated lazily, on first authentication use, rather than at boot — see §19 (Milestone 3) for why. The IoT variables are lazy for the same reason and a sharper one: the IoT database is reached through an SSH tunnel in development, so an eager schema would mean a developer with no tunnel could not run `npm run build`, could not start the app, and could not ask a question that has nothing to do with the fleet. `isIotDbConfigured()` reports the unconfigured state without throwing, which is what lets the Database Tool answer "not configured" as a *state* rather than as a crash — and what makes deploying this code to an environment that has no IoT access completely safe.

## 17. Deployment

Tarang deploys as a single long-lived Node.js process. This is a hard architectural requirement, not a convenience: the singleton Chromium, reusable browser sessions and streaming responses all assume a persistent process, which is why serverless function platforms are explicitly out of scope for this design.

- Docker: the image builds on the official Microsoft Playwright base image (browsers and OS dependencies preinstalled) and runs the Next.js standalone output. One container runs the UI, API, agent, services and Inngest handler together.

- Local and VPS: docker-compose brings up the app plus PostgreSQL; the same standalone server also runs directly under PM2 on a VPS.

- Configuration is injected only through environment variables — no secrets are baked into the image.

- Horizontal scaling is deliberately deferred: it requires moving the session store to shared storage and is scheduled on the roadmap rather than complicating Level 1.

## 18. Project Structure

A single repository, organised so that AI logic, tools, services, data access, automation and reporting are separated and independently testable:

tarang-agent/

├── app/ \# Next.js App Router

│ ├── (chat)/

│ │ ├── page.tsx \# Chat UI

│ │ └── layout.tsx

│ ├── api/

│ │ ├── chat/route.ts \# Streaming agent endpoint

│ │ ├── inngest/route.ts \# Background job handler

│ │ └── reports/\[id\]/route.ts \# Report download

│ └── layout.tsx

├── src/

│ ├── agent/

│ │ ├── agent.ts \# LangChain JS agent factory

│ │ ├── prompts.ts \# System & tool prompts

│ │ └── tool-registry.ts \# Zod-typed tool catalogue

\# NOTE: the memory/ directory below is NOT built. Short-term context lives in
\# src/lib/turn-context.ts and src/lib/history.ts (Phase 4A/4B) — pure modules,
\# because src/agent/\*\* may not import src/services/\*\* and the browser needs
\# them too. Long-term memory is not implemented at all (§7).

│ │ (└── memory/ \# planned; not created

│ │ ├── short-term.ts

│ │ └── long-term.ts)

│ ├── tools/

│ │ ├── portal.tool.ts

│ │ ├── database.tool.ts

│ │ ├── analysis.tool.ts

│ │ └── report.tool.ts

│ ├── services/

│ │ ├── portal/

│ │ │ ├── portal.service.ts

│ │ │ ├── extractors/ \# One per Intellicar module (7)

│ │ │ ├── fixtures/ \# Captured raw extractions; normalizers testable offline

│ │ │ └── normalizers.ts

│ │ ├── session/

│ │ │ ├── session-manager.ts

│ │ │ └── playwright-manager.ts

│ │ ├── credentials/

│ │ │ ├── credential-manager.ts

│ │ │ └── crypto.ts \# AES-256-GCM helpers

│ │ ├── database/

│ │ │ ├── telemetry.service.ts \# Prisma access layer (application DB)

│ │ │ ├── telemetry.records.ts \# JSON-safe shapes + conversions; no I/O

│ │ │ ├── telemetry.reader.ts \# Typed reads returning those records

│ │ │ ├── iot.pool.ts \# IoT DB: pg.Pool singleton, READ ONLY txns. The only file holding the DSN

│ │ │ ├── iot.queries.ts \# IoT DB: the named SQL catalogue. $n placeholders only, no interpolation

│ │ │ ├── iot.records.ts \# IoT DB: JSON-safe shapes + IotReadError; no I/O

│ │ │ └── iot.reader.ts \# IoT DB: intent dispatch, clamping, signal suppression

│ │ ├── analytics/ \# Analysis Engine (Milestone 5B)

│ │ │ ├── analysis-engine.ts \# Public entry; orchestrates the six stages

│ │ │ ├── planner.ts \# Stage 1 — request → requirements (pure)

│ │ │ ├── quantity-registry.ts \# Stage 2 — quantity ↔ provider vocabulary

│ │ │ ├── acquisition.ts \# Stage 3 — the only impure stage; deduplicated

│ │ │ ├── projections.ts \# Reading → measured quantity (pure)

│ │ │ ├── reconcile.ts \# Stage 4 — source precedence P0-P7 (pure)

│ │ │ ├── series.ts \# Stage 5 — over TIME: aggregates, change, trend (pure)

│ │ │ ├── aggregate.ts \# Stage 5b — over a POPULATION: mean, min, max (pure)

│ │ │ ├── conflict.ts \# Cross-source comparison + age plausibility (pure)

│ │ │ ├── observations.ts \# Observation + Derivation (types only)

│ │ │ └── fixtures/ \# Captured records; pure stages testable offline

│ │ └── reports/

│ │ ├── report.service.ts

│ │ └── templates/

│ ├── jobs/ \# Inngest functions

│ │ ├── client.ts

│ │ ├── sync-dashboards.ts

│ │ └── session-refresh.ts

│ │ ├── geocoding/ \# Reverse geocoding — presentation only (Phase 3)

│ │ │ ├── geocoder.service.ts \# Provider call, throttle, timeout; never throws

│ │ │ ├── address.ts \# Pure normalization of a provider payload

│ │ │ └── cache.ts \# Swappable cache; in-memory by default

│ ├── components/ \# Presentation only — no service, no Prisma, no agent

│ │ ├── chat/ \# Composer and transcript pieces

│ │ ├── report/ \# Facts, Evidence, Sources — the answer's fixed grammar

│ │ └── ui/ \# Disclosure, Markdown — shared primitives

│ ├── lib/

│ │ ├── prisma.ts \# Singleton client

│ │ ├── logger.ts \# Pino + redaction

│ │ ├── env.ts \# Zod-validated environment

│ │ ├── format.ts \# Pure presentation formatting; never re-rounds a value

│ │ ├── facts.ts \# Tool envelopes -> the fact rows the report renders

│ │ ├── turn-context.ts \# Tool envelopes -> the run's references (Phase 4A); pure

│ │ ├── history.ts \# Conversation window + message ceiling (Phase 4B); pure

│ │ └── langsmith.ts

│ └── types/

├── prisma/

│ ├── schema.prisma

│ └── migrations/

├── reports/ \# Generated output (volume)

\# NOTE: there is NO middleware.ts. Phase 4D protects routes at the route itself.

├── Dockerfile

├── docker-compose.yml

├── next.config.ts

└── package.json

### Repository mapping

| **Architecture element**             | **Location**                         |
|--------------------------------------|--------------------------------------|
| Streaming chat endpoint              | app/api/chat/route.ts                |
| AI Agent Service                     | src/agent/agent.ts                   |
| Tool Registry                        | src/agent/tool-registry.ts           |
| Short-term run context (Phase 4A)    | src/lib/turn-context.ts              |
| Application identity (Phase 4D)      | src/services/identity/               |
| Memory Service (Phase 4E)            | src/services/memory/memory.service.ts |
| History bounding (Phase 4B)          | src/lib/history.ts                   |
| Memory management route (Phase 4E)   | src/app/api/memory/route.ts          |
| Chat surface / auth controls (4F)    | src/components/chat/ChatSurface.tsx  |
| Memory verification runner (4F)      | scripts/memory-check.ts              |
| Portal Service                       | src/services/portal/                 |
| Session Manager / Playwright Manager | src/services/session/                |
| Credential Manager                   | src/services/credentials/            |
| Database Service                     | src/services/database/               |
| Analysis Engine                      | src/services/analytics/              |
| Report Service                       | src/services/reports/                |
| Background jobs                      | src/jobs/ + app/api/inngest/route.ts |

## 19. Design Decisions

- Single runtime, single repository. One endpoint did not justify a second service; removing FastAPI eliminates the HTTP contract, CORS, duplicated configuration and a second deployment pipeline, and lets types flow from database to UI.

- Service layer over fat Route Handlers. Handlers authenticate, validate and stream; capabilities live in services with typed interfaces. This keeps the agent testable and the blast radius of any change small.

- LangChain JS retained as the AI framework. It preserves the LangSmith tracing investment, keeps tool abstractions familiar from the v2.0 design, and its LangGraph runtime is the direct upgrade path for Level-2 multi-agent workflows.

- Agent isolated from authentication and browsers. Credentials, cookies and storageState are handled by dedicated services the agent cannot reach; a misbehaving or prompt-injected agent cannot leak what it never sees.

- ~~Clerk for application authentication.~~ **SUPERSEDED at Phase 4D.** Neither Clerk nor Auth.js was adopted: no external authentication provider was wanted, and Auth.js additionally requires a user store, which would have pulled a Prisma model into a phase built to have none. The review that settled it found the ingredients already present — `crypto.ts` seals and opens with a purpose-bound AAD written for a second caller, Next ships `cookies()`, and Node ships `scrypt` — so a self-hosted sealed-cookie session cost ZERO new dependencies where a provider cost one plus an external service and a paid tier. What was given up is real and recorded in §10: no self-service signup, no password reset, no MFA, and no per-session revocation. For an internal analyst tool with a handful of users that is the right trade; if self-service or revocation becomes a requirement, a `User` table is the next step and the `OwnerId` contract does not change.

- SQL-first analytics in TypeScript replaces Pandas. Battery analytics at Level 1 — degradation trends, cycle counts, utilisation — is aggregation, which PostgreSQL does natively; TypeScript finishes the last mile. A Python analytics worker is deliberately deferred until a genuinely statistical workload appears.

- One authoritative feed per quantity (Milestone 2C). The three telemetry feeds carry overlapping quantities: battery_telemetry has its own pack_voltage / pack_current / pack_temp_c, can_telemetry carries its own soh, and gps_telemetry carries a pack-level ext_voltage. Each user-facing quantity is therefore assigned to exactly one feed, so a reported number cannot change meaning depending on which table answered it:

  | Quantity | Authoritative feed |
  |---|---|
  | State of health | battery_telemetry.soh_pct |
  | State of charge, pack voltage, pack current, pack temperature, charge cycles, all cell-level metrics | can_telemetry payload signals |
  | Location and speed — and nothing else | gps_telemetry |

  These assignments are architectural decisions, not inferences from which columns happen to be populated in the current sample. Reassigning any of them — including switching state of health to the CAN soh / soh_1 signals — requires an explicit design decision amending this section, never a silent reaction to a new dataset. Two exclusions are part of the decision: gps_telemetry.ignition is not exposed at all (it reads false in every sampled row while speed reaches 27.2 km/h), and where CAN carries competing signals for one quantity the catalogue names the winner and records why the alternatives were rejected.

- Metric catalogue lives in the Analysis Tool, not in an analytics service (Milestone 2C). Milestone 2C exposes latest-value readouts: one measured signal each, with the time it was measured. That is retrieval and mapping, not analysis, so it stays in src/tools/analysis.tool.ts as a pure catalogue over the JSON records the Database Tool returns. src/services/analytics/ is deliberately not created until there is real analysis to put in it — trends, degradation, cycle-rate and utilisation — which is also why alarm and protection bitfield decoding is deferred: it needs a firmware bit map that is not available.

- Per-result source attribution for multi-source tools (Milestone 2C). ToolResult carries an optional origin that overrides the spec's, because the Analysis Tool now reads three tables and a fixed spec-level origin would attribute a CAN signal to battery_telemetry in the user-facing Sources block. The Tool Registry still builds and owns the envelope (Section 6); the override only lets a tool name the source that actually answered. A single-source tool declares origin once on its spec and never sets it.

- Missing telemetry is reported, not thrown (Milestone 2C). A vehicle with no rows in a feed, or a row whose signal is absent or holds a placeholder, returns available: false with a human-readable reason and a null value — never a zero standing in for absence. Only genuine faults (an unregistered vehicle, a failed query) become envelope errors. This keeps a metric's identity and provenance intact instead of collapsing them into an error string, and matches the Database Service's existing treatment of an empty time window as an answer rather than a failure.

- Authentication is an internal service, never a tool (Milestone 3). The brief for Milestone 3 called for an "Authentication Tool"; it is deliberately NOT one. Level 1 registers exactly four tools (portal, database, analysis, report), the agent must never authenticate (§5), and the Tool Registry copies a failing tool's error text into the model's context — so a login reachable by tool call would be a prompt-injection-reachable authentication trigger with a credential-shaped error path. The login flow is therefore an internal module (src/services/session/authenticator.ts) reached in-process, exactly as the Database Tool adapter is reached by the Analysis Tool rather than by the LLM. Milestone 3 adds zero agent-callable surface: src/agent/ and src/tools/ are untouched, so the tool list and system prompt are byte-identical before and after. The boundary is enforced mechanically by import-zone rules in eslint.config.mjs, in both directions.

- Intellicar credentials come from the environment at Milestone 3 (deferring the vault). §9 specifies an AES-256-GCM CredentialVault row; that needs a User model and Clerk, both out of Milestone 3's scope. Credentials are therefore read from INTELLICAR_EMAIL / INTELLICAR_PASSWORD. The trade is explicit: the credential sits in plaintext in .env.local rather than as ciphertext in PostgreSQL. .env.local is gitignored and already holds DATABASE_URL, so this adds no new class of exposure, but it is weaker than §9's end state. The Credential Manager's public surface — `withCredential(run)`, which LENDS the plaintext for one call and never returns it — is written so the vault replaces one private function body and no caller changes.

- Session metadata lives beside the sealed blob, not in PostgreSQL (Milestone 3). §8 puts a PortalSession metadata row in the database; that table needs a User model, also out of scope. Metadata (savedAt, lastValidatedAt) is stored unsealed in the same file as the sealed storageState, so lastValidatedAt updates without re-encrypting. The upside is worth keeping: authentication at Milestone 3 has ZERO database dependency — no Prisma import, no migration, no possible interaction with the telemetry retrieval path.

- The stored storageState is encrypted, per §8 (Milestone 3). AES-256-GCM with a fresh IV per write, a purpose-bound AAD so a sealed session cannot be opened as anything else, and a recorded key version. An unopenable file — wrong key, rotated key, corrupt, or an unknown format version — is treated as ABSENT rather than fatal: it triggers a fresh login that overwrites it, so the system is self-healing instead of stranded on a bad file. The crypto module takes the key as a parameter and knows nothing about sessions or credentials, so the CredentialVault reuses it unchanged.

- Chromium is closed after each authentication run at Milestone 3. §11's warm singleton assumes a scraping consumer on the request path; Milestone 3 has none, so keeping hundreds of megabytes of Chromium resident between logins buys nothing. The browser is still a lazily-launched globalThis singleton (hard rule 4) — it is simply released when the run ends. This is a single named constant, CLOSE_BROWSER_AFTER_RUN in session-manager.ts, which Milestone 4 flips to false when the Portal Service starts scraping on the request path.

- Browser work is serialised, and repeated login failure latches authentication off (Milestone 3). Two concurrent callers finding an expired session would otherwise both log in: two browsers, two racing writes to one session file, and two failed attempts counted against the Intellicar account. §13 caps browser work at one concurrent job per user via Inngest; until Inngest lands, an in-process queue provides the same guarantee for the single long-lived process §17 mandates. Separately, a rejected credential — or three consecutive failed sign-in attempts of any kind — stops authentication for the life of the process (§10 step 4: "nothing is retried until they do"). The consecutive-failure ceiling exists because the immediate INVALID_CREDENTIALS path depends on a login-error selector that is an unverified placeholder; the ceiling is the lockout protection that does not depend on any selector being right. Neither mechanism survives horizontal scaling, which §17 already defers along with the shared session store it would require.

- Login-flow knowledge is a single constants block of documented placeholders (Milestone 3). Every URL and selector THE LOGIN FLOW needs lives in one `INTELLICAR` block in authenticator.ts, each unverified entry marked TODO(intellicar), with the replacement procedure in docs/AUTH-SETUP.md. Dashboard-module paths and selectors are not in this block — see the extraction-ownership decision under Milestone 4A. Candidates are raced selector by selector rather than joined into one CSS union — Playwright's `text=` and `xpath=` are separate selector engines, so a joined string is invalid as a whole and would silently turn a rejected login into "no recognisable outcome". Racing separately also means any Playwright selector syntax works and one bad entry costs only itself. Success is asserted POSITIVELY — an authenticated-only element plus a URL that is not the login page — never by the absence of an error, because a re-rendered login form is otherwise indistinguishable from a successful sign-in. Error detection is split for the same class of reason: selectors that ARE the message (LOGIN_ERROR_TEXT) count on presence, while CONTAINER selectors count only when they hold non-empty visible text, and the Next.js route announcer is excluded by id. The live portal renders that announcer with role="alert" at 1px rather than display:none, so Playwright treats it as visible and an empty-text match reported every login as rejected — including correct ones. The id exclusion is not redundant with the text requirement: the announcer carries the new page title after a route change, so on a SUCCESSFUL login it is a visible role="alert" element WITH text, and a text check alone would race a false rejection against the real success.

- Authentication configuration is validated lazily, in a second env schema (Milestone 3). src/lib/env.ts validates application configuration eagerly at import and throws, which is right for what the whole system needs. The Intellicar variables are validated on first authentication use instead. Adding them to the boot schema would stop a developer without portal access from building or running the app, and would make the telemetry path depend on authentication configuration — the exact coupling this milestone exists to avoid. Environment access still has exactly one home.

- The Tool Registry owns bounded tool execution (Milestone 3.5). §5 specifies "a bounded loop with a maximum iteration count and per-tool timeouts". The iteration count is `AGENT_RECURSION_LIMIT` in src/agent/agent.ts; the duration bound is `TOOL_TIMEOUT_MS` in src/agent/tool-registry.ts, applied inside `defineTool()` — the same wrapper that already owns the result envelope, and the one place every current and future tool passes through. It is therefore implemented exactly once, and a tool cannot be registered without it. Individual tools MUST NOT implement a timeout of their own to duplicate this. The one legitimate exception is a service enforcing a stricter INTERNAL SLA over a sub-operation it understands — a per-module ceiling inside the Portal Service, say — which is a different concern from this outer ceiling, whose job is only to guarantee that an agent run ends. A tool whose work is a genuinely different shape from the default declares `timeoutMs` on its spec instead of raising the shared default; the field is optional and rare, and every existing tool omits it.

- A tool timeout is a normal result, not a crash (Milestone 3.5). The timeout throws inside the `try` that already wraps every handler, so it takes the existing failure path and arrives at the model as an ordinary `{ data: null, error, source }` envelope. No new envelope shape, no change to ToolEnvelope, and no prompt change: §6's contract and the system prompt already tell the agent to report a tool's `error` rather than fill the gap with a guessed value. `source.origin` falls back to the spec's, which is precisely what that fallback was documented for — the handler never returned, so no per-result origin exists. The message names the tool and its budget and tells the model not to retry within the turn, because a retried timeout costs both another full budget and two more steps of the recursion limit.

- Timeout bounds the wait, not the work (Milestone 3.5). `Promise.race` reports the first outcome; it does not cancel the loser. A timed-out handler keeps running to completion — and for the Portal Tool at Milestone 4 that means it also keeps holding the Session Manager's browser queue, so a hung scrape degrades from "this request hangs forever" to "this request fails cleanly and the next portal request queues behind a zombie". Real cancellation requires an AbortSignal threaded into the handler, which changes the ToolSpec handler signature and is deliberately deferred to Milestone 4, when the Portal Service exists to act on one. Building that extension point now would be an unreachable abstraction: the only registered tool calls Prisma, which has no signal to hand it.

- Cancellation is a request-scoped signal, propagated not constructed (Milestone 3.5). /api/chat owns the AbortSignal because it owns the request: it combines `request.signal` with the response stream's `cancel()` callback via `AbortSignal.any`, since either may fire first — the platform reporting the request is over, or the stream reporting nobody is reading. That signal is passed to `streamEvents` and from there LangChain propagates it to every child runnable (`pickRunnableConfigKeys` forwards `signal`; `mergeConfigs` composes rather than overwrites). The agent factory is untouched: cancellation is per-invocation config, never construction-time state, so the cached compiled graph is unaffected. The immediate benefit is not Playwright but the model client — an abort terminates the in-flight OpenRouter request instead of paying for tokens no one will read.

- One signal, two reasons, handed to tools as ToolContext (Milestone 3.5). The Tool Registry merges the run's signal with the tool's own time budget and gives the handler a single AbortSignal that fires for either; `signal.reason` distinguishes them for anything that cares. Merging is what stops a handler from having to reason about which bound tripped — it stops the same way for both. The two bounds do not replace one another: the race guarantees an agent run ends even for a handler that cannot be interrupted (Prisma exposes no AbortSignal, so the Analysis Tool's query genuinely cannot be stopped), while the signal is what releases a real resource when one can be. `ToolContext` is an object rather than a bare parameter so a later addition — a run id for tracing — is another non-breaking field instead of another signature change. It names one web standard and nothing else: no browser, no transport, no portal.

- Adding the context parameter required no change to any tool (Milestone 3.5). `ToolSpec.handler` gained a second parameter, yet src/tools/ was not touched, because a function declared with fewer parameters is assignable to a function type with more. Cancellation is therefore opt-in by construction: a handler that does not need it simply declares one parameter. This is the same property that made `timeoutMs` cheap, and it is why the Portal Tool can consume the signal at Milestone 4 while the Analysis Tool never mentions it.

- The Portal Service will cancel by closing the resource, not by passing the signal on (Milestone 4). Playwright accepts no AbortSignal anywhere in its API, so cancellation cannot be forwarded into it. The mechanism instead is to close the BrowserContext on abort, which rejects every in-flight operation on it. That closing happens inside src/services/session/, so no Playwright type crosses the tool boundary and no BrowserContext escapes: the signal travels inward and nothing comes back out. `withAuthenticatedContext` will take an optional `{ signal }` at Milestone 4 — additive, so `ensureAuthenticatedSession()` and the manual runner are unaffected. The payoff is that an aborted scrape settles `withAuthenticatedContext` and releases the Session Manager's serialisation queue, which a bare timeout cannot do.

- An aborted run is a shutdown, not a failure (Milestone 3.5). When the signal fires, `streamEvents` throws — but the client that would read an error frame is by definition already gone, so no `{ type: "error" }` frame is emitted. The check is made on `signal.aborted` rather than on the error's shape, because the throw can originate in the graph, the model client or a tool, each with its own error type, while "was this run cancelled" has exactly one answer. Enqueueing to or closing a cancelled ReadableStream throws `TypeError: Invalid state`; before this step nothing cancelled so it never fired, and guarding the controller is therefore a required part of the same change rather than incidental hardening.

- Observability lives in the Route Handler, not the Tool Registry (Milestone 3.5). §16 specifies structured logging with request IDs; before this step nothing on the agent path logged at all — src/agent/, src/tools/ and src/services/database/ contained no logger reference, so a failed chat request left no server-side record of which tool ran, with what result, or how long it took. That record is now built in /api/chat, for the same reason the AbortSignal is: the route owns the request, so it owns the request id and the run's log record. It already consumes the event stream and already parses every tool envelope, so a tool span is derived from what is in front of it. This is what keeps the Tool Registry free of a logger dependency — a deliberate property, not an accident of ordering.

- Logging policy is written for the inputs tools will have, not the ones they have now (Milestone 3.5). A tool span records the request id, the tool name, the duration and the outcome — and not the parameters. Today's parameters are innocuous (a fleet identifier), but the Portal Tool's will name dashboard modules and fleet targets, and a policy that logs everything by default becomes a leak the moment a richer input arrives. Tools may opt into structured diagnostics later; the vehicle for that already exists as the tool-declared `source.method` on the envelope, so no new field was invented for it. Result DATA is never logged either: unbounded telemetry payloads, never diagnostic. The error text IS logged, because it is already written to be safe to show — it reaches the model's context by design — and without it an "error" outcome says nothing a reader can act on.

- Token events are not logged (Milestone 3.5). `on_chat_model_stream` fires once per token; a log line there would emit thousands per request and drown the run record it belongs to. Only tool boundaries and run boundaries produce lines: one on start, one per tool call, one on finish.

- An aborted run logs as aborted, not failed (Milestone 3.5). The outcome vocabulary is completed / aborted / failed, decided on `signal.aborted` exactly as the error-frame suppression is, so a client disconnect cannot read as an incident. A tool span still open when the run ends is reported as `incomplete` rather than dropped — the ordinary shape of a cancelled run, and precisely what wants seeing when a Portal scrape is interrupted at Milestone 4.

- LangSmith is configured but not enabled (Milestone 3.5). The `LANGSMITH_*` variables are declared in src/lib/env.ts so the setting has one documented home and a misconfiguration fails at boot — tracing turned on with no API key is validated against, because it would otherwise start silently recording nothing. But this schema does not enable anything: @langchain/core reads `process.env.LANGSMITH_TRACING` itself, and never consults the validated object. Tracing therefore remains off unless a deployment sets it, which is deliberate — enabling it sends prompts, model outputs and tool results to an external service, and that is a deployment decision rather than a code one. src/lib/langsmith.ts (§18) was NOT created: with tracing being env-only, that module would have nothing in it, and the rule this codebase applies to src/services/analytics/ applies here too.

- Portal knowledge follows ownership, not file convenience (Milestone 4A). The Session Manager owns authentication and the Portal Service owns live dashboard extraction, so each owns the portal-specific values its job needs. The `INTELLICAR` block in authenticator.ts holds the LOGIN flow's URLs and selectors and nothing else; each dashboard module's path and readiness selector are declared with that module under src/services/portal/extractors/. The Milestone 3 rule that put "every Intellicar URL and selector" in one block was written when authentication was the only portal consumer; extending it to seven dashboard modules would make authenticator.ts the knowledge store for scraping it does not perform, and would force the Portal Service to reach past session-manager.ts — the one public entry point §8 gives that module. The narrower rule keeps the Milestone 3 property that matters: when the portal's markup changes, exactly one file changes, and it is the file that owns the thing that changed.

- The Portal Service's four roles are separated by import zone, not by convention (Milestone 4A). portal.service.ts holds the browser context and is the only caller of `withAuthenticatedContext()`; extractors only READ a page they are handed, never navigate to one and never see a credential; normalizers.ts is pure parsing and cannot import Playwright at all; Zod validates every normalized result. All four are enforced mechanically by the Portal zone in eslint.config.mjs, in the same spirit as the Milestone 3 authentication zones — including that no Playwright type may cross out of src/services/, so a page, a context or a cookie can never reach a tool or the agent. The chain is composed once, in `defineCapability()`, for the same reason `defineTool()` owns the result envelope: a capability that could skip validation would eventually skip it.

- Fleet Overview is the landing view, and its catalogue is what the portal renders (Milestone 4B). Verification against the live dashboard found no separate Fleet Overview route: the portal's landing view IS the fleet map, with twelve status counts in its header — All Vehicles, Running, Stopped, Immobilized, Non Communicating, Device Pullout, Immob Pullout, MIL, Rectification Required, Panic Button, No GPS Fix, Location Never Received. The catalogue is those twelve, fixed rather than discovered per call, so a card the portal stops rendering returns `available: false` with a reason instead of a silently shorter array. Metrics are matched by LABEL, never by position: the cards render as an ordered row, and an index-based reader would silently reassign every metric the day a card is inserted. The SoC and cell/battery temperature distribution buckets on the same page are deliberately excluded — they are battery and health analytics, which §11 assigns to the Battery Analytics and Health & Analytics modules, and a bigger Fleet Overview is not the same thing as the right module.

- Readiness is asserted against rendered data, never against the network (Milestone 4B). The portal is a client-rendered SPA: `domcontentloaded` resolves 5-11s before the counts exist, and `networkidle` is meaningless on a page holding map tiles and polling open — the same finding that shaped the authenticator's startup wait. Each capability therefore declares readiness selectors that target a DATA-bearing element, raced candidate by candidate, and a page that never renders one fails as MODULE_CHANGED rather than being extracted empty and normalised into confident nulls. `readySelector` is a LIST for the reason every `INTELLICAR` entry is: portal markup is discovered, not specified, and one stale selector must cost only itself.

- A captured fixture is what makes normalizer purity useful (Milestone 4B). src/services/portal/fixtures/ holds real raw extractions — rendered text exactly as an extractor handed it over, including the trailing space the portal puts on one label. The pure/impure split is only worth having if the pure half can actually be run, and a fixture is what lets a normalizer be exercised and reviewed with no browser, no session and no network. This is the one addition to the §18 tree that Milestone 4B makes.

- Cancelling a login is not a failed login (Milestone 4B). Cancellation is implemented by closing the BrowserContext, which makes whatever was in flight fail — and during a sign-in that surfaces as UNEXPECTED_PAGE, which the Session Manager counts towards its three-strike lockout latch. Left alone, a user closing a tab three times would latch authentication off for the life of the process. The signal is therefore checked BEFORE any failure is classified, in the probe path and the login path alike, and a cancelled run raises SessionError CANCELLED, which is never counted and never latches. The ordering is the whole fix.

- The Tool Registry binds each spec at its own type (Milestone 4B). Registering a second tool broke `specs.map(defineTool)`: two tools have two different Zod schemas, so an array of specs infers a union, and a union cannot satisfy one `TSchema` because a handler's input type is contravariant. Each spec is now wrapped by its own `defineTool` call. The alternative — erasing the schemas with a cast to keep the map — would have traded every tool's end-to-end typing for one line of brevity, at exactly the boundary whose job is to make tools type-safe.

- Vehicle Summary is an EIGHTH module, not a bigger Fleet Overview (Milestone 4C). §11's seven are the v2.0 module list; a per-vehicle readout is none of them, and folding it into Device Management — a device inventory view — would misname it. `PORTAL_MODULES` therefore gains `vehicle_summary`. The tool count is unaffected: Level 1 still registers exactly four tools (CLAUDE.md rule 6), and this adds one value to the Portal Tool's `module` enum, not a fifth tool. The vocabulary lives in the architecture, so it is amended here rather than in a milestone's code.

- The portal has no vehicle route, so resolution is a lifecycle phase (Milestone 4C). Verification against the live dashboard found no deep link of any kind: selecting a vehicle leaves the URL at `/` unchanged, and the only anchors on the page belong to the embedded map. A vehicle is reached by opening the dashboard's Table View and finding its row. That work is NOT an extractor's: `resolve()` is a distinct role declared on the capability and executed by the Portal Service, which already owns navigation, so extractors keep reading a page they are handed and never reach for one.

- The read-only rule is restated as NEVER MUTATE (Milestone 4C). Milestone 4A wrote that an extractor "does not click through workflows, submit forms, or change anything"; that was written when the only capability needed no interaction at all. The invariant that actually matters is that Tarang never changes the customer's dashboard — an analyst that mutates what it measures is a defect class this codebase does not intend to have. Opening a view and paging a table is navigation, not mutation, and it is confined to `resolve()`. Extraction itself remains strictly read-only, and no capability may submit a form, save a setting, or issue a device command.

- Resolution is an exact row scan, never the portal's own search boxes (Milestone 4C). Two search controls exist and BOTH were measured unusable for identifying one vehicle. `#headersearch` filters the map and the header counts — an absent vehicle correctly drives All Vehicles to 0 — but leaves the table showing all 200 rows of the current page. The table's own search box is a loose token match: because every identifier in this fleet shares the `TK` and `51105` tokens, an EXACT vehicle number still returns 200 rows, while a nonsense identifier returns 0. A control that answers "0 or everything" cannot isolate a vehicle. The capability therefore pages the table and matches the Vehicle No cell exactly, which is deterministic and cannot select a near neighbour.

- A targeted capability cannot be declared without an identity assertion (Milestone 4C). `defineCapability()` takes a discriminated spec: `targeted: true` REQUIRES both `resolve` and `assertIdentity`, so the compiler rejects a targeted module that would extract without proving which vehicle it is looking at. This is the same reasoning that put Zod validation inside `defineCapability` rather than in each capability — a check that can be skipped eventually is. The assertion is redundant with the exact-match scan by construction, and is kept anyway: it converts a future resolution bug from a plausible wrong vehicle into a clean TARGET_NOT_FOUND.

- TARGET_AMBIGUOUS was designed and then not added (Milestone 4C). The 4C proposal included it for a fuzzy search returning several candidates. Exact-match resolution makes ambiguity unrepresentable, and an unreachable error code is unreachable cleverness — the same judgement that kept a credential-fingerprint latch out of the Session Manager. `TARGET_REQUIRED` and `TARGET_NOT_FOUND` are the two that can actually occur.

- The Vehicle Summary catalogue is the table's own columns, and its labels are not reinterpreted (Milestone 4C). The portal renders Vehicle No, Device No, Ignition, Model, Variant, Last Talk Time, Speed, Fuel and Address. Two deliberate departures. IGNITION is excluded: it renders as an icon with no text, whose state is encoded in a CSS modifier, and only one value of that vocabulary was observed — reporting it would be guessing at an encoding. FUEL keeps the portal's own name and is NOT relabelled state of charge, even though this is an EV fleet and the column reads 0-100. §19 already assigns state of charge to `can_telemetry` as its one authoritative feed; silently attaching that name to a portal column would let the agent present two different quantities under one word. Vehicle No is carried in `identity` rather than duplicated as a field.

- Milestone 4D was proposed as per-vehicle Battery Telemetry and became fleet-wide Battery Analytics, because discovery said so (Milestone 4D). The approved design was a TARGETED capability with `resolve()` and `assertIdentity()`. The discovery pass that gates every portal module found the portal has no per-vehicle battery view to target: none of the sixteen LeftPane controls opens one; selecting a vehicle leaves the URL unchanged and opens no battery panel, and the RightPane dial set it does show is ICE-oriented (Speed, RPM, Engine Temp, Fuel Level) with no battery quantity at all; and the `.InGraphControl` panel carrying "Start SOC" / "End SOC" is a TRIP PLAYBACK control that was byte-identical before any selection and after selecting each of two different vehicles — same device id, every value "No Data". Those two figures are trip aggregates needing a trip and a date range, which is historical work. What the portal renders live is three fleet-wide distributions, so the milestone was amended to build the account-wide Battery Analytics module §11 always named. The alternative — shipping the targeted design anyway — would have produced a module whose only real field was state of charge, re-read from the same `Fuel` cell Vehicle Summary already returns, which is the duplicate-quantity failure the entry below exists to prevent.

- The `battery_telemetry` module value was designed and then not added (Milestone 4D). The 4D proposal introduced it as a ninth module. Once discovery established the capability is account-wide, `battery_analytics` — already in `PORTAL_MODULES` from §11's original seven — was exactly the right name, and a second battery module would have been a synonym for it. This is the same judgement that kept `TARGET_AMBIGUOUS` out at 4C: a vocabulary entry that cannot be reached is unreachable cleverness. It also avoids a name collision with the `battery_telemetry` PostgreSQL table, which would have put a live portal reading and a historical feed behind one word in the user-facing Sources block.

- Battery Analytics names state of charge because the portal does, and this does not amend the authoritative-feed table (Milestone 4D). Milestone 4C refused to relabel the Table View's `Fuel` column as state of charge, on the grounds that renaming a portal column puts two quantities behind one word. This is the opposite case under the same rule: the portal itself titles the row "SoC", so `state_of_charge` is READ rather than reinterpreted. The live fleet distribution and the historical `can_telemetry` SoC signal remain different source classes, kept apart by the envelope's `origin` rather than by wording — the one-authoritative-feed table above governs which of the three HISTORICAL feeds answers a quantity, and a live portal reading is not one of them.

- Rows and bands are both matched by rendered label, and the capture proves why (Milestone 4D). The three distribution rows carry the container classes `newSocSwitch`, `newTempSwitch` and `newswitch` — the last generic enough for an unrelated row to take it — so rows are found by their rendered TITLE and the container is reached upward from it. The fixture captured from the live dashboard is the evidence this matters: the portal renders the rows in DOM order Cell Temp, Battery Temp, SoC, which is not their on-screen order, so a positional reader would have reported the cell temperature distribution as the state of charge. Bands are matched the same way, by exact equality on their squashed lower-cased label, which is what keeps "0%" from matching "<0%" or ">75%".

- A distribution total is not a fleet size (Milestone 4D). `total` is the sum of a distribution's bands, and it is nullable: one unreadable band makes it null rather than a partial sum that would look like a fleet count and be one. It is also not assumed to equal the Fleet Overview vehicle count — on the live dashboard the Battery Temp bands summed to 317 while the fleet was 320, because a vehicle reporting no battery temperature at all falls in none of the bands. This is the same rule the metric catalogues follow: missing data is reported, never substituted with a zero.

- A rendered timestamp carries the offset it was rendered with (Milestone 4C). "03-Aug-2026 03:13" is a wall clock with no zone, and this portal is a React SPA that formats dates client-side — so the zone is the BROWSER's, not a property of the data. The extractor therefore reads the page's own `getTimezoneOffset()` and hands it over alongside the text; the normalizer applies it, staying pure because the offset is an input rather than a clock read. The verbatim `rendered` string is always carried too, so the payload remains truthful even if a deployment's browser timezone is ever wrong.

- The Analysis Engine is a service, and the model is no longer where two sources meet (Milestone 5A/5B). Before this milestone the Analysis Tool read one column of one table, the Portal Tool read one dashboard module, and NOTHING in the system held both at once — so every cross-source judgement happened inside the LLM's context window. That is where a grounded system stops being grounded: not by fabricating a number, but by making an unrecorded choice between two real ones. `src/services/analytics/` is created to own that choice, and it is created now rather than earlier because Milestone 2C's condition — "not until there is real analysis to put in it" — is finally met. It is a SERVICE, reached in-process by src/tools/analysis.tool.ts exactly as the Portal Service is reached by the Portal Tool: no fifth tool, no registry entry, no new agent-callable surface, and Level 1 still registers exactly four tools.

- The engine never calls an LLM (Milestone 5A). Planning, reconciliation and computation are ordinary TypeScript, so an answer is reproducible from its inputs and a source decision is auditable rather than fluent. An LLM asked to choose between two numbers chooses confidently and unaccountably; the whole value of moving the choice into code is that the choice can be named, logged and reviewed. The model narrates what the engine decided.

- The engine sits ABOVE both providers, and no existing arrow is reversed (Milestone 5B). The Portal Service still cannot see the database and the Database Service still cannot see the portal; the dependency runs analytics → portal and analytics → database, never the other way. A new Analytics zone in eslint.config.mjs enforces it in both directions, and the engine is barred from the Session Manager, the Credential Manager and Playwright exactly as a tool is — being a service buys it no privilege, so CLAUDE.md rule 1 holds by linter rather than by convention. The Database Service's own zone was split from the tool layer's at this milestone, because for the first time something existed above it that it could reach upward for.

- Telemetry records moved below both consumers, and the reads were split from them (Milestone 5B). The record shapes and their Decimal/BigInt conversions lived in src/tools/database.tool.ts; the engine needs them, and a service importing from src/tools/ would invert the layering. They now live in src/services/database/telemetry.records.ts, which performs NO I/O — and that is why the reads were split into telemetry.reader.ts rather than left beside them. The pure half of the engine may import the records and could not be trusted to leave a reader alone, so the split is what makes the Analytics purity zone enforceable rather than aspirational. The same reasoning keeps normalizers.ts away from Playwright. `DatabaseToolError` became `TelemetryReadError` in the move: the type is now thrown on a path with no tool on it. Every MESSAGE is unchanged, which is what reaches the model.

- Observation is the universal data model (Milestone 5A). No number enters the engine that is not boxed with the source that produced it, its source class, and both times that matter — when the quantity was measured, and when the row or page carrying it was reported. A bare number has nowhere to record any of that. This is the Tool Registry's envelope discipline applied one layer down: the envelope makes a tool RESULT traceable, and the Observation makes each VALUE INSIDE one traceable, which is what a multi-source answer needs and a single-source tool never did.

- Source class is a second axis and does not amend the authoritative-feed table (Milestone 5A). §19's one-authoritative-feed rule governs which of the three HISTORICAL feeds answers a quantity and is restated verbatim in quantity-registry.ts, unchanged. `sourceClass` answers a question that table never spoke to: live dashboard reading, or recorded history. Keeping the two axes separate is what stops "the portal shows 62%" and "CAN recorded 41% six days ago" from being treated as rival answers to one question when they are answers to two.

- Precedence rules are implemented only where they are reachable (Milestone 5B). The approved ruleset is P0–P7. Milestone 5B declares one provider per quantity, so only P2 (the authoritative feed), P5 (availability is not precedence — an unavailable source is reported, never silently replaced) and P6 (one reported number, one provider) can be reached, and only those are written. P0 needs a fleet-scope provider to exclude (5E); P1, P3 and P4 all rank a live candidate against a historical one and there are no live candidates until 5D. Writing them now would mean branches no test could enter — the judgement already recorded for TARGET_AMBIGUOUS. Averaging two sources is not a rule that had to be disabled: `ReconciledValue.chosen` is a single Observation carrying a single Provenance, so a blended number is unrepresentable.

- Deduplication is a correctness mechanism, not an optimisation (Milestone 5B). Six of the ten quantities read `can_telemetry`. Fetching that row once per quantity would be wrong in a way worse than slow: three reads can return three different rows if telemetry arrives between them, and the answer would then present three quantities from three moments as one snapshot of the pack. Acquisitions are keyed by (source class, container, subject) — the planner's own key, so the cache is its decision made concrete rather than a second judgement — and the map holds the in-flight PROMISE rather than the resolved value, so concurrent requirements share one fetch instead of racing an empty cache. Measured: ten quantities cost four database reads, and all six CAN quantities carry one row time.

- Milestone 5B changes nothing the model or the user can see, and that is the test (Milestone 5B). The Analysis Tool's input schema, description, default metric, result shape, field ORDER, envelope, `origin` and every reason string are byte-identical to Milestone 2C's — verified differentially against the live database over 8 vehicles × 10 metrics plus the catalogue text and the VEHICLE_NOT_FOUND throw path, 81 comparisons with no mismatch. Field order is part of the claim because `JSON.stringify` emits keys in insertion order, so a reordered result is a different string in the model's context and in every trace for identical data. An engine that answers the same questions the same way is an engine whose foundations can be trusted before 5C and 5D start asking it new ones.

- Stage 5 and the live half are genuinely absent, not stubbed (Milestone 5B). battery-metrics.ts is not created, because 5B reports latest values only and there is nothing to compute; `Derivation` and `Conflict` are not declared, because nothing can produce them; `contributingSources` is not added to SourceAttribution, because there is never more than one source to list. Each arrives in the slice that fills it — computation at 5C, the live provider and conflict disclosure at 5D. This is the rule this codebase has applied since it declined to create src/lib/langsmith.ts.

- Derivation is the computed-value model, and it is carried even when the computation FAILED (Milestone 5C). A Derivation records the operation, the absolute window, the row count, the distinct-measurement count, the minimum that operation needs, the span the measurements covered, and whether the read was truncated. Attaching it to an unavailable observation as readily as to an available one IS the insufficiency contract: an answer of "there is not enough evidence" is worthless unless it says how much evidence there was, and "the window holds one measurement and a trend needs two" is something a user can act on by widening the window. `Observation.derivation` is present exactly when a value was computed rather than measured, which is the honest discriminator between "the pack measured 52.9 V" and "the pack averaged 52.9 V over 40 readings".

- Insufficient evidence is an observation, never an exception (Milestone 5C). Four shortfalls can stop a computation — an empty window, rows carrying no usable measurement of the quantity, fewer measurements than the operation needs, and a series thinned below the minimum by deduplication — and all four return an unavailable Observation with a reason and its Derivation. This extends the Milestone 2C rule ("missing telemetry is reported, not thrown") from a missing signal to missing EVIDENCE. What still throws is a question that cannot be asked, and the distinction is exact: no amount of data makes the mean of two positions a place, or makes a window that ends before it starts describe a period. Those are refused before any read, as the Portal Service refuses TARGET_REQUIRED.

- The engine is deterministic, so the clock read lives at the tool boundary (Milestone 5C). A relative window — "the last 90 days" — cannot be resolved without reading a clock, and an engine that reads one stops being reproducible from its inputs: the same request would plan differently every second. The single `Date.now()` therefore happens in src/tools/analysis.tool.ts, which hands the engine two absolute instants. This is the rule that already makes a portal extractor stamp `capturedAt` so its normalizer never has to, applied to the other end of the system. Verified rather than asserted: an identical request twice produces identical bytes.

- Samples are collapsed by measurement instant, and the counts are reported separately (Milestone 5C). A CAN payload is a last-known-value snapshot, so a signal that has not refreshed is re-reported verbatim in every subsequent row. Counting those severally would let an unchanged reading dominate a mean purely by being repeated, and would manufacture a flat run in a trend the vehicle never measured — one timestamp is one measurement. `readingCount` and `sampleCount` are both carried so the shrinkage is visible instead of silent, and the "too few measurements" message names both numbers when they differ, so a user looking at three rows in the database is told why the answer counted one. Deduplication is keyed by the PARSED INSTANT rather than the timestamp string, so two spellings of one moment cannot survive as two samples.

- The zero-span failure mode was designed and then deleted (Milestone 5C). `computeSeries` initially reported `no_time_span` for a series whose measurements all shared one instant — written for exactly the last-known-value case above. Deduplicating by instant made it unreachable: a prepared series of two or more samples has two or more distinct instants by construction, so a zero span cannot occur above the minimum, and the case it was written for now collapses to one sample and reports `too_few_samples`, which is both reachable and more accurate. This is the judgement already recorded for TARGET_AMBIGUOUS at Milestone 4C. The residual division guard remains but now THROWS rather than returning an insufficiency, because reaching it would mean the deduplication invariant had broken — a defect, not a fact about the fleet, and reporting it as "not enough data" would hide it behind a plausible answer.

- Stage 5 is called series.ts, not battery-metrics.ts (Milestone 5C). §18 reserved the latter name and it would be a misnomer: every operation in the file is quantity-agnostic — the mean of a pack temperature and the mean of a road speed are the same computation — and nothing in it knows what a battery is. Naming it after one domain would put the same lie in a filename that Milestone 4C refused to put in a column label. Battery-SPECIFIC analytics (degradation modelling, cycle-rate, utilisation) is genuinely different work with no home yet, because the data cannot support it: `soh_pct` reads exactly 100.00 in all 100 sampled rows and the CAN feed carries at most three rows per vehicle. When a dataset arrives that can carry it, battery-metrics.ts is where it goes, and it will consume series.ts rather than replace it.

- `mean` is a sample mean and says so (Milestone 5C). On an irregularly sampled feed a sample mean and a time-weighted average differ, and this data is irregular — the captured fixture spans intervals of 60s, 640s, 60s, 720s and 500s. Time-weighting would invent an interpolation the telemetry never made, so the arithmetic mean is computed and the limitation is documented, with `sampleCount` travelling beside every result so the density behind a mean is always visible. `trend` is a least-squares slope reported per day, carried at one more decimal than the quantity: a slow drift over a short window is a small number per day, and rounding it to the quantity's own precision would report real movement as exactly zero.

- Truncation is disclosed, never absorbed (Milestone 5C). A windowed read asks for exactly the per-table maximum telemetry.service.ts allows, so the service's clamp can never silently reduce a request below what was asked for. When the ceiling is nevertheless reached, `Derivation.truncated` says so and the envelope's method carries it, because truncation keeps the NEWEST rows — a truncated series is recent rather than representative, and silence would let a derivation over the last slice read as one over the whole period.

- A request without a derivation is unchanged, and that is the test (Milestone 5C). The Analysis Tool gained four optional inputs and behaves identically when none is given: same shape, same field ORDER, same strings, same `origin`, same `method`. Verified differentially against the live database over 8 vehicles × 10 metrics, alongside a windowed-acquisition check (53 real GPS samples, minimum/maximum matched against the database's own aggregates), five insufficiency cases, five refused questions, a Portal capability regression over all three module fixtures, and the five series operations checked against values computed outside this codebase.

- Discovery found the portal renders Last Talk Time two ways, and the normalizer now reads both (Milestone 5D-1 / 5D-2a). Reading all 320 Table View rows in one pass measured 200 carrying a bare epoch such as `1785744365673` and 120 carrying the formatted `03-Aug-2026 13:53`; the split fell exactly on the pager boundary, because this React table formats timestamps client-side AFTER the row renders. The same vehicle was observed unparseable on a cold read and parseable on a warm one. Before this, roughly three fifths of reads reported "in a format this system does not recognise" — a true statement about the parser and a false impression about the portal, which had reported the time perfectly well. `parseEpochMillis` is a SEPARATE function from `parseRenderedTimestamp` rather than a branch inside it, because they parse different things: an epoch is already an instant and needs no offset, while a wall clock is only as correct as the browser timezone applied to it. The payload records which one produced a value (`basis`), and an epoch carries `offsetMinutes: null` — nullable rather than optional so "no offset was needed" cannot be mistaken for "the offset was forgotten". This is a correction to the Portal normalization layer that Milestone 5D discovered; it is recorded here rather than in the 4C entries because 4C's capture was of a formatted row and could not have found it.

- A live reading's measurement time is Last Talk Time, never capturedAt (Milestone 5D-2). `capturedAt` is when Tarang looked at the dashboard; Last Talk Time is when the VEHICLE last reported. Using the former would let a page showing a vehicle silent for a month present itself as a reading taken seconds ago — the same freshness overstatement the CAN `measuredAt`/`reportedAt` split exists to prevent, and the reason that split generalises so cleanly to the portal. It is also the only input the P4 freshness gate has, which is why the epoch correction above was worth making before anything depended on it.

- The Conflict model carries a THREE-state age explanation, because discovery forced it (Milestone 5D-2). A conflict is only reported when both observations are available, describe one quantity, and differ by more than the quantity's declared threshold; the difference is then tested against how much could plausibly have changed over the gap between the two measurements. The third state — "unknown" — exists because a live reading's measurement time is intermittently unreadable, and with a boolean an unknown age would collapse into "unexplained" and let a rendering artefact dispute every value in the fleet. Unknown is reported and NOT escalated, which is the same rule that stops a missing measurement becoming a zero. Age is computed from the two observations' OWN timestamps and never from the current time: comparing against now would make the same two readings yield a different verdict every second, and the engine would stop being reproducible from its inputs.

- Plausibility is a declared rate, not an age window (Milestone 5D-2). `plausibleChangePerHour` applied to the gap is what separates "the pack drained over six days" from "the pack drained in five minutes"; a flat window cannot tell those apart. The rates are upper bounds on physical change rather than descriptions of the fleet — 120 km/h for a position, 3600 km/h per hour for speed — and the consequence for speed is deliberate: it is a high-frequency quantity, so almost any difference across a real gap IS explained by the gap, and comparing a live speed against a GPS row from seven weeks ago tells you nothing about a disagreement.

- Thresholds were calibrated against measurement, not chosen for roundness (Milestone 5D-1). Position: consecutive fixes taken while the vehicle was effectively stationary scatter by at most 11.26 m, so the threshold is 50 m — a parked vehicle must not report a conflict with itself every time it is read. Speed: consecutive samples move by a median of 0.30 km/h and a 95th percentile of 19.82 km/h, so the threshold is 2 km/h. The one genuine cross-source pair in this deployment differs by 0.23 km/h on speed (inside tolerance, no conflict) and 67.7 m on position (a conflict, comfortably explained by the 47-day gap) — which is the designed behaviour, observed on real data.

- A quantity cannot declare a live provider without declaring how its two sources are compared (Milestone 5D-2). `QuantityDefinition` is a discriminated pair, so the compiler rejects a `live` provider with no `reconciliation` spec. Without the pairing a live provider could be added and the comparison forgotten, and the engine would hold two values for one quantity with no declared notion of disagreement — reporting them as agreeing, or inventing a threshold at the point of use. This is the reasoning `defineCapability()` applies at 4C, where `targeted: true` requires both `resolve` and `assertIdentity`.

- The analytics purity zone bans I/O, not directories (Milestone 5D-2). The pure files were forbidden `@/services/portal/*` wholesale; that is now narrowed to `portal.service` and `extractors/*`. normalizers.ts is pure parsing that imports nothing but Zod, so a pure analytics file may take its types and its parsers without gaining a way to open a page — exactly the split telemetry.records.ts and telemetry.reader.ts were separated into at 5B, applied to the module on the other side of the engine. What matters is not which directory a file sits in but whether importing it can start a browser.

- Fuel stays Fuel, and the portal has no per-vehicle battery quantity (Milestone 5D). The Table View's `Fuel` column reads 0-100 on an EV fleet, but 4C decided that relabelling it `state_of_charge` would put two quantities behind one word, and 4D read the portal's `SoC` only because the portal itself uses that word. The rule is read the portal's name, never reinterpret it — so 5D declares live providers for exactly two quantities, `speed` and `last_known_location`, both of which the portal names as Tarang names them. A live-only `fuel_level` quantity is the honest way to expose the column and is deliberately deferred: it has no historical counterpart, so it cannot conflict, and adding it to a reconciliation milestone would be scope that does not exercise reconciliation.

- Cross-source verification rests on one real pair, and the rest is fixtures (Milestone 5D-1). All 70 database vehicles appear on the portal, but only ONE carries GPS telemetry — and `speed` and `last_known_location` are both GPS-fed, so exactly one vehicle can ever produce two candidates. The other 69 have a live value and no historical counterpart and therefore exercise the P5 substitution path instead. Separately, the telemetry sample ends 2026-06-17 while the portal is live, so every real pair is about seven weeks apart and every real difference is explained by age: the `unexplained` verdict is unreachable from real data and is verified from constructed fixtures, each recording which real observations it was derived from. This is the same admission Milestone 5C made about degradation trends — the data cannot support them, and that is reported rather than worked around.

- The engine reaches the portal from exactly one file, and a portal failure is an ANSWER (Milestone 5D-3). `acquisition.ts` calls `fetchPortalModule()` precisely as the Portal Tool does — plain data in, validated JSON out — so no page, context or cookie can reach the engine, and the Analytics zone still forbids the Session Manager, the Credential Manager and Playwright everywhere in it. The asymmetry with the database is deliberate: Postgres is the system of record and a failed query still throws, while the portal is a best-effort corroborator reached over a browser and someone else's web application. It can be unreachable, unconfigured, mid-deploy or simply not list the vehicle, and none of those is a reason to refuse an answer the database can already give — so a portal failure becomes an unavailable live observation carrying the Portal Service's own (already safe-to-show) message, P5 reports the historical value, and the substitution is named rather than silent. A missing portal configuration is answered without launching a browser at all.

- P1 keeps live readings out of series, which also keeps scrapes off the derivation path (Milestone 5D-3). A question about NOW ranks the live source first; a question about a PERIOD takes the historical source alone, because a live reading is a single point from a different measurement path with a different clock and feeding it into a trend would corrupt the series. It may be shown beside one; it may never be a member of one. The practical consequence is worth naming: a derivation makes no portal call, so windowed analysis costs no scrape latency and conflicts can arise only on latest-value requests.

- P4 is applied in reconciliation, not in planning, and it never guesses (Milestone 5D-3). The freshness gate needs both measurement times, which do not exist until the sources have been read — so the planner ranks on intent alone and reconcile.ts demotes a live reading that turns out to be older than the recorded one. When the live measurement time is unknown, which the 5D-1 discovery showed is common rather than exotic, the gate does not fire and P1 stands; the conflict machinery then reports the same gap honestly as an "unknown" age rather than inventing a verdict.

- Reconciliation disclosure appears exactly where there is something to disclose (Milestone 5D-3). The tool's result gains a `reconciliation` block ONLY when more than one source was consulted, so every quantity the portal cannot answer and every windowed derivation stays byte-identical to Milestone 5C — verified across eight quantities plus a derivation. The block names the class that answered, the precedence rule, the disposition, any conflict, and what the losing source said. The losing VALUE is carried in `data` rather than only in the envelope because the model needs it in hand: when the disposition is "disputed" it must report both figures, and it cannot do that from a value it was never given. The system prompt (v1.1.0) binds it to name the source, disclose a conflict, never average, and never adjudicate.

- The Analysis Tool now declares its own budget (Milestone 5D-3; re-budgeted at P1). The second sanctioned use of `ToolSpec.timeoutMs`, for the reason §19 gives: its work is now a genuinely different shape from an in-process read, since a latest-value request for speed or position may open a browser context, wait on a client-rendered SPA and page a 320-row table. It is the Portal Service's budget plus room for the database leg and the engine's own work — 120s over the Portal Tool's 90 originally, and 270s over `PORTAL_READ_BUDGET_MS` of 240s since the portal-latency measurement recorded below. It is a ceiling, not a delay — a request with no live provider still returns in milliseconds, and a healthy portal read completes in 40-70s.

- Verified end to end against the live dashboard, including a real conflict (Milestone 5D-3). A latest-value speed request consulted both sources and reported the live reading under P1, disclosing the recorded 0.23 km/h beside it. A position request produced a REAL conflict: 67.07 m between the live fix and the newest recorded one, above the calibrated 50 m threshold, explained by the 47.2-day gap and therefore resolved rather than disputed — which is what the 5D-1 calibration predicted at 67.7 m. The P5 substitution path also fired unprompted during verification when a portal read transiently failed, degraded to the historical value, and named the substitution: the failure-isolation design exercised by the portal itself rather than by a fixture.

- Attribution names every source that took part, not just the winner (Milestone 5D-4). `origin` keeps its meaning exactly — the source that ANSWERED — which is what lets every existing consumer keep working untouched: `parseToolEnvelope`, the tool-span logger in /api/chat, and the UI's Sources block all read it and none of them changed. Beside it, `contributingSources` lists what was consulted, with a `role` distinguishing the source that supplied the number from one that was read and set aside. A single-source result omits the field entirely, so the envelopes of every other tool, every portal-unanswerable quantity and every windowed derivation are byte-identical. The list is built MECHANICALLY from the reconciliation: each entry corresponds to an Observation the engine produced in that run, so a fabricated source is impossible for the same reason a fabricated citation is. The registry copies the list and does not build it — the tool knows which sources it weighed and the registry does not — which is the split that already governs `method` and `origin`: the tool declares the attribution's CONTENT, the registry owns its SHAPE and the guarantee that one exists (CLAUDE.md rule 2).

- The wire type restates the source-class union rather than importing it (Milestone 5D-4). src/types/chat.ts is the contract between the Route Handler and a CLIENT component, and importing the engine's own types would pull server code into the browser bundle. A wire type that depends on the implementation behind it is not a wire type, so the two-member union is written out — the one place in this codebase where a deliberate duplication is cheaper than the coupling that would remove it.

- Scope is the THIRD axis of the quantity vocabulary, and it amends neither of the other two (Milestone 5E). §19's authoritative-feed table decides which of the three historical feeds answers a quantity; `sourceClass` decides live or recorded; `scope` decides what the answer is ABOUT — one vehicle, or the population. `fleet_state_of_charge` reads `can_telemetry.payload.soc` BECAUSE `state_of_charge` does, and it says so by naming that quantity as its `memberQuantity` rather than by restating the table, so a future §19 reassignment carries the fleet quantity with it instead of leaving the two silently disagreeing. Fleet quantities are separate registry entries with their own names rather than a flag on the existing ten: that is P7 applied to scope, and it is what makes P0 a total check between subject kind and quantity scope rather than a heuristic.

- P0 is enforced in the PLANNER and is not a precedence rule (Milestone 5E). Both of its inputs — the subject's kind and the quantity's scope — are static and known before any read, so the gate belongs where its inputs are, exactly as the P4 freshness gate belongs in reconciliation where the measurement times finally exist. It refuses rather than filters: a candidate quietly dropped would leave the caller an unexplained "not available" for a quantity that is perfectly answerable at the other scope, so a scope mismatch is a QUESTION THAT CANNOT BE ASKED, refused before any read with a message naming the quantity that would have answered. Because it selects nothing, it is not a `PrecedenceRule` member — the same reason P3, P6 and P7 are not.

- A fleet observation is an Observation, and `Aggregation` is a SIBLING of `Derivation` rather than an extension (Milestone 5E). A Derivation describes a computation over TIME for one subject; an Aggregation describes one over a POPULATION. Merging them would produce a record whose `window` means nothing for a fleet snapshot and whose `populationSize` means nothing for a per-vehicle trend, and a record with conditionally meaningless fields is the shape this codebase keeps declining to build. The two compose instead, and which optionals an Observation carries is the honest discriminator between the four kinds of number the engine can report — measured, derived, aggregated, and both.

- Coverage and span are what a fleet answer must carry and a per-vehicle one need not (Milestone 5E). `contributingVehicles` against `populationSize` is the fleet counterpart of `sampleCount` against `readingCount`, and both cases it distinguishes are real here: state of charge covers 70 of 70 vehicles, state of health covers 1 of 70. The span matters for the same reason — the CAN payload is a last-known-value snapshot, so the contributing measurements for pack temperature are 59.4 DAYS apart, one vehicle's latest reading having been taken in April and another's in June. A fleet mean over that is a true statement about each vehicle's latest reading and a misleading one about the fleet right now, and carrying the span is what keeps the first from being read as the second. Thin coverage is never a refusal: a mean over 1 of 70 is answered WITH its coverage, because refusing would suppress a true statement while the numbers are a better disclosure than silence.

- One vehicle, one sample — the fleet counterpart of collapsing a re-reported CAN signal (Milestone 5E). A member contributes at most one measurement to an aggregate, enforced in `aggregate.ts` rather than trusted to the caller. Without it a vehicle reporting fifty rows would outweigh one reporting two, and the "fleet mean" would be a ROW mean wearing a fleet label — the same error `prepareSamples` prevents on the other axis. Members are ordered by fleet identifier, so which vehicle is named for a tied minimum is reproducible from the inputs rather than from whatever order the database returned.

- The population is RESOLVED, and that is why coverage can be reported at all (Milestone 5E). `resolveSubject` stopped returning void: a fleet's population is not recoverable downstream, so without it carried forward an aggregate's denominator would be "whatever rows came back" and a mean over three vehicles would be indistinguishable from one over seventy. It is resolved once per run, the reads are SCOPED to that explicit set, and the engine walks the population rather than the readings — so a vehicle with no row is a non-contributor counted against the denominator instead of vanishing from it. An unknown vehicle identifier still throws (it is a caller's mistake); an EMPTY fleet resolves to a population of zero and becomes an unavailable observation (it is a true statement about the deployment).

- The one-read rule: a fleet answer costs one page load, never one per vehicle (Milestone 5E). A fleet-scope live provider must name an ACCOUNT-WIDE module, and the constraint is structural rather than advisory — the fleet live read passes no target, so a targeted per-vehicle capability cannot be fanned across 320 vehicles inside a tool budget. The same discipline applies to the database: one `DISTINCT ON` query returns the latest reading of every vehicle, which is a correctness property before a performance one, since seventy separate reads could return rows from seventy different moments and present the result as one snapshot. Verified: `fleet_size` and `fleet_running` share one Fleet Overview read, and two CAN aggregates share one population read.

- The `count` comparison, and a fourth age state (Milestone 5E-1 discovery). Fleet Overview publishes no "as of" timestamp and `capturedAt` may not stand in for one, so a dashboard count has a `reportedAt` and permanently no `measuredAt`. Under the 5D tri-state that made `fleet_size` report "unknown" and therefore RESOLVED, while its two sources differed by 250 vehicles. The tri-state was calibrated for a TRANSIENT artefact — an unreadable Last Talk Time cell, where escalating would let a rendering glitch dispute the whole fleet — and a count's missing time is structural instead. So `ValueComparison` gained `count`, whose age model is NOT APPLICABLE rather than unknown, `AgeExplanation` gained `not_applicable`, which is disputed, and `ComparisonSpec` became a discriminated union so a count cannot declare a `plausibleChangePerHour` nobody could calibrate. Scalar and distance semantics are untouched, verified: a scalar with no measurement times still reports "unknown" and still resolves.

- The fleet size genuinely disagrees, and saying so is the point (Milestone 5E). `postgres:vehicles` holds the 70 vehicles the manual telemetry import registered; the dashboard's All Vehicles card reads 320. Neither is faulty — they count different sets — so the result is DISPUTED with both figures and the model is bound to give both rather than lead with one. Threshold is 0 vehicles, calibrated 2026-08-03: a count is exact, so there is no scatter to sit above and no noise floor to calibrate against, and any disagreement between two registries is worth naming. This quantity is also why every aggregate names its population: an aggregate over the database covers 70 vehicles rather than the account's 320, and without `fleet_size` that would be a fact the user had no way to discover.

- Fleet windows are modelled and refused; fleet coverage is reported (Milestone 5E). `MemberDerivation` fixes the shape of two-stage aggregation — collapse each member's window, then aggregate — so enabling it later is a planner change rather than a redesign of the answer, and it summarises member counts rather than nesting 320 full Derivations into the model's context. It is switched off in the planner, and the refusal is the reachable, tested behaviour: the CAN feed holds a mean of 1.13 rows per vehicle, so a per-vehicle trend across the fleet would return an insufficiency answer seventy times and aggregate nothing.

- A TOOL FAILURE IS NOT A FINDING, and three layers now enforce it (P1). A vehicle visibly present in the Intellicar dashboard was reported to the user as not existing. Two true sentences produced a false conclusion: the Portal Tool said "the vehicle_summary dashboard could not be read", and the Analysis Tool said "no vehicle is registered under the fleet identifier". Neither is a claim about the vehicle — the first describes a scrape, the second describes `postgres:vehicles`, which holds 70 of the account's 320 vehicles by the disputed-fleet-size decision above. The fix is layered because no single layer is sufficient: the MESSAGES now name what failed and what they are not evidence of, the ENGINE no longer refuses a portal-answerable question about a vehicle absent from the telemetry database, and SYSTEM_PROMPT 1.6.0 states that only the portal reporting it listed the fleet may license "does not exist". Two failures are not corroboration; they are two tools that could not answer.

- The resolver's readiness budget was measured, not chosen, and the portal is the slow part (P1). `npm run portal:discover` timed the dashboard shell arriving 12s, 14s and ~67s after `domcontentloaded` in three samples within one hour, against the 15s the Vehicle Summary resolver allowed — which is exactly why the same vehicle read correctly in one request and "did not exist" in the next. The map (`#pac-input`) and the empty table container render 1-2s after navigation in EVERY sample; the LeftPane, the header counts and the header search all arrive together tens of seconds later, because they share a dependency the map does not have: the account-wide fleet status over 320 vehicles. No selector choice avoids that call — the table this module reads is populated by the same data — so the answer is a budget sized from the worst observation (90s, ~1.3x) rather than a cleverer wait. `APP_READY_TIMEOUT_MS` is separate from `STEP_TIMEOUT_MS` because a cold SPA boot and a click on a running application are different scales of wait, and sharing one number was the defect.

- Readiness is a RACED LIST everywhere, including inside a resolver (P1). The resolver waited on one selector while the Portal Service raced three for the same element, so a single stale guess reported a working dashboard as unreachable. `waitForAnySelector` is now exported and shared by both, which is what keeps "wait for any of these" from being reimplemented slightly differently in each extractor. The Vehicle Summary list leads with the control the resolver is about to CLICK rather than the count it merely observes; `#pac-input` is deliberately excluded despite being the earliest signal, because returning at 1.1s to a page whose LeftPane does not exist is the same mistake as waiting on `.im-tableView` while it still holds "No Data".

- Retry belongs in the Portal Service, and it is an ALLOW-LIST (P1). Above the Tool Registry a retry costs an OpenRouter call per attempt, and the model is told not to retry a timed-out tool — so recovery placed there does not happen. Inside `fetchPortalModule` it costs nothing. Only `PORTAL_UNREACHABLE` and `MODULE_CHANGED` are retried. An ANSWER is not: `TARGET_NOT_FOUND`, `MODULE_UNAVAILABLE` and `TARGET_REQUIRED` would return identically, and verified behaviour is that a nonexistent identifier fails once and is reported. NO `SessionError` IS EVER RETRIED, and this is the important exclusion — every login attempt is a real sign-in against a customer's Intellicar account, and three consecutive failures latch authentication off for the life of the process. The retry is also DEADLINE-AWARE, which makes it self-limiting in the right direction: an attempt that exhausted the 90s boot budget was not unlucky and gets no second try, while one that failed fast does.

- Classified portal failures used to leave no log line at all (P1). `fetchPortalModule` rethrew `PortalError` and `SessionError` BEFORE its `log.warn`, so `TARGET_NOT_FOUND`, `MODULE_CHANGED`, `MODULE_UNAVAILABLE` and every session failure were invisible in the portal logger — only raw Playwright breakage was recorded. The warn now precedes the rethrow and carries `code`, `attempt` and `durationMs`, because "the vehicle was not listed" and "the dashboard never rendered" need different responses from whoever reads it. The success line carries `attempt` for the same reason: a read that succeeds only on the retry is the signal that the portal is degrading, and without it that looks identical to a healthy deployment.

- Subject resolution is now LIVE-AWARE, and it gates on the plan rather than the subject (P1). `resolveSubject` proved a vehicle existed in `postgres:vehicles` before anything was read — including before a live portal read that P1 had already ranked first for a "current" question. Since that registry holds 70 of 320 vehicles, a question the dashboard could answer was refused before the dashboard was asked. The gate is now scoped to what the plan needs: with NO live candidate an unknown vehicle still throws, because a windowed question over a vehicle with no history is a caller's mistake and must not come back as "no data"; with a live candidate it resolves, every historical candidate becomes an unavailable Observation through the existing insufficiency contract, and P5 substitutes the live reading and NAMES the substitution. Nothing about P1, P4, `sourceClass` or `Derivation` changes — this decides whether a run may PROCEED, not which source answers.

- `ContributingSource.coverage` was designed and then NOT added (Milestone 5E). It was meant for a fleet quantity answered by both an aggregated database source and a live counterpart, where two entries would otherwise read as rival measurements of one population when they are readings of two. No such quantity exists: fleet aggregates have no live counterpart, so they produce a single candidate and no `contributingSources` at all, and the only two-source fleet quantity is `fleet_size`, whose entries are counts rather than aggregates. Adding the field would have been a declaration nothing populates — the judgement already recorded for TARGET_AMBIGUOUS. Coverage instead travels in `source.method`, which is where the windowed path already puts `samples` and `readings`.

- The IoT database is a SECOND database, not a replacement, and it is not modelled in Prisma (IoT integration). Repointing `DATABASE_URL` was rejected outright: it holds `memory_entries`, which Tarang owns and writes, so repointing it would aim the migration history at a database another team owns. A second Prisma schema was rejected too. The two schemas are structurally incompatible — the IoT tables key on a bare `vehicleno` text column with no surrogate id and no foreign key, name their timestamp `time` rather than `recorded_at`, use `real`/`double precision` where ours use `Decimal`, and are partitioned — so modelling them would mean a second generated client for tables we may not migrate and whose DDL can change without our knowing. A `pg.Pool` behind a named-query catalogue costs one dependency we already had transitively and leaves their schema entirely theirs. The consequence accepted with it: two clients, two pools, and no join across the boundary. Nothing needs one.

- The Database Tool takes an INTENT, and that closes the raw-SQL question rather than answering it (IoT integration). §6 had allowed "typed query intent or read-only SQL", and a validator was the obvious implementation: reject anything not a single SELECT, ban the DDL and DML keywords, force a LIMIT. It was rejected because a validator's guarantee is only as complete as the list of attacks its author thought of, and it must be re-audited every time PostgreSQL grows syntax. An enum of named queries has no such surface: there is no string supplied by the model that becomes SQL, so a write is unrepresentable rather than filtered. The price is real and accepted — an un-anticipated question needs a code change, not a cleverer prompt — and it buys a second property that matters as much: every statement is written once, EXPLAINed once, and timed against the 20 s ceiling once, instead of being composed afresh by a model that cannot measure it.

- No fleet-scope query may touch a raw telemetry table, and the reason is VARIANCE rather than slowness (IoT integration). The first measurement of a fleet-wide `DISTINCT ON (vehicleno)` over `telemetry_battery` was a cancellation at 20,295 ms for a ONE-DAY window, which read as a simple "too slow". Re-measurement corrected that and made the case stronger: warm, the same query takes ~4.0 s at one day and ~9.3 s at seven; cold it times out at one day; and warm it times out again at thirty. It STRADDLES the ceiling, and which side it lands on depends on the buffer cache and the window — neither of which a caller controls. That is the failure mode this project has already paid for once, when a 15 s readiness budget met a portal rendering in 12 s, 14 s and ~67 s and the same vehicle was reported present and then absent; the rule adopted there, SIZE FROM THE WORST OBSERVATION, is what governs here. It is not fixable from our side: pg_partman stopped creating partitions at `p20260704`, so every current row is in `telemetry_*_default` and pruning contributes nothing, the sole index `(vehicleno, time DESC)` cannot serve a predicate naming only `time`, and the timeout belongs to a role we are a guest under. The answer is that `vehicle_state` already holds the result as 334 pre-materialised rows. So fleet questions read `vehicle_state` or `distance_rollup`, per-vehicle raw reads require a `vehicleNo` and a bounded window, and the catalogue contains no fleet intent mapping to a `telemetry_*` table — the boundary is unreachable rather than merely discouraged. A corollary for whoever tests this: asserting that the bad query TIMES OUT is asserting the database's cache state, not our design. The assertion that means something is that no such query exists in the catalogue.

- A third registry joined the fleet-size disagreement, and it does not settle it (IoT integration). The portal lists 320, the local Prisma import holds 70, and the IoT database holds 335. The DISPUTED `fleet_size` decision above is unchanged and now has three members rather than two; the IoT figure is not a tiebreak, because all three count different sets. What is new is an explicit PRECEDENCE — portal first for live questions it can answer, IoT database for IoT telemetry and for current questions the portal cannot serve, local Prisma never a source of truth for current telemetry — stated in the system prompt rather than left to the model. Three sources that disagree with no stated ordering is worse than two, because the model's tiebreak becomes whichever tool answered first.

- A QUANTITY'S MEANING can be fabricated even when its VALUE cannot (SYSTEM_PROMPT 1.8.0). Asked "are any vehicles showing over-temperature or cell-imbalance problems?", the model requested `fleet_pack_temperature` with a maximum aggregation, received a real temperature from a real tool, and reported it as a CELL IMBALANCE in a named vehicle — then supplied a threshold ("~20-30°C is typical for cell balance spreads") that came from nowhere, and recommended an inspection on the strength of it. The source row refutes the finding outright: 8 mV across 16 cells, `cell_over_deviation_occurence_count` 0, every BMS imbalance alarm 0, and the 47.15 °C is `cell_temperature_01` on a pack whose `no_of_temperature_sensors` is 1 — sensors 06-12 read -273.15, the placeholder for a disconnected probe. EVERY NUMBER IN THE ANSWER WAS REAL, which is exactly why the grounding contract did not catch it: rule 1 forbids stating a value no tool produced, and no such value was stated. The gap is that provenance says where a number came from and says nothing about what it MEANS. So 1.8.0 governs identity rather than provenance — a temperature is not imbalance, health or degradation; cell imbalance is a difference in cell VOLTAGE; a threshold you were not given is not one you know; a maximum is not an anomaly; an unanswerable question is not answered with a different metric; and no maintenance is recommended on a number with no threshold. As with 1.6.0, the prompt is the last line of defence and not the fix — the two structural changes below are.

- `cell_balance` and `cell_temp_spread` are WITHDRAWN from advertisement, not deleted (SYSTEM_PROMPT 1.8.0). Both are derived from the development CAN sample, both describe a condition nothing available can corroborate, and both sit one word away from a clinical claim about a battery — advertising a capability whose only source is a sample file is what made the answer above reachable. Withdrawal rather than deletion because the registry entries, providers and derivations are all sound and the data is what is missing: restoring them when a trustworthy feed exists is a one-line change to `WITHDRAWN_QUANTITIES` rather than a re-derivation. `QUANTITIES` is deliberately left whole, so nothing outside the analytics module — including memory's `preferred_metric` validation — changes behaviour. THE ADVERTISED SET MUST BE A SINGLE SOURCE, and this is the part worth remembering: the catalogue text and the Zod enum were repointed at it, but `DERIVABLE_QUANTITIES` was missed and went on advertising both metrics through the description's "Derivations work for: …" line. A withdrawal applied per render site is a withdrawal that leaks.

- A CAPABILITY GAP READS AS A ROUTING FAILURE, and the fix is the intent rather than the prompt (fleet communication window). Asked "how many assets communicated within the last three months?" the agent reached for the portal and reported it unavailable; asked the same about one month it called `fleet_current_state` and returned 200 current-state rows, which establishes nothing about a past window. Neither was a reasoning error. The catalogue had no intent for a historical communication window, `superRefine` rejected `windowDays` on every fleet intent except `distance_fleet`, and the description contained none of the words the question used — "communicated", "reporting", "active", "month". The model played the only moves on the board. The lesson generalises past this case: when a model routes badly, check whether the question was ASKABLE before treating it as a prompt problem, because a prompt cannot conjure a capability and a well-described absent intent is still absent. The fourteenth intent closes it, `windowDays` is required on it, and the description names the three wrong answers — current state, current offline status, and distance — by name.

- The loose index scan is what makes ONE fleet-scope raw-telemetry read safe (fleet communication window). The rule that no fleet question may touch a `telemetry_*` table was never about the table; it was about the ACCESS SHAPE. A predicate naming only `time` cannot use `(vehicleno, time DESC)` and full-scans the default partition — 20,273 ms, cancelled. Binding `vehicleno` per vehicle and seeking the index 335 times answers the same question in 406 ms at 30 days, and partition pruning starts working (`Subplans Removed: 19`) precisely because the leading column is bound. So the boundary is drawn at the shape rather than at the table, and the plan is asserted by `EXPLAIN` in the suite — `Nested Loop Semi Join`, two `Index Only Scan`s, no `Seq Scan` — because a future index change would silently turn a safe query into the forbidden one and only the plan would show it. The window is capped at 90 days rather than the usual 180, but the cap is a COST CEILING and not a safety guarantee — a 60-day window was cancelled at 20 s in one suite run while 90 days completed in 2.5 s in the same run, and all three finish in ~100 ms warm. Cost tracks cold-cache random I/O across 335 index seeks far more than window length, so no cap removes the risk; what does is classification, and a timeout is reported as one rather than guessed around. That is the SECOND time on this integration that a single measurement proved to be the wrong end of a wide distribution — the first was the fleet-scan timeout initially recorded as "always" — and the general lesson is to sample a query more than once before writing its cost into a bound.

- A count states its denominator and names its feed (fleet communication window). "313 assets communicated" is unfalsifiable; "313 of 335 registered assets reported GPS telemetry between 14 July and 13 August" can be checked, and it is what was actually measured. The result therefore carries numerator, denominator, complement, feed and the RESOLVED window — resolved, not requested, because a clamped window must not be reported as the one the caller asked for. The feed matters most: the count comes from `telemetry_gps` alone, so an asset reporting battery or CAN without GPS is invisible to it and the figure is a FLOOR rather than a total. Saying so is the same discipline as `soh_pct` suppression and the alerts vocabulary note — the payload states the limit of its own evidence rather than leaving the model to infer it.

- Verification of grounding behaviour is OFFLINE; prose is read by a human (IoT integration). `npm run iot:check` is the regression gate at 106 checks and never calls OpenRouter — it asserts structure: that a payload cannot carry a figure, that a schema rejects a metric, that a prompt contains a rule. Model PROSE is checked by reading two `/api/chat` responses. An automated matcher was tried twice and failed in both directions: under-matched on the first pass, reporting false PASSES on an answer that really did fabricate a cell-imbalance finding; over-matched on the second, reporting false FAILURES on correct refusals because "I can't identify any vehicle as over-temperature" contains the phrase it was scanning for. Regex cannot distinguish asserting a claim from denying one, so it is not the gate — the structural suppressions are, and they hold regardless of what the model says.

- `soh_pct` is present, populated, and deliberately not reported (IoT integration). 321 of 335 vehicles carry a non-null value and `count(distinct soh_pct)` is 1: every one reads exactly 100. That is a column with a default in it, not a measurement of battery health, and it is the most dangerous field in the schema precisely because it looks like the answer to the question users most want to ask. The reader replaces it with an explicit unavailability and a reason rather than passing it through, because a null the model cannot explain invites a guess while a stated reason does not. `alerts` gets the same treatment for the same reason: 297,156 rows that are 100% `alert_type = 'offline'` would otherwise let "the alerts table" be read as evidence about temperature, current or cell balance. Suppression happens in the reader, not the prompt — a prompt rule is advice, and this needs to be a property of the data that reaches the model.

- The unavailability SENTENCE is stated once per result; the NULL is stated once per row (IoT integration). Attaching both to every record cost 51,600 characters on a 200-vehicle read — 258 characters repeated 200 times, 34% of a 150,181-character payload — and alongside other tool results in the same turn it left the model no room to generate an answer at all: a fleet question returned empty. The repetition bought nothing, because the reason is a property of the COLUMN rather than of any vehicle, so one copy says exactly what two hundred said. What is genuinely per-row is `sohPct: null`, and it stays: a field that is present and null says "this was looked for and is not measured", where an absent field says nothing, and it costs thirteen characters. The general rule this records: a constant explanation belongs beside the rows, never inside them. `fleet_current_state` remains the most expensive intent at ~94k characters even after the fix, and `fleet_summary` answers a counting question for a fraction of it.

- Script Runner deferred to Level 2. Arbitrary LLM-generated code execution is the highest-risk, lowest-value tool at this stage and overlaps the Analysis Tool. It returns at Level 2 as a properly sandboxed capability (isolated process or ephemeral container).

- Playwright doubles as the PDF engine. page.pdf() on the already-managed Chromium avoids a second headless-browser dependency for reports.

- Inngest for background work. Durable execution, cron, retries and per-user concurrency control without standing up a queue — and it lives in the same repository behind one Route Handler.

- No custom workflow orchestrator. Every orchestration need on the horizon — reports, scheduled sync, email delivery, webhooks, long-running workflows, human approvals — is native Inngest capability. A bespoke engine would add a third orchestration plane alongside Inngest and Level-2 LangGraph; the /api/chat dispatch rule in Section 13 achieves the separation with zero new surface.

- Source attribution as a Level-1 convention. The envelope-plus-prompt-contract design (Section 6) makes every number traceable and blocks fabricated citations at the mechanism level; retrofitting attribution after tools exist is far costlier than building it in from the first tool.

- Plugin-style tool packaging deferred. Four tools do not justify a plugin framework; the Tool Registry already centralises capability definitions. The packaging question is revisited at Level 2 if the tool count grows.

- Prisma as the data layer. Schema-as-code, generated types shared by tools and services, and migration discipline from day one.

- Short-term context is derived from ENVELOPES, never from prose (Phase 4A). The alternative was to let the model re-read the previous turn's answer for the vehicle it mentioned, which is what it did before this phase — and it works only when the model happened to restate a 20-character identifier. Measured over four A/B trials on a transcript whose first answer did not restate it, the unresolved case called NO tool at all in half of them and stated a fabricated temperature with a fabricated provenance claim; with the context present the tool ran in all four. Deriving from `source.params` of calls that actually executed is the same construction that makes the Sources block impossible to fabricate, and it is why the context carries what a turn ASKED and never what it MEASURED: `envelope.data` is never read, so a measurement has no path into it. The trials are indicative rather than a measured rate — the model is non-deterministic and four is a small sample — and the fabrication itself is pre-existing behaviour under an unresolvable reference, which this phase reduces but does not fix.

- No new stream frame for the run context (Phase 4A). The obvious design emits the context to the browser as a frame. It was not needed: `tool_result` already carries the complete envelope, and the client already retains every one in `UiMessage.results`, so the browser could derive the context itself. The context therefore travels UP the wire in the request body and `ChatStreamFrame` gained no member — which keeps the forward-compatibility rule untested by this phase rather than exercised by it, and leaves every existing consumer byte-identical. A frame would have been the second home for data the protocol already delivers.

- The prompt became a FUNCTION so a singleton agent can carry per-run context (Phase 4A). The agent is built once per process, so a per-conversation value cannot be baked into it at construction; `createReactAgent` accepts `(state, config) => BaseMessageLike[]`, and the route passes the context through `configurable`. The function returns exactly the shape LangGraph builds for a string prompt, and the renderer returns SYSTEM_PROMPT unchanged when there is no context, so a run without one is byte-identical to a pre-4A run. This also keeps the context out of `state.messages`, where it would have been persisted into graph state and replayed as though the user had said it. Nothing between the route and that function reads the key: no tool, no service, no registry.

- A history WINDOW, never a summary (Phase 4B). Summarising dropped turns is the standard move and is rejected on grounding rather than cost: a summary is model prose, and prose re-read on a later turn is indistinguishable from a tool result, so a remembered "87%" would enter the next run's context as a fact with no envelope behind it. A window drops old turns and never restates them. Dropping them is only safe because Phase 4A moved the durable part of a turn — its subject — out of prose and into structured context derived from every envelope the conversation produced, not from the retained window.

- An over-long history is trimmed; an over-long message is refused (Phase 4B). The two failures are not the same failure. A long conversation is not a mistake and must never turn a good question into a 400, so the 20-message window trims silently and idempotently, in the client and again in the route. A 16,000-character message is a caller sending something this system will not answer, and truncating it would answer a question the user did not ask — the same judgement the insufficiency contract already makes when it reports a gap rather than substituting for one. Both ceilings are named constants rather than environment variables, for the reason TOOL_TIMEOUT_MS is: they are architectural budgets, not per-deployment knobs.

- Memory ownership is enforced by the TYPE SYSTEM, not by a code review rule (Phase 4E). Every memory function takes a branded `OwnerId` as its first parameter, and the only constructor lives in `principal.ts`, reached only after a sealed session cookie has been opened and found current. The properties that buys are worth more than the two lines it costs: there is no zero-argument "list all memory" to call by accident, `setMemory(req.body.userId, …)` does not compile because a `string` is not assignable to `OwnerId`, and a run with no principal cannot obtain one — so anonymous persistence is unreachable rather than merely forbidden. The `WHERE ownerId` on every query is the second lock, not the first.

- No feature flag for memory (Phase 4E). §14's earlier sketch put retrieval behind `MEMORY_ENABLED`. It was dropped once the shape was clear: with no rows the prompt block renders nothing and the prompt is byte-identical to Phase 4A's, and with no authenticated principal the query is never issued. AN EMPTY TABLE IS THE OFF SWITCH. Adding a variable that duplicates a state the data already expresses would be the "meaningless flag" this section already refused for the reserved `artifact` frame — one more thing to set, to forget, and to disagree with reality.

- A memory write is an HTTP route, never a tool (Phase 4E). The alternative — a fifth tool letting the model save what it inferred — was rejected twice over: it breaks §6's four-tool ceiling, and it would hand prompt injection a write primitive aimed at the one store that is read back into a future prompt. With writes confined to `/api/memory` on an authenticated request, and no prompt text describing that route, an injected model has no memory write path AT ALL. That is the same argument this section already makes for why authentication is an internal service and never a tool, and it is why memory poisoning is closed by construction rather than by validation.

- Memory value schemas are `.strict()` (Phase 4E). Zod strips unknown keys by default, which is safe — the extra field never reaches a row — but it answers 200 to a request that tried to store something this system does not keep. `{ vehicleNo: "TK-1", soh: 87.5 }` succeeding while silently discarding the reading teaches a caller the wrong thing about what memory is for. Strict mode refuses it instead: a measurement is not merely ignored here, it is rejected.

- The memory BOUNDARY ships before the memory CODE (Phase 4C). Phase 4C adds `MEMORY_ZONE` to eslint.config.mjs and nothing else — no model, no migration, no service, no flag, no directory. A rule whose `files` pattern matches nothing is unusual, and it is the point: this is the one part of the memory design that can be enforced BEFORE the code it constrains exists, so the first line of that code is written against a boundary that already refuses the wrong dependencies rather than one added afterwards, once something has already crossed it. It also costs nothing and can break nothing, which is why it is safe to land years ahead of its subject. The alternative considered was shipping the schema and service behind `MEMORY_ENABLED=false`; it was rejected on this section's own precedent — "a declaration that nothing can reach is not a head start, it is a claim the code does not honour", the judgement already recorded for the reserved `artifact` frame. A dormant table is that claim in the database: a migration to maintain, a flag to remember, and an unreachable path that a later reader may wire up without ever learning why it was dormant. `MEMORY_ENABLED` remains the right ROLLOUT control, in the phase that actually ships memory, rather than a substitute for the identity that is missing.

- An unverifiable identifier is not an owner (Phase 4C). The tempting shortcut is a `localStorage` UUID: it gives every browser a stable id, it needs no login, and memory could ship this week. It is refused because the client SENDS it, so it is an unauthenticated bearer that anyone can copy or forge — `where: { ownerId }` built on it would look like isolation and enforce nothing, which is worse than no memory, because the next reader will believe the boundary is real. `requestId` is not a candidate either: it is minted per request. The consequence is accepted deliberately — memory waits for authentication rather than shipping on a fiction — and it avoids a second trap, because rows written under a browser id would later have to be either claimed by whoever first signs in from that browser (a cross-user leak by construction) or discarded (in which case the feature never worked).

- ~~Long-term memory is deferred until application authentication exists.~~ **RESOLVED at Phase 4E.** The blocker was never effort, it was identity: an owner the server cannot verify is a query parameter rather than an owner, and rows written under a browser id would later have to be either claimed by whoever first signed in from that browser (a cross-user leak by construction) or discarded (in which case the feature never worked). Phase 4D supplied a verified principal — not via Clerk, which was rejected, but via a self-hosted sealed-cookie session (§10) — and Phase 4E then built `MemoryEntry` on top of it with no further identity work. The sequencing is what made the memory slice small: by the time it was written, `OwnerId` already existed and was already unforgeable.

- Long-lived process as a deployment constraint. The browser singleton, session reuse and streaming all assume a persistent Node.js process; Docker (or PM2) keeps that guarantee explicit.

## 20. Future Roadmap

- LangGraph JS multi-agent workflows for more complex reasoning (Level 2).

- Sandboxed Script Runner: LLM-generated analysis executed in an isolated process or ephemeral container with strict time and memory limits.

- Expanded scheduled synchronisation and telemetry cache warming via Inngest, reducing live-scrape latency.

- Multi-tenant support: per-tenant credential vault entries, sessions and memory, plus key management via a KMS.

- Cloud deployment at scale: shared session store, horizontal scaling of the web tier, and a dedicated browser-worker pool.

- Evaluation harness on LangSmith: curated question datasets and regression scoring for every prompt or tool change.
