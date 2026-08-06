import type { Address } from "@/types/location";

/**
 * The Location Formatter (Phase 3).
 *
 * PURE. It takes a coordinate and, when one is available, a label, and decides
 * what lines the card renders. It performs no lookup, holds no state and knows
 * nothing about how a label is obtained — the reverse geocoder sits below it,
 * and this sits between it and the card.
 *
 * ## The single rule
 *
 * THE COORDINATE IS ALWAYS RETURNED. There is no branch of this function that
 * omits it, which is what makes "never replace, never discard" a property of the
 * type rather than a discipline every caller has to remember: `coordinates` is
 * non-nullable, so a component physically cannot render a location without it.
 *
 * An absent label is simply an empty `addressLines`. Nothing here ever produces
 * "Unknown", "N/A" or a failure string — an answer must never become less
 * informative because a third party was slow.
 */

export interface LocationDisplay {
  /**
   * Human-readable lines, most specific first. EMPTY when no label is available,
   * for any reason — not yet fetched, provider down, or a coordinate with no
   * name. The three are indistinguishable here on purpose: they render the same.
   */
  addressLines: string[];
  /** The canonical value. Always present, never abbreviated. */
  coordinates: string;
}

/**
 * How a coordinate is written out.
 *
 * Six decimal places is the precision `last_known_location` declares in the
 * quantity registry, and it is applied here rather than trimmed: this is the
 * canonical value, so it is shown at the resolution the engine reports it at.
 *
 * Trailing zeros are kept, unlike everywhere else in this UI. A coordinate is
 * read as a fixed-width pair — two of them are compared column by column — and
 * `25.4` beside `82.109069` reads as a different KIND of number rather than the
 * same number with fewer digits.
 */
function formatCoordinatePair(lat: number, lon: number): string {
  return `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
}

/**
 * Decide what one location card shows.
 *
 * The three cases the UX specifies fall out of one rule — take whichever label
 * lines exist, in order — rather than needing a branch each:
 *
 *   full     ["Sector 62", "Noida, Uttar Pradesh"]  + coordinates
 *   partial  ["Noida", "Uttar Pradesh"]             + coordinates
 *   none     []                                     + coordinates
 *
 * The partial case is already handled upstream, where the normalizer promotes a
 * settlement to the primary line when no more specific name exists — so this
 * function never has to reason about which line is missing, only about which are
 * present.
 */
export function formatLocation(
  lat: number,
  lon: number,
  address: Address | null | undefined
): LocationDisplay {
  const coordinates = formatCoordinatePair(lat, lon);

  if (!address) return { addressLines: [], coordinates };

  const addressLines = [address.primary, address.secondary].filter(
    (line): line is string => typeof line === "string" && line.trim().length > 0
  );

  return { addressLines, coordinates };
}
