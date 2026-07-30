import { chromium, type Browser, type BrowserContext } from "playwright";

import { authEnv } from "@/lib/env";
import { childLogger } from "@/lib/logger";

/**
 * Playwright Manager (SAD §4, §11, CLAUDE.md hard rule 4).
 *
 * Pure infrastructure: a Chromium lifecycle and nothing else. It contains no
 * business logic, no AI logic, and no knowledge of credentials, sessions or
 * Intellicar. It cannot tell an authenticated context from an anonymous one —
 * that judgement belongs to the authenticator.
 *
 * ## Singleton, but launched lazily
 *
 * The browser is cached on `globalThis` (hard rule 4) so Next.js hot-reload
 * reuses one Chromium instead of leaking a process on every edit — the same
 * pattern and the same reasoning as src/lib/prisma.ts.
 *
 * Unlike the Prisma client, it is not created at import time. Chromium costs
 * hundreds of megabytes of RSS and a second of startup, and most requests to
 * this application never touch a browser at all. So the process launches one
 * on first genuine need and not before: importing this module is free.
 *
 * ## This module is Node-runtime only
 *
 * It must never be imported from a Client Component or an Edge-runtime route.
 */

const log = childLogger("playwright");

/** Storage state as Playwright itself types it, without naming an internal type. */
export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

const globalForPlaywright = globalThis as unknown as {
  tarangBrowser: Browser | undefined;
};

/**
 * Launch, or reuse, the singleton Chromium.
 *
 * `isConnected()` is checked rather than trusting the cached handle: a crashed
 * or externally-killed browser leaves a stale object behind that fails on every
 * later call, and relaunching is always the right response (SAD §11 crash
 * recovery).
 */
export async function getBrowser(): Promise<Browser> {
  const cached = globalForPlaywright.tarangBrowser;

  if (cached?.isConnected()) return cached;

  if (cached) {
    log.warn("Cached Chromium is no longer connected; relaunching.");
    globalForPlaywright.tarangBrowser = undefined;
  }

  const headless = authEnv().PLAYWRIGHT_HEADLESS;
  const browser = await chromium.launch({ headless });

  globalForPlaywright.tarangBrowser = browser;
  log.info({ headless }, "Chromium launched.");

  return browser;
}

/**
 * Run `run` against a fresh browser context, optionally restored from a saved
 * storage state.
 *
 * The context is always closed, including on throw. Contexts hold cookies and
 * pages; leaking one leaks a live session into a process that has stopped
 * tracking it, so closing is not left to the caller.
 *
 * The default timeout applies to every action inside the context, so a portal
 * that stops responding fails the run instead of hanging it.
 */
export async function withContext<T>(
  storageState: StorageState | undefined,
  run: (context: BrowserContext) => Promise<T>
): Promise<T> {
  const browser = await getBrowser();
  const context = await browser.newContext(
    storageState ? { storageState } : undefined
  );
  context.setDefaultTimeout(authEnv().AUTH_TIMEOUT_MS);

  try {
    return await run(context);
  } finally {
    // A close failure must not mask the real error from `use`, and there is
    // nothing to recover: the browser is about to be discarded anyway.
    await context.close().catch((error: unknown) => {
      log.warn({ err: error }, "Failed to close browser context.");
    });
  }
}

/**
 * Close the singleton browser if one is running. Idempotent, and safe to call
 * when nothing was ever launched.
 *
 * Callers must not hold an open context across this call. Milestone 3
 * serialises all browser work through the Session Manager, so no concurrent
 * context can exist when this runs.
 */
export async function closeBrowser(): Promise<void> {
  const browser = globalForPlaywright.tarangBrowser;
  if (!browser) return;

  globalForPlaywright.tarangBrowser = undefined;

  try {
    await browser.close();
    log.info("Chromium closed.");
  } catch (error) {
    // The process may already be gone. The handle is cleared either way, so the
    // next call relaunches cleanly.
    log.warn({ err: error }, "Failed to close Chromium cleanly.");
  }
}

/** Whether a connected browser is currently running. For diagnostics only. */
export function isBrowserRunning(): boolean {
  return globalForPlaywright.tarangBrowser?.isConnected() ?? false;
}
