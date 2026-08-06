"use client";

import { useEffect, useState } from "react";

import { formatDuration } from "@/lib/format";
import type { RunStage, StageKind } from "@/types/chat";

/**
 * What the agent actually did, as it does it.
 *
 * ## Everything here is measured
 *
 * This component renders stages and nothing else. It does not interpolate
 * between them, does not advance on a timer, does not show work that has not
 * been reported, and has no notion of how many stages a run "should" have — so
 * there is no percentage, no progress bar and no pending row. A run that emits
 * three stages shows three.
 *
 * The one clock reading is the elapsed counter on an ACTIVE stage, and it is
 * measured from that stage's own `at` timestamp against the real current time.
 * It is not simulated progress: it answers "is this still working" with the only
 * honest answer available, which is how long it has genuinely been working.
 *
 * ## Wording lives here, not on the wire
 *
 * The backend emits a `kind` and, at most, a short safe `detail`. How that reads
 * to a fleet manager is a presentation decision, and keeping it here is the same
 * split that keeps charts out of the protocol. An unrecognised kind degrades to
 * a humanised form of the kind itself rather than disappearing, so a future stage
 * added server-side is legible before this file knows about it.
 */

/* -------------------------------------------------------------------------- */
/*  Wording                                                                   */
/* -------------------------------------------------------------------------- */

const LABELS: Record<StageKind, string> = {
  planning: "Planning the request",
  tool: "Running tool",
  vehicle_resolved: "Confirmed vehicle",
  fleet_resolved: "Resolved fleet",
  database_read: "Reading PostgreSQL",
  portal_connect: "Connecting to Intellicar",
  session_reused: "Reusing stored session",
  session_expired: "Stored session expired",
  session_login: "Signing in to Intellicar",
  portal_read: "Reading dashboard",
  reconciling: "Reconciling sources",
  writing: "Writing the report",
  completed: "Completed",
};

/** How the two agent-callable tools read to someone who is not a developer. */
const TOOL_LABELS: Record<string, string> = {
  analysis: "Analysing telemetry",
  portal: "Reading the live dashboard",
};

function humanizeKind(kind: string): string {
  return kind
    .replace(/_/g, " ")
    .replace(/^./, (character) => character.toUpperCase());
}

function labelFor(stage: RunStage): string {
  if (stage.kind === "tool" && stage.detail) {
    return TOOL_LABELS[stage.detail] ?? `Running the ${stage.detail} tool`;
  }

  return LABELS[stage.kind] ?? humanizeKind(stage.kind);
}

/**
 * The trailing detail for one stage.
 *
 * `count` means different things per kind and is interpreted per kind rather
 * than rendered generically — a duration and a vehicle count are not the same
 * number wearing different labels.
 */
function detailFor(stage: RunStage): string | null {
  switch (stage.kind) {
    case "tool":
    case "completed":
      return stage.count === undefined ? null : formatDuration(stage.count);

    case "fleet_resolved":
      return stage.count === undefined
        ? null
        : `${stage.count} vehicle${stage.count === 1 ? "" : "s"}`;

    default:
      return stage.detail ?? null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Elapsed                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A once-per-second tick, running only while something is genuinely in flight.
 *
 * Stopped the moment nothing is active, so a finished report is not re-rendering
 * for the rest of the session.
 */
function useTick(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;

    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  return now;
}

/* -------------------------------------------------------------------------- */
/*  Rows                                                                      */
/* -------------------------------------------------------------------------- */

type RowState = "ok" | "active" | "failed" | "stopped";

const MARKERS: Record<RowState, { glyph: string; className: string }> = {
  ok: { glyph: "✓", className: "text-live" },
  active: { glyph: "●", className: "text-live animate-pulse" },
  failed: { glyph: "✗", className: "text-critical" },
  // A stage still active when the run ended. Not styled as a failure of its own,
  // because the error frame carries what actually went wrong — this only marks
  // where execution stopped.
  stopped: { glyph: "◌", className: "text-disputed" },
};

function StageRow({
  stage,
  state,
  now,
}: {
  stage: RunStage;
  state: RowState;
  now: number;
}) {
  const marker = MARKERS[state];
  const detail = detailFor(stage);

  const elapsedMs =
    state === "active" ? now - new Date(stage.at).getTime() : null;

  return (
    <li className="flex items-baseline gap-2.5 py-1">
      <span
        aria-hidden
        className={`w-3 shrink-0 text-center text-[0.7rem] leading-none ${marker.className}`}
      >
        {marker.glyph}
      </span>

      <span
        className={`min-w-0 text-xs ${
          state === "active" ? "text-ink" : "text-ink-muted"
        }`}
      >
        {labelFor(stage)}
      </span>

      {detail ? (
        <span className="numeric truncate font-mono text-[0.6875rem] text-ink-faint">
          {detail}
        </span>
      ) : null}

      {elapsedMs !== null && elapsedMs > 1500 ? (
        <span className="numeric ml-auto shrink-0 text-[0.6875rem] text-ink-faint">
          {formatDuration(elapsedMs)}
        </span>
      ) : null}
    </li>
  );
}

/* -------------------------------------------------------------------------- */
/*  Timeline                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Resolve each stage's row state.
 *
 * The only inference this component makes: a stage still `active` once the run
 * has ended is rendered as STOPPED. That is not an invented stage — it is the
 * absence of a closing transition, read for exactly what it means, and it is how
 * the timeline shows where execution halted without the backend having to emit a
 * recovery stage it never performed.
 */
function rowState(stage: RunStage, runEnded: boolean): RowState {
  if (stage.status === "failed") return "failed";
  if (stage.status === "ok") return "ok";

  return runEnded ? "stopped" : "active";
}

export function ProgressTimeline({
  stages,
  runEnded,
}: {
  stages: RunStage[];
  runEnded: boolean;
}) {
  const hasActive = !runEnded && stages.some((stage) => stage.status === "active");
  const now = useTick(hasActive);

  if (stages.length === 0) return null;

  return (
    <ol className="space-y-0" role="status" aria-live="polite">
      {stages.map((stage) => (
        <StageRow
          key={stage.id}
          stage={stage}
          state={rowState(stage, runEnded)}
          now={now}
        />
      ))}
    </ol>
  );
}

/** One line summarising a finished run, for the collapsed trace. */
export function summariseRun(stages: RunStage[]): string {
  const completed = stages.find((stage) => stage.kind === "completed");
  const steps = stages.length;

  const duration =
    completed?.count === undefined ? null : formatDuration(completed.count);

  return `${steps} step${steps === 1 ? "" : "s"}${duration ? ` · ${duration}` : ""}`;
}
