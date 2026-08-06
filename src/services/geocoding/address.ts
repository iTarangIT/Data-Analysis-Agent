import { z } from "zod";

/**
 * Address normalization (Phase 3).
 *
 * PURE PARSING, AND NOTHING ELSE — the same boundary, drawn for the same reason,
 * as src/services/portal/normalizers.ts. It performs no I/O, opens no socket,
 * reads no clock and holds no state: given the same provider payload it returns
 * the same address for ever, so it is reviewable by reading it and testable from
 * a captured response with no network.
 *
 * Everything hard about geocoding — a third party, a timeout, a cache — lives on
 * the other side of this file, in geocoder.service.ts. Keeping the two apart is
 * what makes "the provider changed its schema" and "we parsed it wrong"
 * different bugs with different fixes.
 *
 * ## The rule this module exists to enforce
 *
 * NEVER INVENT A PLACE. A field the provider did not send is absent, not guessed
 * at from a neighbouring one and never filled with a placeholder. If nothing
 * usable came back, the result is `null` and the caller shows the coordinate —
 * which is the true, canonical answer that was there all along.
 *
 * ## Provider: BigDataCloud
 *
 * Chosen after the OpenStreetMap public Nominatim instance was measured
 * returning `HTTP 403 Access denied` from a data-centre network — the same
 * condition a Railway deployment meets — which made the previous provider
 * architecturally fine and operationally dead.
 *
 * BigDataCloud answers from a data-centre IP, needs no credential, and returns a
 * STRUCTURED ADMINISTRATIVE HIERARCHY rather than the nearest map object. That
 * last point is what decided it for this fleet: a rural coordinate resolves to
 * its town and district instead of to whichever building happens to be closest.
 */

/* -------------------------------------------------------------------------- */
/*  Provider payload                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The subset of BigDataCloud's reverse-geocode response this reader uses.
 *
 * PERMISSIVE BY DESIGN. Every field is optional and unknown keys are ignored, so
 * a provider that adds a field cannot break a label. `status` is accepted
 * because the KEYED endpoint reports refusals in the BODY — `{"status":403,
 * "description":"access denied or your quota limit has been exceeded"}` — rather
 * than by shape, and that must be read as "no result" instead of parsed as a
 * place.
 *
 * `localityInfo.administrative` is the ranked hierarchy the country, state,
 * district and town all arrive in, each tagged with an `adminLevel`. It is the
 * reason this provider suits a fleet operating outside city centres.
 */
const bigDataCloudSchema = z.object({
  /** Present only on an error payload from the keyed endpoint. */
  status: z.number().optional(),
  description: z.string().optional(),

  locality: z.string().optional(),
  city: z.string().optional(),
  principalSubdivision: z.string().optional(),
  countryName: z.string().optional(),

  localityInfo: z
    .object({
      administrative: z
        .array(
          z.object({
            name: z.string().optional(),
            /** OSM-style level: 2 country, 4 state, 5 district, 6 town. */
            adminLevel: z.number().optional(),
          })
        )
        .optional(),
    })
    .optional(),
});

export type BigDataCloudResponse = z.infer<typeof bigDataCloudSchema>;

/* -------------------------------------------------------------------------- */
/*  Field selection                                                           */
/* -------------------------------------------------------------------------- */

/** Administrative level of a district — the line between a town and a state. */
const DISTRICT_LEVEL = 5;

/** Administrative level of a town or municipality. */
const TOWN_LEVEL = 6;

/**
 * Strip an administrative suffix from a place name.
 *
 * BigDataCloud reports the district as "Prayagraj district" and the sub-district
 * as "Handia tehsil", which are the correct FORMAL names and the wrong thing to
 * put on a card: a fleet manager reads "Prayagraj", and "Prayagraj district"
 * beside "Uttar Pradesh" reads like a form field rather than a place.
 *
 * Only a trailing administrative word is removed, so a place whose actual name
 * contains one is untouched.
 */
function stripAdministrativeSuffix(name: string): string {
  return name.trim().replace(/\s+(district|tehsil|taluk|taluka|division)$/i, "");
}

/** A trimmed non-empty string, or null. Whitespace-only counts as absent. */
function clean(value: string | undefined): string | null {
  if (typeof value !== "string") return null;

  const trimmed = stripAdministrativeSuffix(value);
  return trimmed.length > 0 ? trimmed : null;
}

/** One entry of the provider's ranked administrative hierarchy. */
type AdministrativeEntry = { name?: string; adminLevel?: number };

/** The name at one administrative level, or null. */
function atLevel(
  administrative: AdministrativeEntry[] | undefined,
  level: number
): string | null {
  if (!Array.isArray(administrative)) return null;

  const entry = administrative.find(
    (candidate) => candidate.adminLevel === level
  );

  return entry === undefined ? null : clean(entry.name);
}

/* -------------------------------------------------------------------------- */
/*  Normalization                                                             */
/* -------------------------------------------------------------------------- */

/** The two lines an address renders as, before provenance is attached. */
export interface AddressLines {
  primary: string | null;
  secondary: string | null;
}

/**
 * Turn one provider payload into two display lines, or null.
 *
 * ## How the two lines are chosen
 *
 * The SPECIFIC name goes on top and the context below, so the eye reaches the
 * distinguishing part first:
 *
 *   Handia                    <- primary   (locality / city / town)
 *   Prayagraj, Uttar Pradesh  <- secondary (district, state)
 *
 * When a broader field REPEATS the primary it is dropped rather than printed
 * twice — a city-state resolves to "New Delhi / Delhi" and not
 * "New Delhi / New Delhi, Delhi", and a coordinate that only resolves to a state
 * shows that state once. This is the partial case the UX calls for, and it falls
 * out of the de-duplication rather than needing a second code path.
 *
 * Returns null when nothing usable came back at all — an error body, an empty
 * response, or a point the provider has no name for. The caller then shows the
 * coordinate, which was always the canonical value.
 */
export function normalizeAddress(payload: unknown): AddressLines | null {
  const parsed = bigDataCloudSchema.safeParse(payload);

  if (!parsed.success) return null;

  const data = parsed.data;

  // The keyed endpoint reports a refusal in the body with HTTP 200-shaped JSON.
  // Anything carrying a status is a refusal, never a place.
  if (data.status !== undefined) return null;

  const administrative = data.localityInfo?.administrative;

  const town = atLevel(administrative, TOWN_LEVEL);
  const district = atLevel(administrative, DISTRICT_LEVEL);
  const region = clean(data.principalSubdivision);
  const country = clean(data.countryName);

  const primary =
    clean(data.locality) ?? clean(data.city) ?? town ?? region ?? country;

  if (primary === null) return null;

  // Built from the broader fields that actually add information. A field equal
  // to the primary line adds none, and printing it would make an assembled label
  // look like a repeated one.
  const context = [district, region].filter(
    (part): part is string => part !== null && part !== primary
  );

  const secondary =
    context.length > 0
      ? context.join(", ")
      : country !== null && country !== primary
        ? country
        : null;

  return { primary, secondary };
}
