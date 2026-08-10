# Deployment — Docker & Railway

Tarang deploys as **one long-lived Node.js container**, exactly as SAD §17
requires. This document is the runbook for that deployment: what to create,
in what order, and how to prove it worked.

Nothing here changes application behaviour. The deployment artifacts are
additive — no file under `src/` was modified to make this work.

---

## 1. Why this shape, in one paragraph

The singleton Chromium (`src/services/session/playwright-manager.ts`), the
reusable encrypted Intellicar session (`session-store.ts`), the serialisation
queue and rejected-credential latch (`session-manager.ts`) and the streaming
`/api/chat` response all assume a process that outlives individual requests and
of which there is exactly one. That is why serverless is out of scope (SAD §17)
and why this runs as a single replica with a persistent volume.

Railway happens to enforce the single-replica part for us: **a service with a
volume attached cannot be scaled beyond one replica.** The platform constraint
and the architecture's requirement coincide.

---

## 2. Deployment artifacts

| File | Purpose |
|---|---|
| `Dockerfile` | Four-stage production build on the version-matched Playwright base image. |
| `.dockerignore` | Keeps `.env*` and `.sessions/` out of image layers; trims an 865 MB `node_modules` and 214 MB `.next` from the build context. |
| `docker-entrypoint.sh` | Prepares the volume as root, proves it is writable by the app user, drops privileges, execs the server. |
| `railway.json` | Pins `numReplicas: 1`, the Dockerfile builder and the `/` health check in version control. |
| `docker-compose.yml` | Local parity for testing the volume + privilege-drop sequence before deploying. |
| `docs/DEPLOYMENT.md` | This runbook. |

---

## 3. Environment variables

### Build time

The build needs **three** variables, and the `Dockerfile` supplies them as
**hardcoded non-secret placeholders**. You do not configure these anywhere.

`src/lib/env.ts` evaluates `loadEnv()` at module scope (`export const env =
loadEnv()`), and `next build` imports the route handlers, so `DATABASE_URL`,
`OPENROUTER_API_KEY` and `OPENROUTER_MODEL` must *parse* during the build. Only
their shape is checked. Real values would end up readable in an image layer via
`docker history`, which is why placeholders are used instead of build args.

**No Intellicar variable is needed at build time.** `authEnv()` validates them
lazily on first authentication use — a deliberate split so the telemetry path
never depends on portal configuration, and it means no portal credential ever
touches a build stage.

### Runtime — set these on the Railway service

| Variable | Value | Secret | Notes |
|---|---|---|---|
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | ✅ | Use Railway's **private** networking reference, not the public URL. |
| `OPENROUTER_API_KEY` | your key | ✅ | |
| `OPENROUTER_MODEL` | e.g. `anthropic/claude-sonnet-4.5` | | |
| `OPENROUTER_APP_URL` | `https://<your-app>.up.railway.app` | | Sent as `HTTP-Referer` to OpenRouter. |
| `INTELLICAR_BASE_URL` | `https://track.intellicar.in` | | No trailing slash (the schema strips one anyway). |
| `INTELLICAR_EMAIL` | portal account | ✅ | |
| `INTELLICAR_PASSWORD` | portal password | ✅ | |
| `CREDENTIAL_ENCRYPTION_KEY` | `openssl rand -hex 32` | ✅ | 64 hex chars or base64 decoding to 32 bytes. **Changing it invalidates the stored session** (handled gracefully — see §7). |
| `SESSION_STORE_DIR` | `/data/sessions` | | Must be inside the volume mount. See §5. |
| `PLAYWRIGHT_HEADLESS` | `true` | | |
| `AUTH_TIMEOUT_MS` | `30000` | | Optional; this is the default. |
| `LOG_LEVEL` | `info` | | |
| `LANGSMITH_TRACING` | `false` | | Set `true` only if you accept that prompts, model outputs and tool results leave for an external service (SAD §16). |
| `LANGSMITH_API_KEY` | key | ✅ | **Required** if tracing is `true` — the app fails at boot otherwise, by design. |
| `LANGSMITH_PROJECT` | project name | | Optional. |

`PORT`, `NODE_ENV` and `HOSTNAME` are handled by Railway and the image. Do not
set them manually.

### Application authentication (Phase 4D) and long-term memory (Phase 4E)

These four are the **application identity** domain — "who may use Tarang". They
are not the Intellicar variables above, which answer "how Tarang reaches
Intellicar"; the two never mix, use different keys, and are validated by
different schemas (SAD §10).

**Long-term memory depends on all of them.** Memory is read only for an
authenticated principal, so with `APP_AUTH_ENABLED` unset the feature is inert
in production no matter what has shipped: `/api/memory` answers 401 to
everything and `/api/chat` performs no memory read at all.

| Variable | Value | Secret | Notes |
|---|---|---|---|
| `APP_AUTH_ENABLED` | `true` | | **Defaults to `false`.** Off means `/api/chat` is unauthenticated and open, `/api/memory` always answers 401, and the UI shows no Sign in or Logout control. |
| `APP_SESSION_KEY` | `openssl rand -hex 32` | ✅ | Seals the `tarang_session` cookie. **Deliberately NOT `CREDENTIAL_ENCRYPTION_KEY`** — different blast radius, different party protected. Rotating it invalidates every live session (users sign in again; nothing else breaks). |
| `APP_USERS` | `alice:scrypt.N.r.p.salt.hash;bob:…` | ✅ | `name:hash` records separated by `;`. Mint each one with `npm run app:user -- <name>` and paste the printed record. A plaintext password is rejected at parse time, never compared. |
| `APP_SESSION_TTL_HOURS` | `12` | | Optional; this is the default. Max 720. |

> **The hash separator is `.`, not `$`, and that is deliberate.** `.env` files
> interpolate and `@next/env` expands each `$…` segment to nothing, so a
> `$`-delimited record reaches the application gutted and **every sign-in fails
> as "invalid username or password"**. If you are debugging exactly that
> symptom, check this first. Do not "correct" the separator.

**Enabling authentication with a variable missing degrades rather than crashes:**
the schema refuses the configuration, `readSession()` swallows the error, and
every request is treated as unauthenticated — so the symptom is "nobody can sign
in", not a boot failure. Set all three of `APP_AUTH_ENABLED`, `APP_SESSION_KEY`
and `APP_USERS` together.

**`ownerId` is the `APP_USERS` name.** Memory rows survive a user being removed
from `APP_USERS`, so **never reuse a name**: a re-minted `alice` inherits the
previous `alice`'s stored preferences. See SAD §7, "Known limitation".

### Reverse geocoding (Phase 3) — every variable is optional

Location cards show a human-readable address above the coordinate. **Set nothing
and it works**: the whole schema is defaulted and validated lazily, so a missing
or malformed value degrades to the default and can never fail a boot, a build or
an answer. If the provider is unreachable the card shows the coordinate exactly
as it did before the feature existed.

| Variable | Value | Secret | Notes |
|---|---|---|---|
| `GEOCODING_ENABLED` | `true` | | Set `false` to switch the feature off entirely. Cards then show coordinates only. |
| `GEOCODING_BASE_URL` | `https://api.bigdatacloud.net` | | Provider origin. This is the default; override only to point at a different host. |
| `GEOCODING_API_KEY` | BigDataCloud key | ✅ | **Optional but recommended in production.** Absent → the keyless `/data/reverse-geocode-client` endpoint. Present → `/data/reverse-geocode`, the endpoint BigDataCloud designates for server-to-server use. Same response either way, so this changes one URL and nothing else. Free, no card. |
| `GEOCODING_CONTACT` | `ops@yourdomain` | | Embedded in the `User-Agent`. Not required by this provider; a contactable caller gets a warning rather than a block. |
| `GEOCODING_TIMEOUT_MS` | `4000` | | Ceiling for one provider call. Nothing waits on it — the report has already rendered. |
| `GEOCODING_MIN_INTERVAL_MS` | `250` | | Minimum gap between provider calls. |

> **Privacy.** Reverse geocoding sends vehicle positions to the configured
> endpoint. That is inherent to the feature, not to this provider.
> `GEOCODING_ENABLED=false` removes it.
>
> **Why not Nominatim.** OpenStreetMap's public instance returns
> `HTTP 403 Access denied` to data-centre IPs — measured, and the condition a
> Railway deployment meets. BigDataCloud was the only compared provider that
> answers a data-centre IP with no credential.

---

## 4. Railway setup, in order

### 4.1 Create the project and database

1. **New Project → Deploy from GitHub repo**, select this repository.
   Railway detects `railway.json` and `Dockerfile` automatically.
2. **New → Database → PostgreSQL** in the same project.

### 4.2 Create the volume — do this BEFORE the first successful deploy

On the **app service**: **Settings → Volumes → Add Volume**

| Setting | Value |
|---|---|
| Mount path | `/data` |
| Size | 1 GB (see §5.4) |

Attaching a volume locks the service to one replica. That is the desired state.

### 4.3 Set environment variables

Add every runtime variable from §3. For the database, use Railway's reference
syntax so the private URL is injected:

```
DATABASE_URL=${{Postgres.DATABASE_URL}}
SESSION_STORE_DIR=/data/sessions
```

### 4.4 Run migrations

The `prisma` CLI is a **devDependency** and is deliberately absent from the
runtime image, so migrations are run from your machine against Railway's
**public** database URL. This matches how telemetry is already loaded
(`docs/DATA-IMPORT.md` — manual import, no seed script).

From the Railway dashboard, copy the Postgres service's **public** connection
string, then:

```bash
# In tarang-agent/, with DATABASE_URL temporarily pointed at Railway.
DATABASE_URL="postgresql://postgres:...@<public-host>:<port>/railway" npx prisma migrate deploy
DATABASE_URL="postgresql://postgres:...@<public-host>:<port>/railway" npx prisma migrate status
```

`migrate status` should report **both** migrations as applied:

| Migration | Adds |
|---|---|
| `20260729163900_init_telemetry` | `vehicles`, `battery_telemetry`, `gps_telemetry`, `can_telemetry` |
| `20260809162449_add_memory_entries` | `memory_entries` and the `memory_kind` / `memory_source` enums (Phase 4E long-term memory) |

> **The memory migration is a MANUAL step, and it gates the feature.**
> `docker-entrypoint.sh` runs no migrations by design — startup stays boring and
> fast — so deploying the image does not create `memory_entries`. Until
> `migrate deploy` has been run, `/api/memory` and every authenticated chat
> request fail on a missing relation, because `/api/chat` reads preferences on
> each authenticated run. **Order matters: run the migration before enabling
> `APP_AUTH_ENABLED`.**
>
> `20260809162449_add_memory_entries` is **purely additive** — two `CREATE TYPE`,
> one `CREATE TABLE`, one `CREATE UNIQUE INDEX`. No existing table is altered,
> no column dropped, no backfill runs, and nothing in the telemetry path
> references these objects, so applying it cannot change any existing answer.
> `migrate deploy` is idempotent and safe to re-run.

> The database will be **empty** after this. Telemetry is imported manually —
> follow `docs/DATA-IMPORT.md`, pointing it at the same public URL.

### 4.5 Deploy

```bash
railway up
```

or push to the connected branch.

---

## 5. `SESSION_STORE_DIR` and the persistent volume

This is the part that decides whether the encrypted Intellicar session survives
a restart, so it is worth understanding rather than copying.

### 5.1 The configuration

| | |
|---|---|
| Railway volume mount path | `/data` |
| `SESSION_STORE_DIR` | `/data/sessions` |

### 5.2 Why an absolute path

The default is `.sessions` (`src/lib/env.ts`, `authEnvSchema`), resolved by
`join()` against `process.cwd()`. Inside the container that is `/app/.sessions`
— an image layer, discarded on every deploy and every restart. Only an absolute
path under the mount reaches the volume.

### 5.3 Why a subdirectory rather than `/data` itself

`session-store.ts` creates the directory with
`mkdir(dir, { recursive: true, mode: 0o700 })`, and `mkdir` applies `mode` only
to directories it actually **creates**. Pointing `SESSION_STORE_DIR` at `/data`
would find the mount point already present, so the `0700` would be silently
discarded and the directory would keep the mount's default permissions. Using
`/data/sessions` means the store creates it and gets `0700` for free — with no
extra logic anywhere in the application.

### 5.4 Why the volume must be writable by a non-root user

Two facts meet here:

- **The server runs as `pwuser`**, a deliberate security choice. Chromium was
  *verified* to launch in this image as both root and `pwuser` — the frequently
  repeated "Chromium refuses to run as root" did not hold, because the kernel
  exposes user namespaces and Chromium's namespace sandbox works without the
  setuid helper. Non-root is kept so the deployment does not depend on that
  kernel setting being true wherever it runs, and so a renderer escape does not
  land on root in a container that drives a live customer portal. No
  `--no-sandbox` was introduced; `playwright-manager.ts` is untouched.
- **Railway mounts the volume owned by root**, so `pwuser` cannot create
  anything inside it unaided.

`docker-entrypoint.sh` bridges the two: it enters as root, `mkdir`s the store,
`chown`s the mount, **proves the directory is writable as `pwuser`**, then drops
privileges and `exec`s the server.

The write probe is not defensive decoration. If the store were unwritable,
`store.save()` would throw inside `loginAndRun`, that throw is uncaught, and the
request would surface as `PORTAL_UNREACHABLE` — *after a real, successful
Intellicar login*. Because the login succeeded, `consecutiveLoginFailures` resets
and the lockout latch never engages, so every portal question would drive another
sign-in with no ceiling. The entrypoint refuses to start instead.

### 5.5 Sizing

The session file is ~4 KB. **1 GB is ample.**

One caveat: the debug capture flags in `authenticator.ts` and `session-store.ts`
are currently `true`, and they write full-page dashboard screenshots into
`SESSION_STORE_DIR` on login failures and expired probes. If they stay enabled,
allow 5 GB and prune periodically. Disabling them is an application-code change
and is deliberately **not** part of this deployment work.

### 5.6 What survives what

| Event | Outcome |
|---|---|
| Container crash / OOM restart | Volume persists → session reused, **no login**. |
| `railway up` / new deploy | New image, same volume → session reused, **no login**. |
| Volume deleted or detached | `load()` gets `ENOENT` → returns `null` → clean re-login. Graceful. |
| `CREDENTIAL_ENCRYPTION_KEY` rotated | `open()` throws → caught in `session-store.ts` → treated as absent → clean re-login. Graceful. |
| Manual `invalidateSession()` | Session cleared, latch reset. |

---

## 6. Health check

`railway.json` sets `healthcheckPath: "/"`.

`/` is `src/app/page.tsx`, a client component. It reaches **neither PostgreSQL,
nor Chromium, nor OpenRouter**, so this is a *liveness* check — "is the server
up" — not a dependency check. That is deliberate: a health check that failed
when the Intellicar portal was unreachable would restart a container that is
working perfectly.

`healthcheckTimeout` is 300s to cover the first-request module load.

---

## 7. Verifying the deployment

### 7.1 Server is up

```bash
curl -i https://<your-app>.up.railway.app/
```

Expect `200`.

### 7.2 Environment loaded and the agent runs

```bash
curl -N -X POST https://<your-app>.up.railway.app/api/chat \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"How many vehicles are in the fleet right now?"}]}'
```

Expect a stream of NDJSON frames (`{"type":"token",...}`), ending with
`{"type":"sources",...}` and `{"type":"done"}`. A `sources` entry naming
`Intellicar portal (live)` proves the whole chain: env → agent → Portal Tool →
Portal Service → Session Manager → Playwright → Chromium → the live portal.

### 7.3 Playwright launched and the session persisted

In Railway's logs, look for:

```
[entrypoint] Session store ready and writable by pwuser.
{"service":"playwright","level":"info","msg":"Chromium launched."}
{"service":"session-store","level":"info","msg":"Encrypted session state saved."}
```

### 7.4 Session persistence across a redeploy — the decisive test

This is the one that proves the volume is doing its job.

1. Ask a portal question (§7.2). Logs show either
   `"No stored Intellicar session; authenticating."` or a reuse line, followed
   by `"Encrypted session state saved."`
2. Confirm the file exists on the volume:
   ```bash
   railway run --service <app> ls -la /data/sessions
   ```
   Expect `intellicar-session.json`, owned by `pwuser`, in a `drwx------`
   directory.
3. **Redeploy** — `railway up`, or Deployments → Redeploy.
4. Ask the same portal question again.
5. In the logs, expect:
   ```
   {"service":"session-manager","level":"info","msg":"Reusing the stored Intellicar session."}
   ```
   and **no** `"Encrypted session state saved."` line.

Seeing *"Reusing the stored Intellicar session"* after a redeploy is the proof.
If instead you see *"No stored Intellicar session; authenticating."*, the volume
is not mounted at `/data` or `SESSION_STORE_DIR` does not point inside it.

---

## 8. Local verification with Docker Compose

Run this before the first Railway deploy — it exercises the volume ownership and
privilege-drop sequence, which is the step most likely to be wrong.

```bash
docker compose up --build
```

Then, in another shell:

```bash
curl -i http://localhost:3000/                       # expect 200
docker compose exec app ls -la /data/sessions        # expect drwx------ pwuser
docker compose exec app id                           # expect uid=...(pwuser)
```

Session persistence, locally:

```bash
# ask a portal question, then:
docker compose down          # containers destroyed, named volume kept
docker compose up
docker compose exec app ls -la /data/sessions   # the session file is still there
```

`docker compose down -v` also destroys the volume — the local equivalent of
deleting the Railway volume.

Compose reads secrets from `.env.local` **on the host** and injects them as
environment variables. That file is gitignored and excluded by `.dockerignore`;
it is never copied into the image.

---

## 9. Operational notes

**Scaling.** Do not raise replicas above 1. The serialisation queue, the
rejected-credential latch and the failure counter in `session-manager.ts` are
module-level and therefore process-scoped; a second replica would let two
processes log in concurrently, race the same session file, and each independently
spend three failed attempts before latching — the exact account-lockout risk the
latch exists to prevent. Railway blocks this while a volume is attached; do not
work around it. Horizontal scaling requires a shared session store plus a
distributed lock (SAD §17 defers this deliberately).

**Memory.** Chromium plus Node plus the Prisma WASM query compiler wants at
least 1 GB, comfortably 2 GB. If Chromium launches are failing intermittently,
suspect memory first.

**`/dev/shm`.** Not an issue here, and worth recording so nobody re-litigates it:
Playwright 1.62 already passes `--disable-dev-shm-usage` in its default Chromium
switches (`playwright-core/lib/coreBundle.js`). No `--shm-size` tuning is needed,
which is fortunate — Railway does not expose it.

**Image size.** ~4.6 GB, measured. Roughly 3.7 GB is the Playwright base layer,
828 MB is the production `node_modules`, and 18 MB is the Next.js build output.
The base carries Firefox (302 MB) and WebKit (293 MB) that this application can
never launch — `playwright-manager.ts` imports `chromium` only. Deleting them in
a later layer was tried and reverted: `rm -rf` writes whiteouts, the base layer
still ships, and the measured size was unchanged at 4.57 GB. Shedding that weight
requires a different runner base (`node:22-slim` plus
`playwright install --with-deps chromium`), which trades the Microsoft image's
version-matched browsers for OS packages resolved at build time. That is an
architectural decision, not a Dockerfile tweak, and SAD §17 currently specifies
this base. **Measure before repeating the experiment.**

**Base image version.** `Dockerfile` pins
`mcr.microsoft.com/playwright:v1.62.0-noble` via the `PLAYWRIGHT_VERSION` build
arg, matching `playwright@1.62.0` in `package.json`. **Bump both together.** A
skew between the npm package and the preinstalled browsers is a launch failure.

**Migrations on future deploys.** Repeat §4.4 before deploying a revision that
adds a migration. `prisma migrate deploy` is idempotent and safe to re-run.

**Rollback.** Railway → Deployments → select a previous deployment → Redeploy.
The volume is unaffected, so the session survives a rollback exactly as it
survives a roll-forward.

---

## 10. Architectural boundaries — unchanged

For the record, since deployment work is a common place for boundaries to erode:

| Boundary | Status |
|---|---|
| Session Manager owns authentication | Unchanged. Only the **value** of `SESSION_STORE_DIR` differs, and it was already an env var read through `authEnv()`. |
| Portal never authenticates | Unchanged. |
| Portal only receives authenticated contexts | Unchanged. |
| Credentials remain encrypted at rest | Unchanged (still env-var plaintext per SAD §9's deferral) — improved in practice by moving from a `.env.local` file to Railway's secret store, with `.dockerignore` guaranteeing the file never ships. |
| Playwright ownership | Unchanged. `playwright-manager.ts` was not touched — which is precisely **why** the container must run non-root, rather than adding `--no-sandbox` to the launch call. |
| Analysis Engine | Unchanged. Its fixtures live under `src/` and ship with the build. |
| Portal Tool is a thin adapter | Unchanged, all 104 lines. |
| CLAUDE.md rule 4 (`globalThis` singletons) | Preserved — single replica, single long-lived process. |
| CLAUDE.md rule 6 (exactly 4 tools) | Preserved — no tool added. |

No file under `src/` was modified by this work.
