import { clearSession } from "@/services/identity/app-session";

/**
 * Sign out (SAD §10, Phase 4D).
 *
 * Clears the session cookie and says nothing else.
 *
 * ## Always succeeds, and always clears
 *
 * There is no "you were not signed in" branch. Signing out is idempotent, the
 * outcome a caller wants is the same either way — no session afterwards — and a
 * distinct response would only tell an unauthenticated caller whether a cookie
 * it could not read was valid.
 *
 * It runs even when APP_AUTH_ENABLED is false, deliberately: switching
 * enforcement off must not strand a cookie in a browser with no way to remove
 * it. Clearing needs no key, so there is nothing to configure.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  await clearSession();

  return Response.json({ ok: true });
}
