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
| Authentication      | Clerk                                    | Application user authentication (Auth.js documented as the self-hosted alternative) |
| Background jobs     | Inngest                                  | Scheduled sync, session refresh, retries                                            |
| Reports             | Markdown + PDF (rendered via Playwright) | Business output                                                                     |
| Observability       | LangSmith                                | Agent tracing and monitoring                                                        |
| Logging             | Pino                                     | Structured application logs with secret redaction                                   |
| Configuration       | Environment variables (Zod-validated)    | Twelve-factor configuration, fail-fast at boot                                      |
| Deployment          | Docker                                   | Single long-lived container; PM2-compatible on a VPS                                |

## 3. High-Level Architecture

<img src="media/d61e5b4d946bfab8f9d292066c79b9cc0fbb1376.png" style="width:5.83333in;height:3.22917in" />

*Figure 1 — Request path through the single Next.js application to external systems*

A user's question enters the React 19 chat interface, passes Clerk's authentication middleware, and posts to the /api/chat Route Handler. The handler runs on the Node.js runtime and streams tokens back to the browser while the LangChain JS agent works. The agent reasons over the request, selects tools from the Tool Registry, and delegates every real-world side effect — scraping, database reads, report generation — to the service layer. Playwright reaches Intellicar, Prisma reaches PostgreSQL, every agent run is traced to LangSmith, and Inngest executes scheduled and background work through the same codebase. Everything ships as one long-lived Node.js process.

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
| Database Service   | Typed telemetry queries plus a guarded read-only SQL path; the Prisma access layer.                                                                                  |
| Analysis Engine    | Deterministic reasoning over grounded sources: plans what to acquire, deduplicates the reads, reconciles live against historical by declared precedence, computes metrics, and assembles findings that carry their own provenance. Calls no LLM. |
| Memory Manager     | Short-term conversation state and long-term user preferences; enforces the memory storage exclusions in Section 7.                                                   |
| Report Service     | Markdown assembly, PDF rendering, report persistence and download links.                                                                                             |

## 5. AI Agent Architecture

<img src="media/cf08afc490b4f2d26c9bfa3f2a01090df73f5748.png" style="width:5.83333in;height:2.61458in" />

*Figure 3 — Agent internal flow: reason, select a tool, execute, observe, respond*

Tarang remains a single agent. It is built with LangChain JS using the modern tool-calling executor (the prebuilt ReAct-style agent from @langchain/langgraph/prebuilt), which gives a bounded reason–act–observe loop today and a clean upgrade path to full LangGraph multi-agent workflows at Level 2.

The agent is responsible for:

- Prompt management — versioned system and tool prompts kept in src/agent/prompts.ts.

- Conversation memory — loaded and persisted through the Memory Manager (Section 7).

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
| Database Tool | Database Service      | Typed query intent or read-only SQL       | Rows of historical telemetry                                    |
| Analysis Tool | Analysis Engine (src/services/analytics/) | Subject + quantities (+ window, from 5C)  | Findings, each carrying the source that answered it |
| Report Tool   | Report Service        | Results + report template                 | Markdown / PDF report with download link                        |

The Tool Registry (src/agent/tool-registry.ts) is the single catalogue of capabilities. Each entry pairs a Zod input schema, a description the LLM reasons over, and the service call it wraps. Adding a capability at Level 2 means adding a service, a thin tool adapter and one registry entry — the agent core does not change.

Note: the v2.0 Script Runner tool (LLM-generated Python executed in a container) is intentionally deferred to Level 2 as a sandboxed capability. Its analytical duties are covered by the SQL-first Database Tool and the TypeScript Analysis Tool; the rationale is recorded in Section 19.

### Grounding & Source Attribution

Tarang is a data analyst: every number it reports must be traceable to where it came from. Attribution is implemented as a cross-cutting convention, not a separate service:

- Result envelope — the Tool Registry wrapper returns every tool result as { data, source: { tool, origin, params, timestamp } }. Attribution therefore exists for every capability automatically; individual tools cannot forget it.

- Method metadata — the Analysis Tool includes how each metric was computed in its envelope (for example the analysis window: 'last 90 charging cycles').

- Prompt contract — the system prompt requires the agent to attach sources to numeric claims, and the response composer renders a Sources block beneath the answer.

- Grounded, never asserted — the Sources block is derived from the envelopes of tool calls that actually executed in the run, never from the model's own claims. An LLM asked to cite without grounding will fabricate citations; the envelope makes citation mechanical.

- Two audiences — LangSmith traces remain the full internal lineage for developers; the user-facing Sources block is the distilled view of the same run.

Example response shape: 'Battery Health: 87% — Sources: Intellicar Battery Analytics (live), Historical Telemetry (PostgreSQL), calculated over the last 90 charging cycles.'

This enforces the project's computed-only rule: metrics originate from tool output; the LLM narrates and formats, but never invents a number.

## 7. Memory Architecture

The Memory Manager separates two kinds of memory with different lifetimes, storage and rules.

### Short-term memory (per conversation)

| **Holds**                         | **Storage**                                              |
|-----------------------------------|----------------------------------------------------------|
| Current conversation turns        | Conversation / Message tables, loaded per thread         |
| Reasoning state of the active run | In-process during the agent loop                         |
| Intermediate tool outputs         | In-process; large payloads truncated before re-prompting |
| Temporary execution context       | In-process; discarded when the run completes             |

### Long-term memory (per user)

| **Holds**                                     | **Storage**                                       |
|-----------------------------------------------|---------------------------------------------------|
| Preferred fleet and preferred dashboard       | UserMemory table, injected into the system prompt |
| User preferences (units, report format, tone) | UserMemory / UserSettings tables                  |
| Previous reports (index and summaries)        | Report table metadata                             |
| Frequently asked questions                    | UserMemory table                                  |
| Business context supplied by the user         | UserMemory table                                  |

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

Tarang deliberately separates two unrelated concerns. Clerk answers 'who may use Tarang' — it protects the chat UI, Route Handlers and Server Actions via middleware, and its user ID keys all per-user data. The Credential Manager and Session Manager answer 'how Tarang reaches Intellicar'. The two never mix: Clerk knows nothing about Intellicar, and Intellicar credentials never touch the app-authentication layer.

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

PostgreSQL, accessed exclusively through Prisma, is the system of record for everything except secrets-in-plaintext. A singleton PrismaClient (globalThis pattern) serves the whole process; schema changes ship as Prisma migrations.

| **Model**              | **Purpose**                                                                               |
|------------------------|-------------------------------------------------------------------------------------------|
| User / UserSettings    | Application users (linked to the Clerk user ID) and their preferences                     |
| CredentialVault        | Encrypted Intellicar credentials: ciphertext, IV, auth tag, key version — never plaintext |
| PortalSession          | Session metadata only: status, last validated time, storage reference — never raw cookies |
| Vehicle                | Vehicle / device dimension; the shared join key for all three telemetry tables            |
| BatteryTelemetry       | Historical battery telemetry, typed to the Battery dataset                                |
| GpsTelemetry           | Historical position and movement telemetry, typed to the GPS dataset                      |
| CanTelemetry           | Historical CAN bus telemetry, typed to the CAN dataset                                    |
| Conversation / Message | Chat threads; the persistence layer for short-term memory                                 |
| UserMemory             | Long-term memory entries: preferred fleet, dashboard, FAQs, business context              |
| Report                 | Generated report metadata and file references                                             |
| AuditLog               | Security-relevant events: credential and session operations, logins, report access        |

Telemetry is modelled as three dataset-shaped tables rather than one generic reading table. The Battery, GPS and CAN datasets carry genuinely different columns, and a single wide table would be mostly nulls and would hide unit and precision differences behind a shared column name. They join through the Vehicle dimension on (vehicleId, recordedAt). Telemetry is loaded manually from files (see docs/DATA-IMPORT.md); there is no seed script.

Prisma 7 note: the client has no built-in database driver — a WASM query compiler builds query plans and a driver adapter (@prisma/adapter-pg) executes them. The adapter is constructed from the same DATABASE_URL and is confined to src/lib/prisma.ts; nothing else in the system observes it.

Two rules are absolute: raw credentials and browser cookies never enter the database, and the agent's raw-SQL escape hatch is SELECT-only, executed under a read-only database role.

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

- Downloads are served through /api/reports/\[id\] (Clerk-protected); chat replies link the artifact.

## 15. End-to-End Workflow

| **\#** | **Step**                                                                                                                               |
|--------|----------------------------------------------------------------------------------------------------------------------------------------|
| 1      | A Clerk-authenticated user asks a question in natural language in the chat UI                                                          |
| 2      | /api/chat (Node runtime, streaming) validates the request and invokes the agent                                                        |
| 3      | The Memory Manager loads the conversation thread and long-term user context                                                            |
| 4      | The agent reasons about what the question needs and selects tools via the Tool Registry                                                |
| 5      | Portal Tool → Portal Service → Session Manager ensures a valid session (silent login if needed) → Playwright scrapes the target module |
| 6      | Database Tool supplies historical telemetry through Prisma                                                                             |
| 7      | Analysis Tool computes metrics in TypeScript over the gathered data                                                                    |
| 8      | Report Tool renders Markdown / PDF when a document is requested                                                                        |
| 9      | The agent composes the answer and its Sources block; tokens stream to the UI; the full run is traced in LangSmith                      |
| 10     | The Memory Manager persists messages and learned preferences; audit and log entries are written                                        |

## 16. Observability, Logging & Configuration

### LangSmith

Every agent run is traced end to end: prompts, tool spans with inputs and outputs, latencies and token usage. Traces are the primary debugging surface for agent behaviour and the foundation for evaluation datasets at Level 2.

### Pino

Structured JSON logging with request IDs and per-service child loggers. Redaction paths cover credentials, cookies, storageState and authorization headers, so secrets cannot leak through logs even by accident. Log level is environment-controlled.

### Configuration

All configuration comes from environment variables, validated by a Zod schema in src/lib/env.ts at boot — a missing or malformed variable fails the process immediately instead of failing a request later.

| **Variable**                                        | **Purpose**                                                          |
|-----------------------------------------------------|----------------------------------------------------------------------|
| DATABASE_URL                                        | PostgreSQL connection string (Prisma)                                |
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

The Intellicar variables in this table are validated lazily, on first authentication use, rather than at boot — see §19 (Milestone 3) for why.

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

│ │ ├── tool-registry.ts \# Zod-typed tool catalogue

│ │ └── memory/

│ │ ├── short-term.ts

│ │ └── long-term.ts

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

│ │ │ ├── telemetry.service.ts \# Prisma access layer

│ │ │ ├── telemetry.records.ts \# JSON-safe shapes + conversions; no I/O

│ │ │ └── telemetry.reader.ts \# Typed reads returning those records

│ │ ├── analytics/ \# Analysis Engine (Milestone 5B)

│ │ │ ├── analysis-engine.ts \# Public entry; orchestrates the six stages

│ │ │ ├── planner.ts \# Stage 1 — request → requirements (pure)

│ │ │ ├── quantity-registry.ts \# Stage 2 — quantity ↔ provider vocabulary

│ │ │ ├── acquisition.ts \# Stage 3 — the only impure stage; deduplicated

│ │ │ ├── projections.ts \# Reading → measured quantity (pure)

│ │ │ ├── reconcile.ts \# Stage 4 — source precedence P0-P7 (pure)

│ │ │ ├── observations.ts \# The universal data model (types only)

│ │ │ ├── battery-metrics.ts \# Stage 5 — trends, cycles, utilisation (5C)

│ │ │ └── fixtures/ \# Captured records; pure stages testable offline

│ │ └── reports/

│ │ ├── report.service.ts

│ │ └── templates/

│ ├── jobs/ \# Inngest functions

│ │ ├── client.ts

│ │ ├── sync-dashboards.ts

│ │ └── session-refresh.ts

│ ├── lib/

│ │ ├── prisma.ts \# Singleton client

│ │ ├── logger.ts \# Pino + redaction

│ │ ├── env.ts \# Zod-validated environment

│ │ └── langsmith.ts

│ └── types/

├── prisma/

│ ├── schema.prisma

│ └── migrations/

├── reports/ \# Generated output (volume)

├── middleware.ts \# Clerk auth middleware

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
| Memory Manager                       | src/agent/memory/                    |
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

- Clerk for application authentication. Fastest production-grade path in the App Router (middleware, prebuilt components, organisation support) with a free tier that comfortably covers an internal team. Auth.js remains the documented alternative if a zero-external-dependency, fully self-hosted setup becomes a requirement — the boundary is one middleware file.

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

- Script Runner deferred to Level 2. Arbitrary LLM-generated code execution is the highest-risk, lowest-value tool at this stage and overlaps the Analysis Tool. It returns at Level 2 as a properly sandboxed capability (isolated process or ephemeral container).

- Playwright doubles as the PDF engine. page.pdf() on the already-managed Chromium avoids a second headless-browser dependency for reports.

- Inngest for background work. Durable execution, cron, retries and per-user concurrency control without standing up a queue — and it lives in the same repository behind one Route Handler.

- No custom workflow orchestrator. Every orchestration need on the horizon — reports, scheduled sync, email delivery, webhooks, long-running workflows, human approvals — is native Inngest capability. A bespoke engine would add a third orchestration plane alongside Inngest and Level-2 LangGraph; the /api/chat dispatch rule in Section 13 achieves the separation with zero new surface.

- Source attribution as a Level-1 convention. The envelope-plus-prompt-contract design (Section 6) makes every number traceable and blocks fabricated citations at the mechanism level; retrofitting attribution after tools exist is far costlier than building it in from the first tool.

- Plugin-style tool packaging deferred. Four tools do not justify a plugin framework; the Tool Registry already centralises capability definitions. The packaging question is revisited at Level 2 if the tool count grows.

- Prisma as the data layer. Schema-as-code, generated types shared by tools and services, and migration discipline from day one.

- Long-lived process as a deployment constraint. The browser singleton, session reuse and streaming all assume a persistent Node.js process; Docker (or PM2) keeps that guarantee explicit.

## 20. Future Roadmap

- LangGraph JS multi-agent workflows for more complex reasoning (Level 2).

- Sandboxed Script Runner: LLM-generated analysis executed in an isolated process or ephemeral container with strict time and memory limits.

- Expanded scheduled synchronisation and telemetry cache warming via Inngest, reducing live-scrape latency.

- Multi-tenant support: per-tenant credential vault entries, sessions and memory, plus key management via a KMS.

- Cloud deployment at scale: shared session store, horizontal scaling of the web tier, and a dedicated browser-worker pool.

- Evaluation harness on LangSmith: curated question datasets and regression scoring for every prompt or tool change.
