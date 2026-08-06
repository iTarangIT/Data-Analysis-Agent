import { geocodingEnv } from "@/lib/env";
import { childLogger } from "@/lib/logger";
import type { Address } from "@/types/location";

import { normalizeAddress } from "./address";
import { geocodeCacheKey, getGeocodeCache, ttlFor } from "./cache";

/**
 * Reverse Geocoding Service (Phase 3).
 *
 * THE ONLY COMPONENT THAT TALKS TO A GEOCODING PROVIDER, and the only impure
 * file in this module — `address.ts` is pure parsing and `cache.ts` holds no
 * network. The split is the one the Portal Service already draws between its
 * extractors and its normalizers, for the same reason.
 *
 * ## What this service must never be able to do
 *
 * FAIL AN ANSWER. Reverse geocoding is a label on top of a value that is already
 * correct and already displayed. So `reverseGeocode` NEVER THROWS: a disabled
 * deployment, an invalid coordinate, a rate limit, a timeout, a provider outage
 * and a coordinate with no name all return `null`, and the caller renders the
 * coordinate exactly as it did before this feature existed.
 *
 * That is why there is no error type, no failure code and no retry. A retry would
 * be a second request for a label nobody is waiting on, against a provider whose
 * usage policy is one request per second.
 *
 * ## What it may not reach
 *
 * The Analysis Engine, the Portal Service, the Session Manager, the Database
 * Service, Prisma, the tools and the agent — none of them, in either direction.
 * A vehicle's position arrives here as two numbers from a client that already
 * rendered them; nothing in the data path knows this module exists. Enforced by
 * the Geocoding zone in eslint.config.mjs.
 */

const log = childLogger("geocoding");

/* -------------------------------------------------------------------------- */
/*  Input validation                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Whether two numbers describe a point on Earth.
 *
 * Rejects the out-of-range value that would otherwise be sent to a provider and
 * come back as a confident nothing, and — more usefully — rejects the exact-zero
 * pair. `0, 0` is Null Island: it is a real coordinate in the Gulf of Guinea and
 * is overwhelmingly the signature of an unset field rather than a vehicle, so
 * labelling it would put a plausible ocean address under a fleet vehicle.
 */
function isPlausibleCoordinate(lat: number, lon: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < -90 || lat > 90) return false;
  if (lon < -180 || lon > 180) return false;
  if (lat === 0 && lon === 0) return false;

  return true;
}

/* -------------------------------------------------------------------------- */
/*  Throttle                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Serialises provider calls and spaces them out.
 *
 * Nominatim's usage policy is at most one request per second from one source,
 * and exceeding it gets an IP blocked rather than throttled — so this is a
 * correctness requirement for the deployment, not a politeness. A fleet report
 * can hold several location cards, and without this they would all fire at once
 * on first render.
 *
 * The queue is a promise chain, the same shape the Session Manager uses to
 * serialise browser runs. Nothing here bounds the queue's LENGTH, because
 * everything entering it is already behind the cache: a coordinate asked for
 * twice joins the queue once.
 */
let queue: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;

function throttled<T>(run: () => Promise<T>): Promise<T> {
  const result = queue.then(async () => {
    const { GEOCODING_MIN_INTERVAL_MS } = geocodingEnv();
    const wait = lastCallAt + GEOCODING_MIN_INTERVAL_MS - Date.now();

    if (wait > 0) {
      await new Promise((resolve) => setTimeout(resolve, wait));
    }

    lastCallAt = Date.now();
    return run();
  });

  // `.catch` so one failed call cannot poison the chain for every later one —
  // the same reason `serialize()` in the Session Manager passes `run` to both
  // arms of `then`.
  queue = result.catch(() => undefined);

  return result;
}

/* -------------------------------------------------------------------------- */
/*  Provider                                                                  */
/* -------------------------------------------------------------------------- */

const PROVIDER = "bigdatacloud";

/**
 * Build the provider URL, in whichever of its two modes is configured.
 *
 * ## Two endpoints, one response schema
 *
 * BigDataCloud publishes the same reverse-geocode payload behind two paths, and
 * that shared schema is what makes this a URL decision rather than a second
 * provider implementation — `address.ts` reads both identically:
 *
 *   KEYLESS  /data/reverse-geocode-client   no credential, works immediately.
 *            The zero-configuration default, so a fresh clone resolves addresses
 *            with nothing set up.
 *
 *   KEYED    /data/reverse-geocode          used the moment GEOCODING_API_KEY is
 *            present. The endpoint BigDataCloud designates for server-to-server
 *            use, which is the right posture for production — the keyless path
 *            is named for client use, and while it answers a server perfectly
 *            well, a deployment should not rest on an endpoint whose name
 *            signals a different intent.
 *
 * Switching is therefore one environment variable and no code change.
 *
 * `localityLanguage=en` asks for English place names rather than the local
 * script, so the label matches the rest of the interface.
 */
function buildProviderUrl(lat: number, lon: number): string {
  const config = geocodingEnv();

  const path =
    config.GEOCODING_API_KEY === undefined
      ? "/data/reverse-geocode-client"
      : "/data/reverse-geocode";

  const query = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    localityLanguage: "en",
  });

  if (config.GEOCODING_API_KEY !== undefined) {
    query.set("key", config.GEOCODING_API_KEY);
  }

  return `${config.GEOCODING_BASE_URL}${path}?${query.toString()}`;
}

/**
 * One reverse lookup against the configured provider.
 *
 * The abort is a real ceiling on the call, not just on the waiting: `fetch`
 * honours the signal and releases the socket.
 */
async function fetchAddress(lat: number, lon: number): Promise<Address | null> {
  const config = geocodingEnv();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.GEOCODING_TIMEOUT_MS);

  try {
    const response = await fetch(buildProviderUrl(lat, lon), {
      signal: controller.signal,
      // Redirects are followed by default; stated so it is not mistaken for an
      // oversight. The provider answers the keyless path with a 307 on first
      // contact, and a client that did not follow it would see no data.
      redirect: "follow",
      headers: {
        // Identifies the caller. Not demanded by this provider, unlike the
        // previous one, but a service that can be contacted about its traffic
        // is a service that gets a warning rather than a block.
        "User-Agent": `Tarang/1.0 (${config.GEOCODING_CONTACT})`,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      // Includes 429. Logged at debug because a rate limit is an expected
      // operating condition for a best-effort label, not an incident.
      //
      // A refusal can also arrive as HTTP 200 carrying `{"status":403,...}` —
      // the keyed endpoint reports quota and credential problems in the body —
      // and `normalizeAddress` returns null for those, so both shapes of "no"
      // reach the caller the same way.
      log.debug({ status: response.status }, "Geocoding provider declined.");
      return null;
    }

    const lines = normalizeAddress(await response.json());
    if (lines === null) return null;

    return {
      primary: lines.primary,
      secondary: lines.secondary,
      provider: PROVIDER,
      resolvedAt: new Date().toISOString(),
    };
  } catch (error) {
    // A timeout, a DNS failure, a malformed body. All the same outcome: no
    // label. The coordinate was always the answer.
    log.debug({ err: error }, "Geocoding lookup failed.");
    return null;
  } finally {
    // Released whichever way the call settled; a stray timer would hold the
    // event loop open for the rest of the budget.
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/*  Public entry point                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Resolve one coordinate to a human-readable label, or to nothing.
 *
 * The route's only call. NEVER THROWS and never rejects — every failure is
 * `null`, because the caller's fallback is to render the coordinate it already
 * has.
 *
 * ## Order of operations, and why the cache comes before the throttle
 *
 * Configuration, then plausibility, then CACHE, then throttle, then provider. A
 * cached coordinate must not wait behind the one-per-second queue: on a report
 * holding several location cards for vehicles parked at the same depot, the
 * cache is what turns N lookups into one, and putting it after the throttle
 * would make every one of them pay the interval anyway.
 *
 * The result is cached whether or not a label was found — see `CachedLookup`.
 */
export async function reverseGeocode(
  lat: number,
  lon: number
): Promise<Address | null> {
  if (!geocodingEnv().GEOCODING_ENABLED) return null;
  if (!isPlausibleCoordinate(lat, lon)) return null;

  const key = geocodeCacheKey(lat, lon);
  const cache = getGeocodeCache();

  const cached = await cache.get(key);
  if (cached !== undefined) return cached.address;

  const address = await throttled(() => fetchAddress(lat, lon));

  await cache.set(key, {
    address,
    expiresAt: Date.now() + ttlFor(address),
  });

  return address;
}
