#!/usr/bin/env bash
#
# Container entrypoint for Tarang.
#
# This file exists to reconcile two facts:
#
#   1. THE SERVER RUNS AS A NON-ROOT USER (`pwuser`). This is a deliberate
#      security choice, not a functional necessity — Chromium was VERIFIED to
#      launch in this image as both root and pwuser, because the kernel exposes
#      user namespaces and its namespace sandbox therefore works either way.
#      Non-root is kept so the deployment does not DEPEND on that kernel
#      setting being true wherever it runs, and so a renderer escape does not
#      land on root in a container that drives a live customer portal.
#
#   2. RAILWAY MOUNTS ITS VOLUME OWNED BY ROOT. A process already dropped to
#      pwuser cannot create a directory inside it.
#
# So the container enters as root, prepares the volume, and only then drops
# privileges to run the server. Nothing else happens here: no migrations, no
# schema push, no session priming. Startup stays boring and fast.
#
# Note what is NOT done: no `--no-sandbox` is introduced anywhere. The launch
# call in src/services/session/playwright-manager.ts is untouched, and
# Playwright ownership stays exactly where the architecture puts it.
#
# ## Why getting this wrong is worse than a crash
#
# If SESSION_STORE_DIR is not writable, `store.save()` throws EACCES at
# src/services/session/session-manager.ts (the `await store.save(...)` inside
# loginAndRun). That throw is not caught there — the request surfaces as
# PORTAL_UNREACHABLE. But the login it just performed SUCCEEDED, so
# `consecutiveLoginFailures` resets to zero and the lockout latch never engages.
# Every portal question would then drive a fresh, discarded sign-in against the
# customer's Intellicar account, with no ceiling. The pre-flight check below
# refuses to start rather than allow that.

set -euo pipefail

log() {
  printf '[entrypoint] %s\n' "$*"
}

fail() {
  printf '[entrypoint] ERROR: %s\n' "$*" >&2
  exit 1
}

APP_USER="${APP_USER:-pwuser}"
SESSION_STORE_DIR="${SESSION_STORE_DIR:-/data/sessions}"

# ---------------------------------------------------------------------------
# Session store preparation.
# ---------------------------------------------------------------------------
#
# `mkdir -p` on the full path so a volume mounted at /data gains its `sessions`
# subdirectory on first boot, and so a deployment WITHOUT a volume still starts
# (writing to the container layer — ephemeral, but functional, which is the
# right behaviour for a smoke test).
log "Preparing session store at ${SESSION_STORE_DIR}"
mkdir -p "${SESSION_STORE_DIR}"

# The mount ROOT is chowned, not just the leaf: Railway creates /data as root,
# and a pwuser-owned leaf inside a root-owned parent still cannot be replaced.
# session-store.ts writes atomically as `<file>.tmp` followed by a rename within
# the same directory, so write permission on the DIRECTORY — not just the file —
# is what the rename needs.
SESSION_STORE_ROOT="$(dirname "${SESSION_STORE_DIR}")"

if [ "$(id -u)" -eq 0 ]; then
  chown -R "${APP_USER}:${APP_USER}" "${SESSION_STORE_ROOT}" 2>/dev/null \
    || log "WARNING: could not chown ${SESSION_STORE_ROOT}; continuing to the write test."

  # 0700 matches what session-store.ts requests when it creates the directory
  # itself. Restated here because the directory may already exist from a
  # previous deploy, and `mkdir -p` does not alter an existing directory's mode.
  chmod 700 "${SESSION_STORE_DIR}" 2>/dev/null \
    || log "WARNING: could not chmod ${SESSION_STORE_DIR}."
fi

# ---------------------------------------------------------------------------
# Pre-flight: prove the session store is writable BY THE APP USER.
# ---------------------------------------------------------------------------
#
# Tested as the user that will actually run the server, because root can write
# to places pwuser cannot — a root-side check would pass and tell us nothing.
# Failing loudly here converts a silent, expensive runtime fault (see the header)
# into an unmistakable startup failure.
PROBE_FILE="${SESSION_STORE_DIR}/.write-probe"

if [ "$(id -u)" -eq 0 ]; then
  WRITE_OK=$(su -s /bin/sh -c "touch '${PROBE_FILE}' 2>/dev/null && rm -f '${PROBE_FILE}' && echo ok" "${APP_USER}" || true)
else
  WRITE_OK=$(touch "${PROBE_FILE}" 2>/dev/null && rm -f "${PROBE_FILE}" && echo ok || true)
fi

if [ "${WRITE_OK}" != "ok" ]; then
  fail "SESSION_STORE_DIR (${SESSION_STORE_DIR}) is not writable by ${APP_USER}.
  The encrypted Intellicar session could not be persisted, which would cause a
  fresh sign-in on every portal request with no lockout protection.
  On Railway: confirm a volume is mounted at ${SESSION_STORE_ROOT} and that
  SESSION_STORE_DIR points inside it. See docs/DEPLOYMENT.md."
fi

log "Session store ready and writable by ${APP_USER}."

# ---------------------------------------------------------------------------
# Server startup.
# ---------------------------------------------------------------------------
#
# `next` is resolved from the local bin rather than through `npx`, which would
# add a resolution step and an extra process to every container start.
export PATH="/app/node_modules/.bin:${PATH}"

# Railway injects PORT. Bound explicitly to 0.0.0.0 so the container is
# reachable from outside its namespace regardless of the Next.js default.
PORT="${PORT:-3000}"
export PORT

if [ "${1:-}" = "next" ] && [ "${2:-}" = "start" ]; then
  shift 2
  set -- next start --hostname 0.0.0.0 --port "${PORT}" "$@"
fi

log "Starting: $*"

# `exec` so the server becomes PID 1 and receives SIGTERM directly. Without it,
# a Railway restart or redeploy would signal this shell instead, and Chromium
# plus the Node process would be killed rather than shut down — with an open
# browser context and a half-written session file the possible outcome.
if [ "$(id -u)" -eq 0 ]; then
  # setpriv over su/sudo: it execs in place rather than forking, so the server
  # keeps PID 1 and signal delivery stays direct.
  if command -v setpriv >/dev/null 2>&1; then
    exec setpriv --reuid="${APP_USER}" --regid="${APP_USER}" --init-groups -- "$@"
  fi

  # Fallback for a base image without util-linux's setpriv.
  if command -v runuser >/dev/null 2>&1; then
    exec runuser -u "${APP_USER}" -- "$@"
  fi

  fail "Neither setpriv nor runuser is available; cannot drop privileges to ${APP_USER}.
  Running the server as root would make Chromium refuse to launch."
fi

# Already non-root (e.g. `docker run --user`). Nothing to drop.
exec "$@"
