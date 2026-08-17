import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createConnection } from "node:net";

import { config as loadDotenv } from "dotenv";

/**
 * SSH tunnel to the IoT database (docs/IOT-DATABASE.md §5).
 *
 *   npm run tunnel
 *
 * Opens `127.0.0.1:5500` as the local end of a forward to the RDS instance
 * through the bastion, and stays in the foreground until interrupted.
 *
 *   127.0.0.1:5500  →  SSH tunnel  →  bastion  →  AWS RDS  →  itarang
 *
 * ## THE APPLICATION NEVER RUNS THIS
 *
 * Nothing under src/ spawns ssh, supervises a tunnel, or reads a private key.
 * This is a developer convenience that happens to live in the repo, with the
 * same standing as scripts/auth-login.ts: no route, no tool, no registry entry,
 * and no application code imports it. Keeping the key outside the Node process
 * entirely is the point — `iot.pool.ts` only ever DETECTS that port 5500 is not
 * answering and says so.
 *
 * ## Why these three ssh options are not optional
 *
 *   ServerAliveInterval=30 + ServerAliveCountMax=3
 *     A tunnel whose far end has died otherwise looks alive to the local
 *     socket, so `pg` connects, hangs, and eventually fails with something
 *     unrelated to the real cause. Ninety seconds to a clean exit is far more
 *     diagnosable than a pooled connection stuck until the OS gives up.
 *
 *   ExitOnForwardFailure=yes
 *     THE LOAD-BEARING ONE. Without it ssh authenticates happily when port 5500
 *     is already bound, reports success, and forwards nothing — so you get a
 *     tunnel that is up and a database that is unreachable, which is the single
 *     most confusing state this setup can be in.
 *
 * ## Output policy
 *
 * Prints the host, the user, the local port and ssh's own stderr. NEVER the key
 * file's contents, and never the database connection string — this script does
 * not read `IOT_AGENT_DATABASE_URL` at all.
 */

loadDotenv({ path: ".env.local", quiet: true });

const LOCAL_PORT = Number(process.env.IOT_TUNNEL_LOCAL_PORT ?? 5500);

const required = {
  IOT_BASTION_HOST: process.env.IOT_BASTION_HOST,
  IOT_BASTION_USER: process.env.IOT_BASTION_USER,
  IOT_BASTION_KEY: process.env.IOT_BASTION_KEY,
  IOT_RDS_ENDPOINT: process.env.IOT_RDS_ENDPOINT,
};

const missing = Object.entries(required)
  .filter(([, value]) => value === undefined || value === "")
  .map(([name]) => name);

if (missing.length > 0) {
  console.error(
    `Cannot open the tunnel — these variables are not set in .env.local:\n` +
      missing.map((name) => `  - ${name}`).join("\n") +
      `\n\n` +
      `  IOT_BASTION_HOST      the bastion's address (e.g. 3.111.53.81)\n` +
      `  IOT_BASTION_USER      the ssh user on the bastion\n` +
      `  IOT_BASTION_KEY       path to the private key file\n` +
      `  IOT_RDS_ENDPOINT      the RDS hostname the bastion forwards to\n\n` +
      `See docs/IOT-DATABASE.md §5.`
  );
  process.exit(1);
}

if (!existsSync(required.IOT_BASTION_KEY)) {
  console.error(
    `IOT_BASTION_KEY points at a file that does not exist: ${required.IOT_BASTION_KEY}`
  );
  process.exit(1);
}

/**
 * Refuse to start if the port is already bound.
 *
 * `ExitOnForwardFailure` already makes ssh fail in this case, but it fails with
 * a message about the forward rather than about the cause. Checking first turns
 * that into one sentence naming the port and the likely reason, which is the
 * difference between a five-second fix and a puzzled ten minutes.
 */
function portIsBound(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const settle = (bound) => {
      socket.destroy();
      resolve(bound);
    };
    socket.setTimeout(1_000);
    socket.once("connect", () => settle(true));
    socket.once("timeout", () => settle(false));
    socket.once("error", () => settle(false));
  });
}

if (await portIsBound(LOCAL_PORT)) {
  console.error(
    `127.0.0.1:${LOCAL_PORT} is already accepting connections — a tunnel is ` +
      `probably already open. Verify it with:\n\n` +
      `  psql "$IOT_AGENT_DATABASE_URL" -c "select current_user"\n\n` +
      `and close the existing tunnel before starting another.`
  );
  process.exit(1);
}

const args = [
  "-N",
  "-L",
  `${LOCAL_PORT}:${required.IOT_RDS_ENDPOINT}:5432`,
  "-o",
  "ServerAliveInterval=30",
  "-o",
  "ServerAliveCountMax=3",
  "-o",
  "ExitOnForwardFailure=yes",
  "-i",
  required.IOT_BASTION_KEY,
  `${required.IOT_BASTION_USER}@${required.IOT_BASTION_HOST}`,
];

console.log(
  `Opening tunnel  127.0.0.1:${LOCAL_PORT}  →  ${required.IOT_BASTION_USER}@${required.IOT_BASTION_HOST}  →  ${required.IOT_RDS_ENDPOINT}:5432`
);
console.log(`Verify with:  npm run iot:check\nStop with:    Ctrl-C\n`);

const ssh = spawn("ssh", args, { stdio: ["ignore", "inherit", "inherit"] });

ssh.on("error", (error) => {
  console.error(`Could not start ssh: ${error.message}`);
  process.exit(1);
});

ssh.on("exit", (code, signal) => {
  if (signal !== null) {
    console.log(`\nTunnel closed (${signal}).`);
    process.exit(0);
  }
  console.log(`\nTunnel closed (ssh exited with code ${code}).`);
  process.exit(code ?? 0);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => ssh.kill(signal));
}
