import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

/**
 * Import zones — the architecture's boundaries, made mechanical.
 *
 * Every rule below states something docs/ARCHITECTURE.md already decided. They
 * live here so a boundary is checked by `npm run lint`, which is already in the
 * workflow, rather than remembered by a reviewer reading a diff.
 *
 * ESLint flat config does not MERGE rules across matching objects — the last
 * matching object wins outright for a given rule. Each zone below therefore
 * states its complete restriction set, and the objects are ordered from
 * general to specific.
 */

/* -------------------------------------------------------------------------- */
/*  Zone vocabulary                                                           */
/* -------------------------------------------------------------------------- */

const AUTH_ZONE = {
  group: ["@/services/session/*", "@/services/credentials/*"],
  message:
    "Tools, the agent and the Database Service must never reach authentication " +
    "(CLAUDE.md rule 1). A Portal Service — not a tool — asks the Session Manager " +
    "for a context.",
};

const BROWSER_ZONE = {
  group: ["playwright", "playwright-core"],
  message:
    "No Playwright type may cross out of src/services/ (SAD §19, Milestone 4). " +
    "The Portal Service holds the browser context and returns normalised JSON; " +
    "a page, a context or a cookie never reaches a tool or the agent.",
};

const DATA_ZONE = {
  group: ["@/services/database/*", "@/tools/*", "@/agent/*", "@/lib/prisma"],
  message:
    "The portal and authentication paths must not depend on the data path " +
    "(SAD §9, §11). They are consumed BY the tool layer; they consume none of it.",
};

/* -------------------------------------------------------------------------- */
/*  Authentication (SAD §5, §9, Milestone 3)                                  */
/* -------------------------------------------------------------------------- */

/**
 * The restriction runs in BOTH directions, which is the point:
 *   - authentication must not reach the database, the portal or the tools, so a
 *     portal concern can never leak into a telemetry answer;
 *   - the database and tool layers must not reach authentication, so no tool —
 *     and therefore no LLM tool call — has a path to a login, a credential or a
 *     cookie.
 */
const AUTH_PATHS = ["src/services/session/**", "src/services/credentials/**"];

const authIsolation = [
  {
    files: AUTH_PATHS,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [...DATA_ZONE.group, "@/services/portal/*"],
              message:
                "Authentication must not depend on the data or portal paths " +
                "(SAD §9, Milestone 3). The Session Manager is consumed BY services; " +
                "it consumes none of them.",
            },
          ],
        },
      ],
    },
  },
  {
    // The tool layer and the Database Service.
    files: ["src/services/database/**", "src/tools/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [AUTH_ZONE, BROWSER_ZONE] }],
    },
  },
  {
    /**
     * The agent core, including the Tool Registry, which stays DEPENDENCY-FREE:
     * it knows tool specs and the result envelope, and no service at all. A
     * service reached from here would put infrastructure behind the one wrapper
     * every tool passes through, and the registry's job is to be the place that
     * cannot be skipped — not the place that does the work.
     */
    files: ["src/agent/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            AUTH_ZONE,
            BROWSER_ZONE,
            {
              group: ["@/services/*", "@/services/**"],
              message:
                "The agent core and the Tool Registry reach services only through a " +
                "tool adapter in src/tools/ (SAD §6). The registry itself stays " +
                "dependency-free.",
            },
          ],
        },
      ],
    },
  },
];

/* -------------------------------------------------------------------------- */
/*  Portal (SAD §4, §11, Milestone 4A)                                        */
/* -------------------------------------------------------------------------- */

/**
 * Four roles, four different things they may import.
 *
 *   - portal.service.ts holds the browser context and is THE ONLY CALLER of
 *     withAuthenticatedContext(). Authentication ownership stays entirely
 *     inside the Session Manager; this is its single consumer.
 *   - extractors/ read Playwright pages. They may not reach authentication, the
 *     database, the tool layer or the agent.
 *   - normalizers.ts is pure parsing. It may not reach any of those AND may not
 *     import Playwright — a `Page` here would let a normalizer navigate, and
 *     the pure/impure split that makes parsing testable would stop being true.
 *   - the whole module is downstream of the data path: it never touches Prisma,
 *     the Database Service, a tool or the agent.
 */
const PORTAL_PATHS = ["src/services/portal/**"];
const PORTAL_SERVICE = "src/services/portal/portal.service.ts";
const PORTAL_NORMALIZERS = "src/services/portal/normalizers.ts";

const portalIsolation = [
  {
    // Everything in the Portal module except the service itself.
    files: PORTAL_PATHS,
    ignores: [PORTAL_SERVICE],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: AUTH_ZONE.group,
              message:
                "portal.service.ts is the ONLY caller of withAuthenticatedContext() " +
                "(SAD §8, Milestone 4). An extractor receives a page that is already " +
                "authenticated; it never asks for one, and never sees a credential.",
            },
            DATA_ZONE,
          ],
        },
      ],
    },
  },
  {
    // The Portal Service: authentication IS its dependency; the data path is not.
    files: [PORTAL_SERVICE],
    rules: {
      "no-restricted-imports": ["error", { patterns: [DATA_ZONE] }],
    },
  },
  {
    // Normalizers: pure parsing. Listed last so it wins over the module-wide
    // object above, which it deliberately restates and extends.
    files: [PORTAL_NORMALIZERS],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [...AUTH_ZONE.group, ...BROWSER_ZONE.group],
              message:
                "Normalizers are pure functions over already-extracted data " +
                "(SAD §11 step 6). They import neither Playwright nor authentication: " +
                "the Extractor contract that names a Page lives in portal.service.ts.",
            },
            DATA_ZONE,
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
  ...portalIsolation,
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
