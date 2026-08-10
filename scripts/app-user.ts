import { register } from "node:module";

import { config as loadDotenv } from "dotenv";

/**
 * Mint an APP_USERS record (SAD §10, Phase 4D).
 *
 *   npm run app:user -- alice
 *
 * Prompts for a password, prints the `name:hash` record to paste into
 * APP_USERS, and exits. Without this there is no way to configure a user at
 * all: APP_USERS holds scrypt hashes, and a hash cannot be written by hand.
 *
 * ## Why it imports the real hasher rather than reimplementing scrypt
 *
 * The hash FORMAT is a contract between whatever writes a record and the
 * verifier that reads it. A second implementation here would be free to drift
 * from `users.ts`, and the failure mode of that drift is "nobody can sign in",
 * discovered in production. So this calls the same `hashPassword` the
 * application would.
 *
 * That also means the record this prints is `scrypt.N.r.p.salt.hash` —
 * DOT-delimited, not the `$` every other scrypt/PHC string uses. The reason
 * lives with `HASH_SEPARATOR` in users.ts and is worth reading before anyone
 * "corrects" it: `.env` files interpolate, and `@next/env` expanded each `$…`
 * segment to nothing, so a correct record on disk reached the application
 * gutted and every sign-in failed as "invalid username or password".
 *
 * ## Deliberately outside the architecture
 *
 * Scaffolding, exactly as scripts/auth-login.ts is: no route, no tool, no
 * registry entry, and no application code imports it.
 *
 * THE PASSWORD IS NEVER ECHOED, never written to a file, and never logged — it
 * is read from a hidden prompt and passed straight to the hasher. Only the
 * resulting record is printed, and a hash is safe to paste into configuration.
 *
 * The dynamic import below exists for the reason auth-login.ts documents: the
 * `@/*` alias must be resolvable before the module loads, and a static import
 * would hoist above `register`.
 */

loadDotenv({ path: ".env.local", quiet: true });
register("./alias-loader.mjs", import.meta.url);

const { hashPassword } = await import("@/services/identity/users");

/** Read a line without echoing it, so a password never reaches the scrollback. */
function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);

    const { stdin } = process;
    const wasRaw = stdin.isTTY ? stdin.isRaw : false;

    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let value = "";

    let settled = false;

    const done = (error?: Error) => {
      if (settled) return;
      settled = true;

      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolve(value);
    };

    /**
     * Piped input that ends without a newline — `printf 'secret' | ...`, or a
     * password manager writing to stdin. Without this the promise never
     * settles and the process hangs holding an unfinished prompt.
     */
    const onEnd = () => done();

    const onData = (chunk: string) => {
      for (const char of chunk) {
        // Enter — the password is complete.
        if (char === "\n" || char === "\r") return done();
        // Ctrl-C — abort without printing anything.
        if (char === "") return done(new Error("Cancelled."));
        // Backspace / delete.
        if (char === "" || char === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += char;
      }
    };

    stdin.on("data", onData);
    stdin.on("end", onEnd);
  });
}

const username = process.argv[2]?.trim();

if (!username) {
  console.error("Usage: npm run app:user -- <username>");
  process.exit(1);
}

// The separators APP_USERS parses on. A name containing either would produce a
// record that silently splits into nonsense, so it is refused here rather than
// dropped later.
if (username.includes(":") || username.includes(";")) {
  console.error("A username may not contain ':' or ';'.");
  process.exit(1);
}

const password = await readSecret(`Password for "${username}": `);

if (password.length === 0) {
  console.error("The password was empty.");
  process.exit(1);
}

const hash = await hashPassword(password);

console.log("\nAdd this to APP_USERS in .env.local (separate records with ';'):\n");
console.log(`${username}:${hash}\n`);
