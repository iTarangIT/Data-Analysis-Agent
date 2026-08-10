import { z } from "zod";

import { isAppAuthEnabled } from "@/lib/env";
import { childLogger } from "@/lib/logger";
import { issueSession } from "@/services/identity/app-session";
import { verifyCredential } from "@/services/identity/users";

/**
 * Sign in (SAD §10, Phase 4D).
 *
 * Thin by design, exactly as /api/chat is: validate, call a service, respond.
 * It holds no crypto, no user table and no cookie attributes — those belong to
 * `src/services/identity/`.
 *
 * ## This has nothing to do with Intellicar
 *
 * SAD §10's two authentication domains: this one answers "who may use Tarang".
 * The Session Manager answers "how does Tarang reach Intellicar", is reached
 * only in-process by the Portal Service, and is untouched by this route. A user
 * signing in here does not cause an Intellicar login, and an Intellicar session
 * grants nothing here.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const log = childLogger("auth");

const requestSchema = z.object({
  username: z.string().min(1).max(128),
  /**
   * Bounded so a pathological body cannot be fed to scrypt. The upper bound is
   * far above any real passphrase; scrypt's cost is in its parameters, but the
   * input still has to be read and hashed.
   */
  password: z.string().min(1).max(1024),
});

export async function POST(request: Request) {
  if (!isAppAuthEnabled()) {
    // Stated plainly rather than 404'd. Whether app authentication is switched
    // on is a deployment fact, not a secret, and a clear answer is what stops
    // this being debugged as a routing fault.
    return Response.json(
      { error: "Application authentication is not enabled." },
      { status: 503 }
    );
  }

  const body: unknown = await request.json().catch(() => null);
  const parsed = requestSchema.safeParse(body);

  if (!parsed.success) {
    // Field PATHS only, never values — the same rule src/lib/env.ts and
    // /api/chat already apply, and the one that matters most on this route,
    // because one of these fields is a password.
    log.warn(
      { issues: parsed.error.issues.map((issue) => issue.path.join(".")) },
      "Rejected a malformed sign-in request."
    );

    return Response.json({ error: "Invalid request" }, { status: 400 });
  }

  const { username, password } = parsed.data;
  const user = await verifyCredential(username, password);

  if (user === null) {
    // ONE MESSAGE FOR EVERY FAILURE. "No such user" and "wrong password" are
    // the same answer here, so the response cannot be used to enumerate users —
    // which is also why verifyCredential pays for a scrypt derivation either
    // way, so the TIMING cannot be used for it either.
    //
    // The attempted username is recorded because a burst of failures against
    // one name is the signal worth having; the password never is, and is not
    // interpolated into any message (Pino redacts field paths, not free text).
    log.warn({ username }, "Sign-in rejected.");

    return Response.json({ error: "Invalid username or password." }, { status: 401 });
  }

  await issueSession(user.userId);
  log.info({ username: user.userId }, "Sign-in succeeded.");

  // No session material in the body. The cookie is HttpOnly for a reason, and
  // echoing anything openable would hand it straight back to scripts.
  return Response.json({ ok: true, userId: user.userId });
}
