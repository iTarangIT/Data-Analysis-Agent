import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Authentication must stay independent of the data-retrieval path (SAD §5, §9,
 * Milestone 3). These zones make that boundary mechanical instead of a rule
 * reviewers have to remember, and `npm run lint` is already in the workflow.
 *
 * The restriction runs in BOTH directions, which is the point:
 *   - authentication must not reach the database or the tools, so a portal
 *     concern can never leak into a telemetry answer;
 *   - the database and tool layers must not reach authentication, so no tool —
 *     and therefore no LLM tool call — has a path to a login, a credential or a
 *     cookie.
 */
const AUTH_PATHS = ["src/services/session/**", "src/services/credentials/**"];
const DATA_PATHS = ["src/services/database/**", "src/tools/**", "src/agent/**"];

const authIsolation = [
  {
    files: AUTH_PATHS,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@/services/database/*",
                "@/tools/*",
                "@/agent/*",
                "@/lib/prisma",
              ],
              message:
                "Authentication must not depend on the data path (SAD §9, Milestone 3). " +
                "The Session Manager is consumed BY services; it consumes none of them.",
            },
          ],
        },
      ],
    },
  },
  {
    files: DATA_PATHS,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/services/session/*", "@/services/credentials/*"],
              message:
                "Tools, the agent and the Database Service must never reach authentication " +
                "(CLAUDE.md rule 1). A Portal Service — not a tool — asks the Session Manager " +
                "for a context.",
            },
          ],
        },
      ],
    },
  },
];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  ...authIsolation,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Prisma Client output — generated code, never hand-edited.
    "src/generated/**",
  ]),
]);

export default eslintConfig;
