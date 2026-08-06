import { z } from "zod";

import { reverseGeocode } from "@/services/geocoding/geocoder.service";
import type { GeocodeResponse } from "@/types/location";

/**
 * Reverse geocoding endpoint (Phase 3).
 *
 * Thin by the same rule /api/chat follows: validate, call one service, return.
 * No provider, no cache and no throttle appears here — those live in
 * src/services/geocoding/, and this route knows only that a coordinate goes in
 * and a label or nothing comes out.
 *
 * ## Why this is a route at all, rather than a fetch from the browser
 *
 * Three reasons, in order of weight:
 *
 *   1. ONE SHARED CACHE. A fleet parks at the same depots, so the same
 *      coordinates are asked for across users, tabs and page loads. A
 *      browser-side cache would be per-session and would multiply provider
 *      traffic by the number of people looking.
 *   2. ONE THROTTLE. A provider's rate limit applies to the deployment, not to
 *      a browser tab, so it can only be honoured where the requests converge.
 *   3. The provider endpoint and contact stay server-side configuration, and a
 *      provider that later needs a key needs no client change.
 *
 * ## What this endpoint deliberately never does
 *
 * It never touches the agent, the Analysis Engine, the Portal Service, the
 * Session Manager or the database, and nothing in /api/chat calls it. A label is
 * fetched by the CLIENT after a report has already rendered, so a geocoding
 * outage cannot delay, alter or fail an answer — and the label never enters the
 * model's context, so it can never be restated as though a vehicle had reported
 * it.
 */

export const runtime = "nodejs";

/**
 * Coerced from query strings, then range-checked.
 *
 * The service re-checks plausibility itself and is the authority; this schema
 * exists so a malformed request is refused before a service call rather than
 * after, and so the handler below can trust two numbers.
 */
const requestSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lon: z.coerce.number().min(-180).max(180),
});

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  const parsed = requestSchema.safeParse({
    lat: searchParams.get("lat"),
    lon: searchParams.get("lon"),
  });

  /**
   * A malformed coordinate answers 200 with no address, not 400.
   *
   * The client's handling of "no label" is already to show the coordinate, and
   * that is the correct outcome here too. Returning an error status would give
   * the browser a failed request to log, and a future component a status to
   * render — for a case whose only honest UI is the one that already exists.
   */
  if (!parsed.success) {
    return Response.json({ address: null } satisfies GeocodeResponse);
  }

  const address = await reverseGeocode(parsed.data.lat, parsed.data.lon);

  return Response.json({ address } satisfies GeocodeResponse, {
    headers: {
      /**
       * Mirrors the server cache's own hit TTL, so a browser that asks twice for
       * one depot does not reach this route twice. A miss is not cached here:
       * the service already holds a short negative TTL, and letting the browser
       * pin a null for an hour would outlive a transient provider outage.
       */
      "Cache-Control": address === null ? "no-store" : "private, max-age=86400",
    },
  });
}
