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
  group: [
    "@/services/database/*",
    "@/services/analytics/*",
    "@/tools/*",
    "@/agent/*",
    "@/lib/prisma",
  ],
  message:
    "The portal and authentication paths must not depend on the data path " +
    "(SAD §9, §11). They are consumed BY the tool layer and by the Analysis " +
    "Engine; they consume neither.",
};

/**
 * Reverse geocoding, forbidden to everything that produces an answer (Phase 3).
 *
 * Added to each existing zone's own pattern list rather than declared as a zone
 * object of its own, and that is load-bearing: flat config does not merge rules
 * across matching objects — the last match wins outright — so a later object
 * listing `src/services/analytics/**` and `src/tools/**` would silently REPLACE
 * their whole restriction set and disable every authentication and browser rule
 * in this file. Each zone states its complete set; this joins those sets.
 *
 * The agent zone needs no entry: it already bans `@/services/*` wholesale.
 */
const GEOCODING_ZONE = {
  group: ["@/services/geocoding/*", "@/services/geocoding/**"],
  message:
    "Facts, the Analysis Engine, the Portal Service, the Planner and the Tool " +
    "Registry must not know reverse geocoding exists (Phase 3). An address is a " +
    "presentation label added by the UI after a report has rendered; it never " +
    "enters an answer, and never reaches the model's context.",
};

/**
 * What a PROVIDER may not reach (Milestone 5B).
 *
 * The Analysis Engine sits ABOVE the Portal Service and the Database Service and
 * depends on both; neither depends on it. That direction is the entire argument
 * for placing the engine where it is — it is what lets the engine combine two
 * sources without either source learning that the other exists — so it is
 * checked rather than remembered.
 */
const ANALYTICS_ZONE = {
  group: ["@/services/analytics/*", "@/services/analytics/**"],
  message:
    "The Analysis Engine consumes the Portal and Database services; they never " +
    "consume it (SAD §4, Milestone 5B). A provider that reached upward into the " +
    "engine would make the dependency circular and the engine unremovable.",
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
            GEOCODING_ZONE,
          ],
        },
      ],
    },
  },
  {
    /**
     * The Database Service — a pure PROVIDER. It is consumed by the tool layer
     * and by the Analysis Engine, and consumes neither, so the restriction is
     * wider than the tool layer's below. Split from the tool object at Milestone
     * 5B, when there was finally something above it that could be reached
     * upward for.
     */
    files: ["src/services/database/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            AUTH_ZONE,
            BROWSER_ZONE,
            ANALYTICS_ZONE,
            {
              group: ["@/services/portal/*", "@/tools/*", "@/agent/*"],
              message:
                "The Database Service is the bottom of the data path. It knows " +
                "nothing of the portal, the tools or the agent (SAD §4, §12).",
            },
            GEOCODING_ZONE,
          ],
        },
      ],
    },
  },
  {
    // The tool layer. It MAY reach the Analysis Engine — that is what makes the
    // Analysis Tool a thin adapter — and may never reach authentication or a
    // browser.
    files: ["src/tools/**"],
    rules: {
      "no-restricted-imports": ["error", { patterns: [AUTH_ZONE, BROWSER_ZONE, GEOCODING_ZONE] }],
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
            GEOCODING_ZONE,
          ],
        },
      ],
    },
  },
  {
    // The Portal Service: authentication IS its dependency; the data path is not.
    files: [PORTAL_SERVICE],
    rules: {
      "no-restricted-imports": ["error", { patterns: [DATA_ZONE, GEOCODING_ZONE] }],
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
            GEOCODING_ZONE,
          ],
        },
      ],
    },
  },
];

/* -------------------------------------------------------------------------- */
/*  Analytics (SAD §4, §6, Milestone 5B)                                      */
/* -------------------------------------------------------------------------- */

/**
 * The Analysis Engine is the only module that may hold two source classes at
 * once, so it is the only one whose zone permits both providers. What it may
 * NOT do is the part worth enforcing:
 *
 *   - It never reaches authentication or Playwright. It asks the Portal Service
 *     for validated JSON, exactly as a tool does, so a page, a context or a
 *     cookie can no more reach the engine than it can reach the agent
 *     (CLAUDE.md rule 1). The engine being a service buys it no privilege here.
 *   - It never reaches the tool layer or the agent. It is consumed by a tool
 *     adapter; it consumes none of them, and it knows nothing of the result
 *     envelope (CLAUDE.md rule 2).
 *   - It never reaches Prisma. Database access goes through the Database
 *     Service, which is the only Prisma caller (SAD §12).
 *
 * The PURE half is restricted further, in the second object. observations.ts
 * declares types, projections.ts reads an already-fetched record, and
 * reconcile.ts chooses between values already in memory — none of the three may
 * import anything that performs I/O. That is what makes them exercisable against
 * fixtures/telemetry-records.json with no database, and it is the same boundary,
 * drawn for the same reason, as the Portal Service's normalizers.
 *
 * telemetry.records.ts is deliberately NOT in that restriction: it declares
 * record shapes and conversions and performs no I/O, which is precisely why the
 * reads were split out into telemetry.reader.ts at this milestone.
 */
const ANALYTICS_PATHS = ["src/services/analytics/**"];
const ANALYTICS_PURE = [
  "src/services/analytics/observations.ts",
  "src/services/analytics/projections.ts",
  "src/services/analytics/reconcile.ts",
  "src/services/analytics/series.ts",
  "src/services/analytics/conflict.ts",
  // Milestone 5E. Aggregates values already in memory across a population,
  // exactly as series.ts aggregates them across time, and is exercisable against
  // fixtures/fleet-samples.json with no database and no portal.
  "src/services/analytics/aggregate.ts",
];

const AGENT_ZONE = {
  group: ["@/tools/*", "@/agent/*"],
  message:
    "The Analysis Engine is consumed BY a tool adapter and consumes none of the " +
    "tool or agent layer (SAD §6). It does not know the result envelope exists.",
};

const analyticsIsolation = [
  {
    files: ANALYTICS_PATHS,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            AUTH_ZONE,
            BROWSER_ZONE,
            AGENT_ZONE,
            {
              group: ["@/lib/prisma"],
              message:
                "Database access goes through the Database Service, the only " +
                "Prisma caller (SAD §12). The engine reads telemetry, not rows.",
            },
            GEOCODING_ZONE,
          ],
        },
      ],
    },
  },
  {
    // The pure half. Listed last so it wins over the module-wide object above,
    // which it deliberately restates and extends.
    files: ANALYTICS_PURE,
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            AUTH_ZONE,
            BROWSER_ZONE,
            AGENT_ZONE,
            {
              /**
               * Narrowed at Milestone 5D-2. The ban was `@/services/portal/*`
               * wholesale; it is now the two halves of the Portal module that
               * actually perform or reach I/O. normalizers.ts is deliberately
               * NOT among them: it is pure parsing that imports nothing but Zod,
               * so a pure analytics file may take its types and its parsers
               * without gaining a way to open a page.
               *
               * This is exactly the split telemetry.records.ts and
               * telemetry.reader.ts were separated into at Milestone 5B, applied
               * to the module on the other side of the engine. What matters is
               * not which directory a file sits in but whether importing it can
               * start a browser.
               */
              group: [
                "@/services/portal/portal.service",
                "@/services/portal/extractors/*",
                "@/services/database/telemetry.service",
                "@/services/database/telemetry.reader",
                "@/lib/prisma",
              ],
              message:
                "These modules are pure functions over data already in memory " +
                "(Milestone 5B). They import no module that performs I/O, which " +
                "is what lets them run against fixtures with no database and no " +
                "portal — the same boundary normalizers.ts holds.",
            },
            GEOCODING_ZONE,
          ],
        },
      ],
    },
  },
];

/* -------------------------------------------------------------------------- */
/*  Geocoding (Phase 3)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Reverse geocoding is a PRESENTATION enhancement, and this zone is what keeps
 * that true rather than aspirational.
 *
 * A coordinate is telemetry; the address above it is a third party's opinion
 * about that coordinate, fetched by the browser after a report has already
 * rendered. Nothing that produces an answer may depend on it — so the Analysis
 * Engine, the Portal Service, the Session Manager, the Database Service, the
 * tools and the agent must not import it, and it must not import them.
 *
 * The restriction runs in BOTH directions, for the same reason the
 * authentication zone does:
 *
 *   - INWARD, so a geocoding outage can never delay, alter or fail a telemetry
 *     answer, and so an address can never reach the model's context and be
 *     restated as though a vehicle had reported it.
 *   - OUTWARD, so this service cannot read a vehicle, a session or a row. It is
 *     handed two numbers by a route and returns two strings.
 */
const geocodingIsolation = [
  {
    files: ["src/services/geocoding/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            AUTH_ZONE,
            BROWSER_ZONE,
            AGENT_ZONE,
            {
              group: [
                "@/services/analytics/*",
                "@/services/database/*",
                "@/services/portal/*",
                "@/lib/prisma",
              ],
              message:
                "Reverse geocoding is a presentation enhancement (Phase 3). It " +
                "receives two numbers and returns a label; it reads no vehicle, " +
                "no session and no row.",
            },
            // Deliberately no GEOCODING_ZONE here: this IS the geocoding module,
            // and its own files must be able to import each other.
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
  ...analyticsIsolation,
  ...geocodingIsolation,
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
