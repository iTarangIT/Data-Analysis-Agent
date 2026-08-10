import { ChatSurface } from "@/components/chat/ChatSurface";
import { isAppAuthEnabled } from "@/lib/env";
import { getAppPrincipal } from "@/services/identity/principal";

/**
 * The chat route (Phase 4F).
 *
 * A SERVER COMPONENT whose entire job is to answer one question the browser
 * cannot: is anyone signed in. The chat surface itself is unchanged and lives in
 * `src/components/chat/ChatSurface.tsx`.
 *
 * ## Why the split exists
 *
 * The session cookie is HttpOnly (SAD §10, Phase 4D) — deliberately, so that no
 * script can read it. The consequence is that a Client Component has no way to
 * know whether it is looking at a signed-in user, which is why Phase 4E shipped
 * with no Login or Logout control at all. Reading the principal here is the
 * smallest thing that fixes it: `getAppPrincipal()` is the EXISTING entry point,
 * there is no new endpoint, no new mechanism and no second source of identity.
 *
 * ## What crosses to the client
 *
 * A boolean and a user id. Not the cookie, not the sealed payload, not
 * `issuedAt`/`expiresAt`, and nothing derived from `APP_SESSION_KEY`. The user
 * id is already the user's own name and is shown to them in the header; it is
 * not a credential and cannot be exchanged for one.
 *
 * ## `force-dynamic`, and it is not decorative
 *
 * `getAppPrincipal()` returns null WITHOUT touching cookies when authentication
 * is disabled, so Next has no cookie access to infer dynamism from on that path
 * and would happily prerender this page at build time. In the Docker image that
 * build runs with whatever `APP_AUTH_ENABLED` the BUILDER saw — which on Railway
 * is not the value the running container sees — and the result would be a
 * permanently signed-out header baked into a static page. Rendering per request
 * is what makes the control reflect the deployment rather than the build.
 */
export const dynamic = "force-dynamic";

export default async function ChatPage() {
  const authEnabled = isAppAuthEnabled();

  // Not asked at all when enforcement is off: `getAppPrincipal` would return
  // null immediately anyway, and skipping it keeps the disabled deployment on
  // exactly the path it has always taken.
  const principal = authEnabled ? await getAppPrincipal() : null;

  return (
    <ChatSurface authEnabled={authEnabled} userId={principal?.userId ?? null} />
  );
}
