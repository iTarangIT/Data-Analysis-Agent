import type { Address } from "@/types/location";

/**
 * The reverse-geocoding cache (Phase 3).
 *
 * ## Async by design, so Redis is a swap and not a rewrite
 *
 * Every method returns a promise even though the shipped implementation is a
 * synchronous `Map`. That is the whole point: an in-process cache can answer
 * immediately, a shared one cannot, and a consumer written against a synchronous
 * interface would have to be rewritten the day the second one arrives. Paying
 * for one `await` now is what makes `setGeocodeCache(redisCache)` the entire
 * migration.
 *
 * The interface is deliberately two methods and no more. There is no `clear`, no
 * `size` and no iteration, because a Redis-backed implementation could not offer
 * them cheaply and an interface that cannot be honoured by its intended
 * implementation is not an interface.
 */

/**
 * One cached lookup.
 *
 * `address: null` is a CACHED NEGATIVE and is the reason this is an envelope
 * rather than a bare `Address`. A coordinate in the middle of a field has no
 * name, and without caching that outcome every render would ask again — turning
 * the one case the provider answers fastest into the one that costs the most
 * requests. Negatives get their own, shorter, TTL.
 */
export interface CachedLookup {
  address: Address | null;
  /** Epoch milliseconds after which this entry must not be served. */
  expiresAt: number;
}

export interface GeocodeCache {
  get(key: string): Promise<CachedLookup | undefined>;
  set(key: string, entry: CachedLookup): Promise<void>;
}

/* -------------------------------------------------------------------------- */
/*  Keys                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Decimal places a coordinate is rounded to before it becomes a cache key.
 *
 * FOUR, which is about 11 metres of latitude. Chosen against a measurement
 * rather than by taste: the Milestone 5D-1 calibration found consecutive GPS
 * fixes for a stationary vehicle scattering by up to 11.26 m, so a parked vehicle
 * produces a slightly different coordinate on every read. Keying on the raw value
 * would miss the cache every single time for exactly the vehicles that never
 * move — the ones a fleet looks at most.
 *
 * Rounding to a coarser grid would start merging genuinely different places; this
 * merges readings that are already indistinguishable from sensor noise. The
 * canonical coordinate is unaffected — it is never rounded, only the key is.
 */
const KEY_PRECISION = 4;

/**
 * The cache key for one coordinate.
 *
 * `toFixed` rather than arithmetic rounding so the key is a stable STRING with a
 * fixed shape — `25.4336,82.1091` — which is what a Redis key wants to be, and
 * which avoids `-0` and float formatting drift producing two keys for one place.
 */
export function geocodeCacheKey(lat: number, lon: number): string {
  // `+ 0` normalises -0 to 0, so a coordinate on the equator or the prime
  // meridian cannot produce two keys for one point.
  const round = (value: number) => (value + 0).toFixed(KEY_PRECISION);

  return `${round(lat)},${round(lon)}`;
}

/* -------------------------------------------------------------------------- */
/*  In-memory implementation                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How long a successful lookup is trusted.
 *
 * A day. Addresses are effectively static — a road does not get renamed while a
 * shift is running — so this is bounded by wanting to pick up provider
 * improvements eventually rather than by any risk of staleness.
 */
const HIT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How long a NO-RESULT is trusted.
 *
 * Ten minutes, far shorter than a hit, because a negative can mean two very
 * different things: a coordinate that genuinely has no name, and a provider that
 * was briefly unreachable. The short TTL is what stops a transient outage from
 * suppressing addresses for a whole day, while still absorbing the burst of
 * repeat lookups a single render pass would otherwise produce.
 */
const MISS_TTL_MS = 10 * 60 * 1000;

export function ttlFor(address: Address | null): number {
  return address === null ? MISS_TTL_MS : HIT_TTL_MS;
}

/**
 * How many entries the in-process cache holds.
 *
 * A ceiling, because this map lives for the life of the server process and a
 * fleet that roams would otherwise grow it without bound. Two thousand entries
 * is far more than a depot-based fleet visits and is a few hundred kilobytes.
 */
const MAX_ENTRIES = 2000;

/**
 * The default cache: in-process, TTL'd, and bounded.
 *
 * Eviction is INSERTION-ORDERED rather than least-recently-used. `Map` preserves
 * insertion order, so dropping the oldest key is one line and needs no
 * bookkeeping on read; true LRU would mean touching the map on every hit, which
 * is a cost paid on the common path to improve the rare one. For a cache whose
 * keys are depots visited over and over, the difference is not measurable.
 */
class MemoryGeocodeCache implements GeocodeCache {
  private readonly entries = new Map<string, CachedLookup>();

  async get(key: string): Promise<CachedLookup | undefined> {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;

    if (entry.expiresAt <= Date.now()) {
      // Dropped on read rather than swept on a timer: an expired entry costs
      // nothing until someone asks for it, and a timer would hold the event loop
      // open in a short-lived process.
      this.entries.delete(key);
      return undefined;
    }

    return entry;
  }

  async set(key: string, entry: CachedLookup): Promise<void> {
    // Delete-then-set so a refreshed key moves to the end of the insertion
    // order and is not evicted as though it were old.
    this.entries.delete(key);
    this.entries.set(key, entry);

    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
  }
}

/**
 * The cache the service uses.
 *
 * A module-level singleton for the same reason the Prisma client and the
 * Playwright browser are: one per process, reused across requests. In
 * development Next.js re-evaluates modules on edit, so the cache resets — which
 * is correct, and never wrong, only colder.
 */
let cache: GeocodeCache = new MemoryGeocodeCache();

export function getGeocodeCache(): GeocodeCache {
  return cache;
}

/**
 * Replace the cache implementation.
 *
 * The seam a Redis-backed cache slots into: implement two methods, call this
 * once at startup, and no consumer changes. Exported for that reason and used by
 * nothing today — which is why it is a function rather than a mutable export, so
 * the swap is an explicit act at a known moment rather than an assignment from
 * anywhere.
 */
export function setGeocodeCache(next: GeocodeCache): void {
  cache = next;
}
