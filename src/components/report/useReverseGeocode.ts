"use client";

import { useEffect, useState } from "react";

import { geocodeCacheKey } from "@/services/geocoding/cache";
import type { Address, GeocodeResponse } from "@/types/location";

/**
 * Fetch a human-readable label for one coordinate, after the report has rendered
 * (Phase 3).
 *
 * ## Why this is an effect and not part of the answer
 *
 * The report is complete without it. Facts, evidence and sources are rendered
 * from the stream, and this runs afterwards purely to put a name above a number
 * that is already on screen. Nothing waits for it: if it never resolves, the card
 * is exactly what it was before Phase 3.
 *
 * That is also why there is no loading state exposed. A spinner beside a
 * coordinate would tell the user something is missing, when in fact the
 * canonical value is already there and complete.
 *
 * ## Two caches, not one
 *
 * The server holds the real cache — shared across users and tabs, and the only
 * place the provider's one-request-per-second policy can be honoured. This
 * module holds a second, in-page one, keyed identically, whose job is narrower:
 * a report can show several vehicles parked at one depot, React re-renders on
 * every streamed token, and without it each render would issue a fresh HTTP
 * request for a label it already has.
 *
 * `geocodeCacheKey` is imported from the service rather than reimplemented so
 * both layers bucket coordinates the same way. It is a pure string function; the
 * module it lives in imports no network client, so nothing follows it into the
 * browser bundle.
 */

/**
 * Resolved labels for this page, keyed by rounded coordinate.
 *
 * MODULE-LEVEL rather than component state, so two cards showing one depot share
 * a result and a remount does not refetch. It only ever grows with distinct
 * places a user has actually looked at in one session, and is discarded on
 * reload.
 */
const resolved = new Map<string, Address | null>();

/** In-flight requests, so N cards for one coordinate issue ONE fetch. */
const inFlight = new Map<string, Promise<Address | null>>();

async function lookup(lat: number, lon: number): Promise<Address | null> {
  const key = geocodeCacheKey(lat, lon);

  const settled = resolved.get(key);
  if (settled !== undefined) return settled;

  const pending = inFlight.get(key);
  if (pending !== undefined) return pending;

  const request = fetch(`/api/geocode?lat=${lat}&lon=${lon}`)
    .then((response) => (response.ok ? response.json() : null))
    .then((body: GeocodeResponse | null) => body?.address ?? null)
    // Offline, aborted, malformed — all the same outcome. The coordinate was
    // always the answer, and this never surfaces as an error to the user.
    .catch(() => null)
    .then((address) => {
      resolved.set(key, address);
      inFlight.delete(key);
      return address;
    });

  inFlight.set(key, request);
  return request;
}

/**
 * The label for a coordinate, or null until (and unless) one arrives.
 *
 * Returns null on the first render by design — the card renders its coordinate
 * immediately and the label appears later, if at all. Only the cards for that
 * coordinate re-render when it does.
 */
export function useReverseGeocode(
  lat: number | null,
  lon: number | null
): Address | null {
  const [address, setAddress] = useState<Address | null>(null);

  useEffect(() => {
    if (lat === null || lon === null) return;

    // Guards the one hazard an async effect has: a resolution arriving after the
    // card has been unmounted or pointed at a different vehicle, which would
    // otherwise set a label belonging to another coordinate.
    let active = true;

    void lookup(lat, lon).then((result) => {
      if (active && result !== null) setAddress(result);
    });

    return () => {
      active = false;
    };
  }, [lat, lon]);

  return address;
}
