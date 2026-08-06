"use client";

import { useReverseGeocode } from "@/components/report/useReverseGeocode";
import { formatLocation } from "@/lib/location";

/**
 * A position, with a human-readable label above it when one is available
 * (Phase 3).
 *
 * ## The coordinate is never removed from the card
 *
 * It changes typographic rank when a label arrives — it stops being the headline
 * and becomes the line beneath it — but it is present in every state this
 * component can be in, and `LocationDisplay.coordinates` is non-nullable, so
 * there is no branch here that could omit it even by mistake.
 *
 * That matters because the coordinate is what the vehicle actually reported. The
 * label is a third party's opinion about what that coordinate is near, and a card
 * that showed only the opinion would have quietly replaced a measurement with an
 * interpretation.
 *
 * ## Three states, one of which is invisible
 *
 * Before a label arrives — and for ever, if the provider is disabled, down, rate
 * limited, or simply has no name for this point — the card renders exactly what
 * it rendered before Phase 3 existed. There is no spinner, no skeleton and no
 * "looking up…", because none of those describe a real absence: the canonical
 * value is already on screen and already complete.
 */
export function LocationValue({ lat, lon }: { lat: number; lon: number }) {
  const address = useReverseGeocode(lat, lon);
  const { addressLines, coordinates } = formatLocation(lat, lon, address);

  // No label: the coordinate IS the headline, exactly as before.
  if (addressLines.length === 0) {
    return (
      <p className="numeric flex items-baseline gap-2 font-mono text-2xl font-semibold tracking-tight text-ink">
        <span aria-hidden className="text-xl">
          📍
        </span>
        {coordinates}
      </p>
    );
  }

  const [primary, ...rest] = addressLines;

  return (
    <div>
      <p className="flex items-baseline gap-2 text-2xl font-semibold tracking-tight text-ink">
        <span aria-hidden className="text-xl">
          📍
        </span>
        {primary}
      </p>

      {rest.map((line) => (
        <p key={line} className="mt-0.5 pl-8 text-sm text-ink-muted">
          {line}
        </p>
      ))}

      {/*
       * The canonical value, kept visible and kept precise. Monospace and
       * tabular so two positions can be compared column by column, which is the
       * only way a coordinate is ever actually read.
       */}
      <p className="numeric mt-2 pl-8 font-mono text-xs text-ink-faint">
        {coordinates}
      </p>
    </div>
  );
}
