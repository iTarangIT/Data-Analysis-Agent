"use client";

import { useState } from "react";

/**
 * Sign-in (SAD §10, Phase 4D).
 *
 * The minimum surface that lets a person obtain a session: a form, a POST, and
 * a redirect. It holds no session state of its own — the cookie is HttpOnly, so
 * this component cannot read it even if it wanted to, which is precisely the
 * property that makes it safe.
 *
 * Deliberately not a modal over the chat and not a middleware redirect. Phase 4D
 * protects one route at the route itself (no middleware.ts), so this is a page
 * a signed-out user is pointed at rather than one they are bounced through.
 *
 * Styled with the existing design tokens, so globals.css is untouched.
 */
export default function SignInPage() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;

    setBusy(true);
    setError(null);

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });

      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;

        setError(detail?.error ?? "Sign-in failed.");
        return;
      }

      // A full navigation rather than a client route change: the session is a
      // cookie, and the next request must carry it.
      window.location.href = "/";
    } catch {
      setError("Could not reach the server.");
    } finally {
      // Cleared even on the success path — the navigation above may not have
      // committed yet, and a form left disabled forever is worse than one
      // briefly re-enabled.
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex h-dvh w-full max-w-sm flex-col justify-center px-6">
      <div className="flex items-baseline gap-2.5">
        <span aria-hidden className="text-live">
          ▪
        </span>
        <h1 className="text-base font-semibold tracking-tight text-ink">Tarang</h1>
        <p className="eyebrow text-ink-faint">Fleet Analyst</p>
      </div>

      <p className="mt-1 text-xs text-ink-muted">Sign in to continue.</p>

      <form onSubmit={submit} className="mt-6 space-y-3">
        <div>
          <label htmlFor="username" className="eyebrow text-ink-faint">
            Username
          </label>
          <input
            id="username"
            name="username"
            autoComplete="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            required
            className="mt-1 w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-ink-faint"
          />
        </div>

        <div>
          <label htmlFor="password" className="eyebrow text-ink-faint">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            className="mt-1 w-full rounded-lg border border-hairline-strong bg-surface px-3 py-2 text-sm text-ink outline-none focus:border-ink-faint"
          />
        </div>

        {error ? (
          <p role="alert" className="text-sm text-ink-muted">
            {error}
          </p>
        ) : null}

        <button
          type="submit"
          disabled={busy || !username || !password}
          className="eyebrow w-full rounded-lg bg-ink px-4 py-2.5 text-background transition-opacity disabled:opacity-30"
        >
          {busy ? "Signing in" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
