# Tarang — Level 1 AI Data Analyst Agent

Single Next.js app (App Router) — one repo, one Node.js runtime. Full architecture: docs/ARCHITECTURE.md (SAD v3.1). Read the relevant section before large changes; never re-derive decisions already made there.

## Stack
Next.js 16 + React 19 · TypeScript · LangChain JS (prebuilt agent from @langchain/langgraph) · OpenAI/OpenRouter · Playwright (Node) · Prisma + PostgreSQL · Zod · Clerk · Inngest · Pino · LangSmith

## Commands
- `npm run dev` — run locally
- `npm run build && npm start` — production build
- `npm run lint` — ESLint
- `npx prisma migrate dev` — DB migrations (once Prisma is wired)
- `npx prisma studio` — inspect the DB

## Hard rules — never violate
1. The agent NEVER touches credentials, cookies, tokens, or Playwright storageState. Only `src/services/credentials/` and `src/services/session/` may.
2. Every tool result is wrapped by the Tool Registry in the source envelope `{ data, source: { tool, origin, params, timestamp } }`. Numeric claims in answers must cite envelope sources from tool calls that actually ran — never invented ones.
3. `/api/chat` runs ONLY the interactive agent loop. Everything else (reports, scheduled sync, email, approvals) is emitted as an Inngest event.
4. The Playwright browser and PrismaClient are `globalThis` singletons.
5. The agent's raw SQL path is SELECT-only, executed under the read-only DB role.
6. Exactly 4 tools at Level 1: portal, database, analysis, report. No new tools or speculative folders without updating docs/ARCHITECTURE.md first.

## Conventions
- Route Handlers stay thin: auth → Zod validation → service call → stream. Logic lives in `src/services/<name>/`.
- Tools in `src/tools/` are thin adapters over services — no scraping, SQL, or rendering inside a tool.
- Secrets come only from env, validated in `src/lib/env.ts`. Never log secrets; Pino redaction paths cover credentials, cookies, storageState, authorization headers.
- Prefer editing existing files over creating new ones; keep the project tree matching docs/ARCHITECTURE.md Section 18, with one deliberate deviation: the App Router lives at `src/app/`, not the root `app/` shown in Section 18. Everything else under `src/` matches. Route Handlers therefore live at `src/app/api/<name>/route.ts`.
