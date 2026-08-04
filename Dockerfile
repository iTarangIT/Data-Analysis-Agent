# syntax=docker/dockerfile:1.7
#
# Tarang — production image (SAD §17 Deployment).
#
# ONE LONG-LIVED NODE PROCESS. That is a hard architectural requirement, not a
# packaging preference: the singleton Chromium (src/services/session/
# playwright-manager.ts), the reusable Intellicar session, the serialisation
# queue in session-manager.ts and the streaming /api/chat response all assume a
# process that outlives individual requests. This image is built to be run as
# exactly ONE replica, and Railway enforces that for us — a service with a
# volume attached cannot be scaled past one.
#
# ## Why the Microsoft Playwright base image
#
# SAD §17 specifies it, and the reason is version coupling: the browser binaries
# must match the `playwright` npm package exactly. They are NOT vendored in
# node_modules — Playwright resolves them from a machine-level cache
# (PLAYWRIGHT_BROWSERS_PATH, ~700 MB), and nothing in package.json installs
# them: `postinstall` is `prisma generate` and nothing else. The base image is
# what supplies both the browsers and their OS shared libraries.
#
# The tag is pinned to the exact package version below. Bump both together, or
# Chromium will fail to launch with a driver/browser mismatch.
#
# ## Why NOT Next.js standalone output
#
# `output: "standalone"` is deliberately not enabled (reviewed and approved).
# Standalone relies on file tracing, and Playwright resolves its driver at
# runtime rather than through statically analysable imports — precisely the
# case tracing tends to miss. `@prisma/client` is likewise not listed in
# serverExternalPackages, and its WASM query compiler lives under
# node_modules/@prisma/client/runtime. Shipping the real production dependency
# tree removes both risks, and the ~2 GB Playwright base image dominates the
# size either way.
#
# ## Why four stages
#
#   deps       — dependency install only. Cached on package-lock.json alone, so
#                editing source never reinstalls.
#   builder    — prisma generate + next build. Needs devDependencies.
#   prod-deps  — the same lockfile installed WITHOUT devDependencies. This is
#                what actually ships.
#   runner     — base image + prod-deps + build output. No compilers, no
#                TypeScript, no Prisma CLI, no source.

ARG PLAYWRIGHT_VERSION=1.62.0
ARG BASE_IMAGE=mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble

# ---------------------------------------------------------------------------
# Stage 1 — deps: full dependency tree for the build.
# ---------------------------------------------------------------------------
FROM ${BASE_IMAGE} AS deps

WORKDIR /app

# Only the lockfile and manifest, so this layer is invalidated by a dependency
# change and by nothing else.
COPY package.json package-lock.json ./

# `--ignore-scripts` is deliberate and does two jobs.
#
#   1. package.json's `postinstall` is `prisma generate`, which needs
#      prisma/schema.prisma and prisma.config.ts. Neither has been copied yet,
#      and copying them here would tie this layer's cache to the schema. The
#      builder stage runs generate explicitly instead, where the schema is
#      genuinely present.
#   2. The `playwright` package's own install script downloads browsers. This
#      image already HAS them, preinstalled and version-matched, so skipping the
#      script avoids re-downloading ~700 MB into a second location.
RUN npm ci --ignore-scripts

# ---------------------------------------------------------------------------
# Stage 2 — builder: generate the Prisma client, then build Next.js.
# ---------------------------------------------------------------------------
FROM ${BASE_IMAGE} AS builder

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# The generated client is gitignored (.gitignore: /src/generated/) and excluded
# from the build context, so it is produced here from the schema in this image.
# It needs no database: prisma.config.ts declares a datasource only when
# DATABASE_URL is set, precisely so `generate` works on a fresh checkout.
RUN npx prisma generate

# BUILD-TIME PLACEHOLDERS — never real secrets.
#
# src/lib/env.ts evaluates `loadEnv()` at MODULE SCOPE (`export const env =
# loadEnv()`), and `next build` imports the route handlers to collect their
# metadata. So these three must parse during the build or the build fails.
# Only their SHAPE is validated: DATABASE_URL must start with postgresql://,
# the other two must be non-empty. Railway supplies the real values at runtime.
#
# Baking real secrets in as ARG/ENV would persist them in an image layer, where
# `docker history` can read them back. That is why these are hardcoded
# placeholders rather than build arguments.
#
# The Intellicar variables are deliberately ABSENT: authEnv() validates them
# lazily on first authentication use (src/lib/env.ts), so no portal credential
# ever needs to reach a build stage. That lazy split was designed to keep the
# telemetry path independent of portal configuration, and it pays off here.
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder" \
    OPENROUTER_API_KEY="build-time-placeholder" \
    OPENROUTER_MODEL="build-time-placeholder" \
    NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production

RUN npm run build

# ---------------------------------------------------------------------------
# Stage 3 — prod-deps: the dependency tree that actually ships.
# ---------------------------------------------------------------------------
FROM ${BASE_IMAGE} AS prod-deps

WORKDIR /app

COPY package.json package-lock.json ./

# `--omit=dev` drops the Prisma CLI, TypeScript, ESLint, Tailwind and the React
# compiler plugin — roughly 150 MB that the running server never touches.
#
# `--ignore-scripts` is REQUIRED here, not optional: `postinstall` runs
# `prisma generate`, and the `prisma` CLI is a devDependency, so the script
# would fail with the very flag that removed it. The generated client is copied
# from the builder stage below instead.
RUN npm ci --omit=dev --ignore-scripts

# ---------------------------------------------------------------------------
# Stage 4 — runner.
# ---------------------------------------------------------------------------
FROM ${BASE_IMAGE} AS runner

WORKDIR /app

# SESSION_STORE_DIR defaults to the volume mount documented in
# docs/DEPLOYMENT.md, and stays overridable from the environment.
#
# src/lib/env.ts falls back to a CWD-relative ".sessions" when the variable is
# unset (authEnvSchema). Inside a container that resolves to /app/.sessions —
# an ephemeral image layer, discarded on every deploy and every restart. An
# ABSOLUTE path under the mount is the whole reason the encrypted session
# survives a redeploy.
#
# A subdirectory of the mount, not the mount itself: session-store.ts creates
# it with `mkdir(dir, { recursive: true, mode: 0o700 })`, and mkdir applies
# `mode` only to directories it actually CREATES. Pointing at /data directly
# would find the mount already present and silently discard the 0700.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    SESSION_STORE_DIR=/data/sessions

# The server runs as `pwuser`, which ships with the Playwright base image.
#
# MEASURED, not assumed: Chromium launches successfully in this image as BOTH
# root and pwuser. The common claim that "Chromium refuses to run as root" did
# not hold here — the kernel exposes user namespaces
# (/proc/sys/user/max_user_namespaces is non-zero), so Chromium's namespace
# sandbox works without the setuid helper and without `--no-sandbox`.
#
# Non-root is kept anyway, for two reasons that survive that finding:
#
#   1. PLATFORM INDEPENDENCE. That launch worked because of a kernel setting
#      this Dockerfile does not control. Railway's runtime may differ. Running
#      as pwuser makes the question moot instead of depending on the answer.
#   2. BLAST RADIUS. This process drives a real browser against a live customer
#      portal and holds a decrypted session in memory. A renderer escape should
#      not land on root inside the container.
#
# What it is NOT: a workaround for the launch call. playwright-manager.ts
# passes `chromium.launch({ headless })` with no `args`, and that stays true —
# no `--no-sandbox` was added, and Playwright ownership is untouched.
#
# The container still ENTERS as root so the entrypoint can chown the
# root-owned Railway volume; it drops to this user before exec'ing the server.
ENV APP_USER=pwuser

# NOTE ON IMAGE SIZE — measured, not assumed.
#
# The final image is ~4.6 GB, of which ~3.7 GB is the base layer. That base
# carries Firefox (302 MB) and WebKit (293 MB) which this application can never
# launch: playwright-manager.ts imports `chromium` and nothing else, and it is
# the only module in the system that starts a browser (CLAUDE.md rule 4).
#
# Deleting them here was tried and REVERTED. `rm -rf` in a later layer only
# writes whiteout entries — the base layer still ships, so the measured image
# size was identical (4.57 GB) with and without it. The only way to actually
# shed that weight is a different runner base (node:22-slim plus
# `playwright install --with-deps chromium`), which trades the version-matched
# guarantee the Microsoft image provides for OS packages resolved at build
# time. That is an architectural decision, not a Dockerfile tweak, and SAD §17
# currently specifies this base image.
#
# Recorded here so the next person measures before repeating the experiment.

COPY --from=prod-deps --chown=pwuser:pwuser /app/node_modules ./node_modules
COPY --from=builder   --chown=pwuser:pwuser /app/.next        ./.next
COPY --from=builder   --chown=pwuser:pwuser /app/public       ./public
COPY --from=builder   --chown=pwuser:pwuser /app/src/generated ./src/generated

# Schema and migrations travel with the image so the deployed revision is
# self-describing — `prisma migrate status` can be pointed at it from outside,
# and an operator can see exactly which migrations this build expects.
COPY --from=builder --chown=pwuser:pwuser /app/prisma ./prisma

# next.config.ts is read by `next start`, not only by `next build`:
# serverExternalPackages keeps Playwright resolved from node_modules at runtime
# instead of bundled. Without this file the server would try to use a bundled
# Playwright and fail to find its driver.
COPY --chown=pwuser:pwuser package.json next.config.ts ./

COPY --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

EXPOSE 3000

# Liveness only. Hits "/", which is a client component (src/app/page.tsx) and
# reaches neither PostgreSQL nor Chromium nor OpenRouter — so this answers "is
# the server up", not "is every dependency healthy". Deliberate: a health check
# that fails when the portal is unreachable would restart a container that is
# working correctly.
#
# `start-period` is generous because the first request compiles and loads the
# route module tree.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# Overridable, so `docker run <image> node -e ...` works for one-off checks.
CMD ["next", "start"]
