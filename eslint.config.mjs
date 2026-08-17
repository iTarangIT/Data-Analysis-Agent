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
 * Long-term memory, forbidden to everything that produces an answer (Phase 4C).
 *
 * NOTHING IS IMPLEMENTED BEHIND THIS RULE YET, and that is the point.
 * `src/services/memory/` does not exist: long-term memory is planned for Phase
 * 4E and blocked on the authenticated identity Phase 4D adds, because an owner
 * the server cannot verify is a query parameter rather than an owner (SAD §7).
 *
 * The boundary is declared FIRST, deliberately. It is the one part of the
 * memory design that can be enforced before the code it constrains is written,
 * so the first line of that code cannot be put in the wrong layer — by a later
 * milestone, or by someone who never read §7. A rule whose `files` pattern
 * matches nothing costs nothing and breaks nothing; it simply waits.
 *
 * Added to each existing zone's own pattern list rather than declared as a zone
 * object of its own, exactly as GEOCODING_ZONE is, and for the same
 * load-bearing reason: flat config does not merge rules across matching objects
 * — the last match wins outright — so a later object listing these same paths
 * would silently REPLACE their whole restriction set and disable every
 * authentication and browser rule in this file.
 *
 * The agent zone needs no entry: it already bans `@/services/*` wholesale.
 */
const MEMORY_ZONE = {
  group: ["@/services/memory/*", "@/services/memory/**"],
  message:
    "Long-term memory is user-owned data, read BESIDE the agent and never " +
    "beneath it (Phase 4C, SAD §7). The Analysis Engine, Planner, Tool " +
    "Registry, tools, Portal Service, Session Manager and telemetry services " +
    "must not know it exists: a stored preference must never be able to change " +
    "a computation, and no layer the model can reach may gain a path that " +
    "could WRITE one. Memory is retrieved by the Route Handler and reaches the " +
    "model through the prompt seam, exactly as the Phase 4A run context does.",
};

/**
 * Application identity, forbidden to everything beneath the route layer
 * (SAD §10, Phase 4D).
 *
 * `src/services/identity/` answers "WHO MAY USE TARANG". It is not
 * `src/services/session/`, which answers "how does Tarang reach Intellicar" —
 * SAD §10 keeps those two domains apart, and this rule is part of how that
 * separation is enforced rather than merely described.
 *
 * Nothing that produces an ANSWER may read the current user. A telemetry
 * figure, a reconciliation and a report must be identical whoever asked for
 * them, and a layer that could see the principal is a layer that could start
 * varying by it. Identity is read once, by the Route Handler, and never
 * consulted again.
 *
 * Added to each existing zone's pattern list rather than declared as its own
 * object, for the reason GEOCODING_ZONE and MEMORY_ZONE already are: flat
 * config does not merge rules across matching objects.
 *
 * The agent zone needs no entry — it bans `@/services/**` wholesale. The memory
 * zone deliberately gets none either: Phase 4E's memory service takes an
 * `OwnerId`, which is DEFINED here, so memory depends on identity and not the
 * reverse. That one-way arrow is the intended shape.
 */
const IDENTITY_ZONE = {
  group: ["@/services/identity/*", "@/services/identity/**"],
  message:
    "Application identity is read by the Route Handler and by nothing beneath " +
    "it (SAD §10, Phase 4D). The Analysis Engine, Planner, Tool Registry, " +
    "tools, Portal Service, Session Manager and telemetry services must not " +
    "know who is asking: an answer must not be able to vary by user. Note also " +
    "that this is NOT the Intellicar session — that is @/services/session, a " +
    "different domain with a different key and a different subject.",
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
            MEMORY_ZONE,

            IDENTITY_ZONE,
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
            {
              /**
               * The APPLICATION half reaches PostgreSQL only through Prisma
               * (SAD §12). A raw driver here would be a second, unmanaged path
               * to the same database, bypassing the singleton client of rule 4
               * and the migration history that defines its schema.
               *
               * The IoT half is exempt — see the `iot.*.ts` block below, which
               * replaces this rule for those files. The exemption is the whole
               * point: one client each, and neither crosses.
               */
              group: ["pg", "pg-pool", "postgres", "knex", "drizzle-orm"],
              message:
                "The application database is reached ONLY through Prisma " +
                "(SAD §12, CLAUDE.md rule 4). A raw driver belongs to the IoT " +
                "half, in iot.pool.ts, which is exempt from this rule.",
            },
            GEOCODING_ZONE,
            MEMORY_ZONE,

            IDENTITY_ZONE,
          ],
        },
      ],
    },
  },
  {
    /**
     * The IoT half of the Database Service — KEPT APART FROM PRISMA IN BOTH
     * DIRECTIONS (IoT integration, SAD §12).
     *
     * These files read a database another team owns, under a read-only role,
     * with no Prisma model and no migration. Importing Prisma here would be the
     * first step toward modelling their schema in ours, which §19 rejects
     * outright; and it would put a client that CAN write inside the one module
     * whose whole guarantee is that it cannot.
     *
     * The reverse ban is in the block above: no other file under
     * `src/services/database/**` may import `pg`. So the application database is
     * reached only through Prisma and the IoT database only through the pool —
     * one client each, no crossing.
     *
     * THE BASE ZONES ARE REPEATED BELOW ON PURPOSE. Flat config REPLACES a rule
     * rather than merging it, so a block that listed only the two new patterns
     * would silently drop AUTH_ZONE, BROWSER_ZONE and the rest for exactly the
     * files that handle a database credential — the opposite of what this block
     * is for.
     */
    files: ["src/services/database/iot.*.ts"],
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
            MEMORY_ZONE,
            IDENTITY_ZONE,
            {
              group: ["@prisma/client", "@/lib/prisma", "@/generated/prisma/*"],
              message:
                "The IoT Database Service must never touch Prisma (SAD §12, " +
                "§19). It reads a database the IoT platform team owns, under a " +
                "read-only role, with no model and no migration of ours — and a " +
                "Prisma client is one that can write. The two databases share a " +
                "folder and nothing else.",
            },
            {
              group: [
                "@/services/database/telemetry.service",
                "@/services/database/telemetry.reader",
              ],
              message:
                "The IoT reads and the application-database reads are separate " +
                "sources that disagree about which vehicles exist (SAD §19). " +
                "Reconciling them is the Analysis Engine's job, not a shortcut " +
                "taken inside one of them.",
            },
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
      "no-restricted-imports": [
        "error",
        { patterns: [AUTH_ZONE, BROWSER_ZONE, GEOCODING_ZONE, MEMORY_ZONE, IDENTITY_ZONE] },
      ],
    },
  },
  {
    /**
     * The agent core, including the Tool Registry, which stays DEPENDENCY-FREE:
     * it knows tool specs and the result envelope, and no service at all. A
     * service reached from here would put infrastructure behind the one wrapper
     * every tool passes through, and the registry's job is to be the place that
     * cannot be skipped — not the place that does the work.
     *
     * This zone needs no MEMORY_ZONE entry: the wholesale `@/services/**` ban
     * below already covers `@/services/memory/**`, which is exactly why
     * GEOCODING_ZONE is absent here too. The agent reads long-term memory the
     * same way it reads the Phase 4A run context — as a value the Route Handler
     * hands it through `configurable`, never as a module it imports.
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
            MEMORY_ZONE,

            IDENTITY_ZONE,
          ],
        },
      ],
    },
  },
  {
    // The Portal Service: authentication IS its dependency; the data path is not.
    files: [PORTAL_SERVICE],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [DATA_ZONE, GEOCODING_ZONE, MEMORY_ZONE, IDENTITY_ZONE] },
      ],
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
            MEMORY_ZONE,

            IDENTITY_ZONE,
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
            MEMORY_ZONE,

            IDENTITY_ZONE,
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
                /**
                 * The IoT halves that perform I/O, banned for exactly the
                 * reason their Prisma counterparts above are — and by the same
                 * test, which is whether importing the module can open a
                 * connection rather than which directory it sits in.
                 *
                 * `iot.records` and `iot.queries` are deliberately NOT here.
                 * The first is shapes and conversions, the second is SQL text;
                 * neither imports anything that performs I/O, so a pure
                 * analytics file may take an IoT record type without gaining a
                 * way to reach the database. That is the same split
                 * telemetry.records/telemetry.reader hold, and the same one
                 * normalizers.ts holds on the portal side.
                 */
                "@/services/database/iot.pool",
                "@/services/database/iot.reader",
                "@/lib/prisma",
                "pg",
              ],
              message:
                "These modules are pure functions over data already in memory " +
                "(Milestone 5B). They import no module that performs I/O, which " +
                "is what lets them run against fixtures with no database and no " +
                "portal — the same boundary normalizers.ts holds.",
            },
            GEOCODING_ZONE,
            MEMORY_ZONE,

            IDENTITY_ZONE,
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
            MEMORY_ZONE,

            IDENTITY_ZONE,
            // Deliberately no GEOCODING_ZONE here: this IS the geocoding module,
            // and its own files must be able to import each other.
          ],
        },
      ],
    },
  },
];

/* -------------------------------------------------------------------------- */
/*  Long-term memory (SAD §7, Phase 4C)                                       */
/* -------------------------------------------------------------------------- */

/**
 * THE BOUNDARY EXISTS BEFORE THE CODE DOES.
 *
 * `src/services/memory/` is NOT IMPLEMENTED. This object matches no file today
 * and is expected to: long-term memory is blocked on the authenticated identity
 * Phase 4D adds, and lands in Phase 4E. Declaring the zone now is the whole
 * deliverable of Phase 4C — the first line of memory code will be written
 * against a boundary that already refuses the wrong dependencies, instead of a
 * boundary added afterwards once something already crossed it.
 *
 * The restriction runs in BOTH directions, as every other zone in this file
 * does. MEMORY_ZONE above is the inward half — nothing that produces an answer
 * may import memory. This is the outward half: memory reads a table and returns
 * typed preferences, and reaches for nothing else.
 *
 *   - NOT authentication or a browser. Memory is user-owned data, not a
 *     credential and not a session (CLAUDE.md rule 1 is unaffected by it).
 *   - NOT the Analysis Engine, the Portal Service or the Database Service. A
 *     preference must never be able to reach a computation or a live read; if
 *     a stored value needs checking against the fleet, the ROUTE does it and
 *     hands memory an already-validated value, exactly as the route already
 *     owns validation for the Phase 4A run context.
 *   - NOT the tool or agent layer. Memory is consumed BY the Route Handler and
 *     consumes none of them; it does not know the result envelope exists.
 *   - NOT geocoding, which is presentation and has no business reading a user's
 *     stored preferences.
 *
 * `@/lib/prisma` is DELIBERATELY NOT BANNED, and it is the one place this zone
 * differs from the analytics zone beside it. SAD §12's "the Database Service is
 * the only Prisma caller" is a statement about the TELEMETRY path; memory is a
 * different domain with its own table, and routing its reads through a
 * telemetry service would make that service know what a preference is. The rule
 * that will matter instead is narrower and belongs to Phase 4E: `memoryEntry`
 * may be referenced in exactly one file.
 */
const memoryIsolation = [
  {
    files: ["src/services/memory/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            AUTH_ZONE,
            BROWSER_ZONE,
            AGENT_ZONE,
            ANALYTICS_ZONE,
            {
              group: [
                "@/services/portal/*",
                "@/services/portal/**",
                "@/services/database/*",
                "@/services/database/**",
              ],
              message:
                "Long-term memory stores what a user PREFERS, never what the " +
                "fleet MEASURES (SAD §7, Phase 4C). It reads no vehicle, no " +
                "telemetry row and no dashboard: PostgreSQL and Intellicar " +
                "remain the authoritative sources, and a preference that could " +
                "read them would be the first step toward one that caches them.",
            },
            GEOCODING_ZONE,
            // Deliberately no MEMORY_ZONE here: this IS the memory module, and
            // its own files must be able to import each other — the same
            // exemption the geocoding zone above carries for the same reason.
          ],
        },
      ],
    },
  },
];

/* -------------------------------------------------------------------------- */
/*  Application identity (SAD §10, Phase 4D)                                  */
/* -------------------------------------------------------------------------- */

/**
 * The outward half of IDENTITY_ZONE.
 *
 * `src/services/identity/` proves A PERSON to TARANG. It reads a cookie, opens
 * a sealed blob and returns a user id. That is all it does, and this rule is
 * what keeps it that small.
 *
 * THE MOST IMPORTANT BAN HERE IS `@/services/session/*`. The two modules have
 * confusingly similar names and completely different subjects: the Session
 * Manager holds a Playwright storageState proving TARANG to INTELLICAR — one
 * blob for the whole deployment, never sent to a browser, not a person. SAD §10
 * says the two domains never mix; an import between them would be the first
 * step to treating an Intellicar session as an application login, which is
 * precisely the confusion Phase 4D exists to prevent.
 *
 * `@/services/credentials/crypto` is DELIBERATELY PERMITTED while
 * `credential-manager` is banned, and the split is exact rather than
 * convenient. The crypto module's own header states it "has no idea what it is
 * protecting" and that its purpose-bound AAD exists so a sealed session cannot
 * be opened as a sealed credential "once this module has two callers" — this is
 * that second caller, and it is the use the module was written for. The
 * Credential Manager, by contrast, is Intellicar's and is banned with the rest
 * of that domain.
 *
 * Everything else follows the shape every other zone has: identity consumes no
 * provider, no tool and no agent. It is consumed BY a Route Handler.
 */
const identityIsolation = [
  {
    files: ["src/services/identity/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            BROWSER_ZONE,
            AGENT_ZONE,
            ANALYTICS_ZONE,
            {
              group: [
                "@/services/session/*",
                "@/services/session/**",
                "@/services/credentials/credential-manager",
              ],
              message:
                "Application identity is NOT the Intellicar session (SAD §10, " +
                "Phase 4D). @/services/session proves Tarang to Intellicar with " +
                "a Playwright storageState; this module proves a person to " +
                "Tarang with a sealed cookie. Different subject, different key, " +
                "different lifetime — and they never mix. Only the generic " +
                "@/services/credentials/crypto is shared, which is the second " +
                "caller its purpose-bound AAD was written for.",
            },
            {
              group: [
                "@/services/portal/*",
                "@/services/portal/**",
                "@/services/database/*",
                "@/services/database/**",
                "@/lib/prisma",
              ],
              message:
                "Identity reads a cookie and returns a user id (Phase 4D). It " +
                "touches no vehicle, no telemetry row, no dashboard and no " +
                "database — Phase 4D deliberately has ZERO Prisma dependency, " +
                "exactly as Milestone 3 authentication did.",
            },
            GEOCODING_ZONE,
            MEMORY_ZONE,
            // Deliberately no IDENTITY_ZONE: this IS the identity module, and
            // its own files must import each other — the same exemption the
            // geocoding and memory zones carry, for the same reason.
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
  ...memoryIsolation,
  ...identityIsolation,
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
