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
| Analysis Tool | Analytics module (TS) | Rows / JSON from other tools              | Computed metrics: degradation trends, cycle counts, utilisation |
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

The Portal Service covers the same seven Intellicar modules as v2.0 — Fleet Overview, Battery Analytics, Fleet Activity, Health & Analytics, Alerts & Rules, Device Management and Database Health — each implemented as its own extractor module under src/services/portal/extractors. On failure the run is retried once, a screenshot is captured for diagnostics, and a crashed browser is relaunched automatically.

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
| LANGSMITH_API_KEY, LANGSMITH_TRACING                | Tracing configuration                                                |
| CREDENTIAL_ENCRYPTION_KEY                           | AES-256-GCM key for the credential vault (rotatable via key version) |
| CLERK_SECRET_KEY, NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY | Application authentication                                           |
| INNGEST_EVENT_KEY, INNGEST_SIGNING_KEY              | Background job delivery and verification                             |
| INTELLICAR_BASE_URL                                 | Portal entry point                                                   |
| SESSION_STORE_DIR                                   | Encrypted storageState location                                      |
| LOG_LEVEL                                           | Pino log verbosity                                                   |

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

│ │ │ └── normalizers.ts

│ │ ├── session/

│ │ │ ├── session-manager.ts

│ │ │ └── playwright-manager.ts

│ │ ├── credentials/

│ │ │ ├── credential-manager.ts

│ │ │ └── crypto.ts \# AES-256-GCM helpers

│ │ ├── database/

│ │ │ └── telemetry.service.ts

│ │ ├── analytics/

│ │ │ └── battery-metrics.ts \# Degradation, cycles, utilisation

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
| Analytics                            | src/services/analytics/              |
| Report Service                       | src/services/reports/                |
| Background jobs                      | src/jobs/ + app/api/inngest/route.ts |

## 19. Design Decisions

- Single runtime, single repository. One endpoint did not justify a second service; removing FastAPI eliminates the HTTP contract, CORS, duplicated configuration and a second deployment pipeline, and lets types flow from database to UI.

- Service layer over fat Route Handlers. Handlers authenticate, validate and stream; capabilities live in services with typed interfaces. This keeps the agent testable and the blast radius of any change small.

- LangChain JS retained as the AI framework. It preserves the LangSmith tracing investment, keeps tool abstractions familiar from the v2.0 design, and its LangGraph runtime is the direct upgrade path for Level-2 multi-agent workflows.

- Agent isolated from authentication and browsers. Credentials, cookies and storageState are handled by dedicated services the agent cannot reach; a misbehaving or prompt-injected agent cannot leak what it never sees.

- Clerk for application authentication. Fastest production-grade path in the App Router (middleware, prebuilt components, organisation support) with a free tier that comfortably covers an internal team. Auth.js remains the documented alternative if a zero-external-dependency, fully self-hosted setup becomes a requirement — the boundary is one middleware file.

- SQL-first analytics in TypeScript replaces Pandas. Battery analytics at Level 1 — degradation trends, cycle counts, utilisation — is aggregation, which PostgreSQL does natively; TypeScript finishes the last mile. A Python analytics worker is deliberately deferred until a genuinely statistical workload appears.

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
