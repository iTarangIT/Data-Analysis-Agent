/**
 * Wire types for reverse geocoding (Phase 3).
 *
 * Dependency-free, exactly as src/types/chat.ts is and for the same reason: this
 * is the contract between /api/geocode and a CLIENT component, and importing the
 * geocoding service would pull `node:` APIs and a provider client into the
 * browser bundle.
 *
 * ## What an Address is, and what it is not
 *
 * IT IS A LABEL, NOT A MEASUREMENT. The coordinate is what a vehicle reported;
 * this is a third party's opinion about what that coordinate is near. The two are
 * never merged and the coordinate is never replaced — a reader always sees the
 * value the fleet actually produced, with the label above it.
 *
 * That is why `provider` and `resolvedAt` travel with it. A number in this system
 * carries the source that produced it; a derived label is held to the same rule,
 * so the UI can always say where the words came from and when.
 */

/** A position fix, as the telemetry reports it. */
export interface GeocodeCoordinates {
  lat: number;
  lon: number;
}

/**
 * A human-readable rendering of one coordinate.
 *
 * Two lines rather than a full postal address: a fleet manager reading a metric
 * card needs to place the vehicle, not to post a letter to it. `primary` is the
 * most specific meaningful name the provider offered ("Sector 62"), `secondary`
 * the context that disambiguates it ("Noida, Uttar Pradesh").
 *
 * BOTH ARE NULLABLE, INDEPENDENTLY. A provider may know the town and not the
 * neighbourhood, or the reverse. Whatever is missing is simply absent — never
 * filled with "Unknown", never guessed at from a neighbouring field.
 */
export interface Address {
  primary: string | null;
  secondary: string | null;
  /** Which service produced this label, e.g. "bigdatacloud". */
  provider: string;
  /** When the lookup ran, ISO 8601. */
  resolvedAt: string;
}

/**
 * What /api/geocode returns.
 *
 * `address: null` covers EVERY failure — provider down, rate limited, timed out,
 * disabled by configuration, invalid input, or a coordinate the provider simply
 * has no name for. The client treats them identically because the user-facing
 * outcome is identical: the coordinates render exactly as they did before this
 * feature existed.
 *
 * There is deliberately no `error` field and no non-2xx status for a failed
 * lookup. An error the UI is required to ignore is not an error, it is noise —
 * and a shape that carried one would invite a future component to render
 * "Failed to look up location" beside a perfectly good coordinate.
 */
export interface GeocodeResponse {
  address: Address | null;
}
