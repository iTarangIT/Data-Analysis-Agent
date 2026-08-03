# Tarang — Level 1 AI Data Analyst Agent

Single Next.js app (App Router) — one repo, one Node.js runtime. Full architecture: docs/ARCHITECTURE.md (SAD v3.1). Read the relevant section before large changes; never re-derive decisions already made there.

## Stack
Next.js 16 + React 19 · TypeScript · LangChain JS (prebuilt agent from @langchain/langgraph) · OpenAI/OpenRouter · Playwright (Node) · Prisma + PostgreSQL · Zod · Clerk · Inngest · Pino · LangSmith

## Commands
- `npm run dev` — run locally
- `npm run build && npm start` — production build
- `npm run lint` — ESLint
- `npm run db:migrate` — create/apply a migration · `db:status`, `db:deploy`, `db:generate`
- `npm run db:studio` — inspect the DB
- `npm run auth:login` — verify Intellicar authentication end to end
- `npm run portal:fetch [module]` — read a live dashboard module through the Portal Service (defaults to `fleet_overview`)

## Hard rules — never violate
1. The agent NEVER touches credentials, cookies, tokens, or Playwright storageState. Only `src/services/credentials/` and `src/services/session/` may. Authentication is never agent-callable at any level — no tool, no registry entry, no prompt text. A service asks `withAuthenticatedContext()` for a context; a tool never does. Enforced in both directions by the import zones in `eslint.config.mjs`.
2. Every tool result is wrapped by the Tool Registry in the source envelope `{ data, source: { tool, origin, params, timestamp } }`. Numeric claims in answers must cite envelope sources from tool calls that actually ran — never invented ones.
3. `/api/chat` runs ONLY the interactive agent loop. Everything else (reports, scheduled sync, email, approvals) is emitted as an Inngest event.
4. The Playwright browser and PrismaClient are `globalThis` singletons.
5. The agent's raw SQL path is SELECT-only, executed under the read-only DB role.
6. Exactly 4 tools at Level 1: portal, database, analysis, report. No new tools or speculative folders without updating docs/ARCHITECTURE.md first.

## Conventions
- Route Handlers stay thin: auth → Zod validation → service call → stream. Logic lives in `src/services/<name>/`.
- Tools in `src/tools/` are thin adapters over services — no scraping, SQL, or rendering inside a tool.
- Prisma: schema at `prisma/schema.prisma`, CLI config at `prisma.config.ts` (loads `.env.local` — `DATABASE_URL` has exactly one home, never a committed default). Generated client at `src/generated/prisma`, gitignored and rebuilt by `postinstall`. Telemetry is imported manually — no seed script (docs/DATA-IMPORT.md).
- Secrets come only from env, validated in `src/lib/env.ts` — eagerly for application config, lazily via `authEnv()` for the Intellicar domain, so the telemetry path never depends on portal configuration. Never log secrets; Pino redaction in `src/lib/logger.ts` covers credentials, cookies, storageState and authorization headers. Redaction matches field *paths*, not free text, so never interpolate a secret into a message.
- Intellicar authentication (docs/AUTH-SETUP.md): the Session Manager owns authentication and `session-manager.ts` is its only public entry point; every URL and selector of the LOGIN FLOW lives in the one `INTELLICAR` constants block in `authenticator.ts`, where `TODO(intellicar)` marks values still unverified against the live portal.
- Live dashboard extraction is owned by the Portal Service, and each dashboard module's path and selectors live with that module in `src/services/portal/extractors/` — never in `authenticator.ts`, which knows only how to sign in. `portal.service.ts` is the only caller of `withAuthenticatedContext()`; extractors only read a page they are handed, `normalizers.ts` is pure and never imports Playwright, and Zod validates every normalized result. Enforced by the Portal zone in `eslint.config.mjs`.
- The portal is a client-rendered SPA: its data arrives well after `domcontentloaded`, and `networkidle` never settles. A capability declares readiness selectors targeting a *data-bearing* element; the Portal Service navigates and waits, extractors never do either. Capture a raw extraction into `src/services/portal/fixtures/` when adding a module, so its normalizer stays runnable without a portal.
- A module that reports one entity is a TARGETED capability (`targeted: true`, Milestone 4C): the portal exposes no per-vehicle route, so it declares `resolve()` — an in-page phase the Portal Service runs between navigation and readiness — and `assertIdentity()`, which the compiler requires alongside it. Extractors stay read-only; the rule they obey is NEVER MUTATE, so navigating a view or paging a table is allowed, while submitting a form, saving a setting or issuing a device command is not.
- Prefer editing existing files over creating new ones; keep the project tree matching docs/ARCHITECTURE.md Section 18, with one deliberate deviation: the App Router lives at `src/app/`, not the root `app/` shown in Section 18. Everything else under `src/` matches. Route Handlers therefore live at `src/app/api/<name>/route.ts`.
