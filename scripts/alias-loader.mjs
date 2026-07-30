/**
 * ESM resolve hook for the manual verification runner (scripts/auth-login.ts).
 *
 * Node runs TypeScript natively, but it does not read tsconfig — so neither the
 * `@/*` path alias nor TypeScript's extensionless relative imports resolve on
 * their own. This maps `@/x` to `src/x` and retries extensionless specifiers as
 * `.ts`, which is the whole reason a plain `node scripts/auth-login.ts` can load
 * the authentication modules unchanged.
 *
 * Used only by `npm run auth:login`. Application code never loads this, and
 * nothing here affects the Next.js build, which resolves the alias itself.
 */
const SRC = new URL("../src/", import.meta.url).href;

export async function resolve(specifier, context, next) {
  const mapped = specifier.startsWith("@/") ? SRC + specifier.slice(2) : specifier;

  try {
    return await next(mapped, context);
  } catch (error) {
    // Retry as ".ts", inserting the extension before any query string.
    const queryAt = mapped.search(/[?#]/);
    const path = queryAt === -1 ? mapped : mapped.slice(0, queryAt);
    const query = queryAt === -1 ? "" : mapped.slice(queryAt);

    if (!/\.(ts|tsx|js|mjs|cjs|json|node)$/.test(path)) {
      return await next(`${path}.ts${query}`, context);
    }

    throw error;
  }
}
