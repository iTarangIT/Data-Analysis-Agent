import type { TurnContext } from "@/types/chat";
import {
  isEmptyPreferences,
  type MemoryPreferences,
  type ReportStyle,
} from "@/types/memory";

/**
 * Versioned system and tool prompts (SAD §5 — Prompt management).
 * Bump SYSTEM_PROMPT_VERSION whenever the contract below changes, so LangSmith
 * traces can be compared across prompt revisions.
 *
 * 1.3.0 adds the RUN CONTEXT BLOCK (Phase 4A) — appended, never woven in, so a
 * run with no context produces the 1.2.0 prompt byte for byte.
 *
 * 1.4.0 adds the SAVED PREFERENCES BLOCK (Phase 4E), appended on the same terms.
 *
 * 1.5.0 (Phase 4F) closes two gaps in that block and changes no other text:
 *
 *   - THE PREFERENCE VOCABULARY IS NOW STATED AS CLOSED. 1.4.0 listed what was
 *     stored without ever saying that the list was exhaustive, so a question
 *     about a preference that does not exist ("my preferred battery") had no
 *     rule to meet and resolved to the nearest stored neighbour — a preferred
 *     VEHICLE, which is a different kind of thing. The block now names the four
 *     kinds, says nothing else can ever be stored, and requires an unstored
 *     preference to be reported as unstored rather than substituted.
 *   - THE STYLE PREFERENCE NO LONGER CONTRADICTS THE STYLE SECTION. 1.4.0
 *     emitted "Preferred answer style: detailed" underneath a Style section
 *     that says "keep it brief", leaving the model two instructions and no rule
 *     for choosing. The preference is now rendered as an explicit, deterministic
 *     amendment to that section instead of as a bare fact beside it.
 *
 * The 1.2.0 guarantee is untouched: a run with neither context nor stored
 * preferences still produces SYSTEM_PROMPT byte for byte.
 */

export const SYSTEM_PROMPT_VERSION = "1.5.0";

export const SYSTEM_PROMPT = `You are Tarang, an AI data analyst for an electric-vehicle battery fleet.

## Grounding contract — this is not optional

You have no knowledge of this fleet. Every fact about it comes from tools.

1. NEVER state a numeric value that did not come from a tool result in this
   conversation. Not an estimate, not a typical value, not an illustration.
2. If no available tool can supply a number the user asked for, say plainly that
   the data is not available to you yet, and name what would be needed. Do not
   substitute a plausible figure.
3. When you report a number, state where it came from in your prose — the
   source and, when the tool provided it, how it was computed (for example,
   "calculated over the last 90 charging cycles").
4. Do NOT write a "Sources" list yourself. The application renders one beneath
   your answer, built mechanically from the tools that actually ran. Anything
   you invent there would be a fabricated citation.

## Reading tool results

Each tool returns JSON shaped as { data, source }. Read your numbers from
"data". "source" records provenance for the application — you do not need to
repeat it verbatim.

If a result contains an "error" field, the tool failed. Tell the user what
failed; never fill the gap with a guessed value.

## When a result was reconciled across sources

Some results carry a "reconciliation" block, meaning more than one source was
consulted — typically the live Intellicar dashboard and recorded telemetry.

1. Say which source the number came from. "As the dashboard currently shows" and
   "as recorded on 17 June" are different claims; never present one as the other.
2. If "rule" is P5_substituted_after_unavailable, the source that should have
   answered could not. Say so, and say which source answered instead.
3. If a "conflict" is present, report BOTH figures with their sources and give
   the conflict's own explanation. Never average them, never pick one silently,
   and never describe them as agreeing.
4. If "disposition" is "disputed", the two sources disagree by more than the
   time between them explains. Do NOT lead with one figure as though it were
   settled: give both, say they disagree, and say what would resolve it.
5. Never resolve a conflict yourself. The reconciliation was computed; your job
   is to report it, not to adjudicate it.

## When a result describes the whole fleet

A result carrying an "aggregation" block is about a POPULATION, not one vehicle.
Never report it as though a single vehicle measured it.

1. If "method" is "aggregated", the engine computed the figure from one reading
   per vehicle. ALWAYS say how many contributed: "contributingVehicles" out of
   "populationSize". A fleet average resting on 1 of 70 vehicles is a fact about
   one vehicle, and presenting it as a fact about the fleet would be wrong even
   though the number is real.
2. Still on "aggregated": if "firstMeasuredAt" and "lastMeasuredAt" are far
   apart, say so. Each vehicle's latest reading can be weeks older than another's,
   so a fleet figure is not necessarily a picture of right now.
3. If "method" is "reported", the Intellicar dashboard counted it and Tarang did
   not. Say it is what the dashboard currently shows. Do not describe it as
   calculated, and do not attach a vehicle count to it — the dashboard publishes
   the figure without publishing what it counted over.
4. If "method" is "population", the number is how many vehicles are registered in
   Tarang's own database. That can legitimately differ from what the dashboard
   reports, because they count different sets.
5. "extremeVehicleNo", when present, is the vehicle holding a minimum or maximum.
   Name it — it is usually the point of the question.

## Style

Answer as an analyst: lead with the number and what it means, keep it brief,
and use plain prose. Do not narrate which tools you are about to call.`;

/* -------------------------------------------------------------------------- */
/*  Run context (Phase 4A)                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Everything one run knows beyond its messages.
 *
 * `now` is the ROUTE'S clock read, not the model's guess and not the client's
 * claim — the same instant the run's log record measures from. It is here so a
 * period reference has a referent; it is not a licence to compute a date the
 * Analysis Tool was not asked for.
 */
export interface RunContext {
  /** ISO 8601. Read once, by /api/chat, at the top of the run. */
  now: string;
  /**
   * References from earlier turns (Phase 4A). Optional as of Phase 4E: a run
   * may carry stored preferences without any conversation history behind it —
   * the first question of a signed-in user's session is exactly that case.
   */
  turn?: TurnContext;
  /**
   * The signed-in user's stored preferences (Phase 4E).
   *
   * DEFAULTS, never data. Present only for an authenticated run whose owner has
   * actually stored something; absent entirely otherwise, which is the ordinary
   * case and the one that keeps the prompt unchanged.
   */
  memory?: MemoryPreferences;
}

function describeSubject(subject: TurnContext["subjects"][number]): string {
  return subject.kind === "vehicle" ? subject.vehicleNo : "the whole fleet";
}

/**
 * Render the signed-in user's stored preferences (Phase 4E).
 *
 * ## PREFERENCES ARE NOT DATA, and the block says so first
 *
 * This is the second kind of non-tool information the model receives about its
 * work, after the Phase 4A run context, and it carries the same hazard: a
 * sentence in the system prompt is easy to mistake for something known. So the
 * block leads with what these are NOT, and every line below it names a subject,
 * a quantity, a period or a writing style — never a measurement. The type makes
 * that structural: `MemoryPreferences` has no field a reading could occupy.
 *
 * ## Built from typed fields, never from stored prose
 *
 * A preferred vehicle is emitted as an identifier that passed
 * `VEHICLE_NO_PATTERN` on the way into the database and again on the way out;
 * a style is one of two literals. There is no free-text kind in v1, so there is
 * no path by which a user — or anything that reached a user's account — could
 * store a sentence that lands in this prompt.
 *
 * Emitted in a fixed field order, so the same preferences render the same
 * string and two LangSmith traces stay comparable.
 *
 * ## THE VOCABULARY IS CLOSED, AND SAYING SO IS THE POINT (Phase 4F)
 *
 * Phase 4E's block listed what was stored and stopped there. That left the
 * model an OPEN WORLD: asked about "my preferred battery" — which is not a
 * preference this system has, can store, or will ever store — it had no rule to
 * meet, so it answered from the nearest listed neighbour and reported the
 * user's preferred VEHICLE. Retrieval was correct; the prompt simply never said
 * that the four kinds are all there are.
 *
 * So the block now states the vocabulary, states that it is exhaustive, and
 * requires an unstored or non-existent preference to be REPORTED AS SUCH rather
 * than substituted. That is a rule about what may be said, not a filter on what
 * is retrieved — nothing about the query, the ownership scope or the stored
 * values changed.
 *
 * ## The style preference AMENDS the Style section rather than sitting beside it
 *
 * `report_style` is the one preference that contradicts the base prompt:
 * SYSTEM_PROMPT's Style section says "keep it brief", and 4E rendered
 * "Preferred answer style: detailed" underneath it as a bare line. Two live
 * instructions, no rule for choosing. It is therefore no longer emitted as a
 * stored-value line at all; `renderStyle` below replaces that section
 * explicitly, and the three cases — absent, brief, detailed — are spelled out
 * so the outcome is deterministic rather than negotiated.
 */
function renderStyle(style: ReportStyle): string {
  // Named as an amendment to a section the model has already read, because the
  // failure this fixes was two instructions with equal standing. Whichever
  // branch renders, exactly one instruction about length is in force.
  const instruction =
    style === "brief"
      ? `The user has chosen BRIEF answers, which CONFIRMS the Style section
above. Lead with the number and what it means and stop there — a short
paragraph, no headings, no restating of the question.`
      : `The user has chosen DETAILED answers. This REPLACES "keep it brief" in
the Style section above, and that instruction does not apply to this user. Give
the number, then how it was measured or computed, over what period, and what it
means. Everything else in the Style section still holds.`;

  return `

### Answer length — the user's stored choice

${instruction}

This changes only HOW MUCH you write. It does not license a number that no tool
produced, and every rule in the grounding contract applies unchanged.`;
}

function renderPreferences(preferences: MemoryPreferences): string {
  const lines: string[] = [];

  if (preferences.preferredVehicle !== undefined) {
    lines.push(`Usual vehicle: ${preferences.preferredVehicle}`);
  }

  if (preferences.preferredMetric !== undefined) {
    lines.push(`Usual metric: ${preferences.preferredMetric}`);
  }

  if (preferences.defaultWindowDays !== undefined) {
    lines.push(`Usual period: the last ${preferences.defaultWindowDays} days`);
  }

  // Deliberately NOT pushed into `lines`. An answer style is an instruction
  // about your writing, not a subject you might ask a tool about, and rendering
  // it as one is what put it into conflict with the Style section.
  const style =
    preferences.reportStyle === undefined
      ? ""
      : renderStyle(preferences.reportStyle);

  const stored =
    lines.length === 0
      ? "Nothing. This user has stored no vehicle, metric or period."
      : lines.join("\n");

  return `

## The user's saved preferences

These are SETTINGS THIS USER CHOSE, stored between conversations. They say what
this person usually wants asked about — nothing more.

1. THEY ARE NOT MEASUREMENTS AND NOT ANSWERS. No preference is a fact about the
   fleet, and none may be reported as one. There is no charge, health,
   temperature, location, speed or count here, and there never will be. Every
   measurement still comes from the tool that produces it, exactly as the
   grounding contract above requires.
2. THEY FILL A GAP, THEY DO NOT OVERRIDE. Use one only for something the user's
   message left unsaid. A vehicle, metric or period named in the question
   replaces the preference every time.
3. A PREFERRED VEHICLE IS A SUBJECT, NEVER A VALUE. Having one tells you what to
   ask the tools about; it tells you nothing about that vehicle's condition, and
   you still call the tool for every number.
4. THIS VOCABULARY IS CLOSED. Exactly four preferences can ever be stored: a
   USUAL VEHICLE, a USUAL METRIC, a USUAL PERIOD and an ANSWER STYLE. There are
   no others, none can be added in conversation, and anything not listed under
   "Stored" below is NOT STORED for this user.
5. NEVER READ ONE PREFERENCE AS ANOTHER. They are different kinds of thing and
   are not interchangeable. If the user asks about a preference that is not one
   of the four, or about one of the four that is not listed below, say plainly
   that it is not stored and say what is — do NOT answer from the closest
   preference you can see. "Preferred battery" is not the usual vehicle;
   "favourite route" is not the usual period. Substituting a neighbour reports a
   choice the user never made.
6. ONLY WHAT IS LISTED BELOW MAY BE USED. Do not infer a further preference from
   the ones shown, and never turn a preference into a claim about the fleet.
7. If applying a preference would change what the user seems to be asking, ask
   them rather than assuming.

Stored:
${stored}${style}`;
}

/**
 * Render the run context as a block appended to the system prompt.
 *
 * ## Rendered from typed fields, never concatenated from stored text
 *
 * Every line below is built by this function out of a validated identifier, a
 * validated metric name or an ISO instant. No sentence a user or a tool
 * supplied is interpolated, which — together with the character bounds in
 * `src/lib/turn-context.ts` — is what makes an instruction unstorable here.
 *
 * ## Deterministic
 *
 * Fields are emitted in a fixed order, so the same context renders the same
 * string every time. Two LangSmith traces of the same conversation state are
 * therefore comparable, which they would not be if the block's shape varied.
 *
 * Returns the prompt UNCHANGED when there is nothing to say. That is the
 * guarantee that a first question, and any run whose tools all failed, reaches
 * the model with exactly the prompt it reached it with before Phase 4A.
 */
export function withRunContext(context: RunContext | undefined): string {
  if (context === undefined) return SYSTEM_PROMPT;

  const { now, turn, memory } = context;
  const hasMemory = memory !== undefined && !isEmptyPreferences(memory);

  // Nothing to say. A signed-in user who has stored no preference and asked no
  // earlier question reaches the model with the 1.2.0 prompt, byte for byte —
  // the same guarantee Phase 4A established, extended to cover Phase 4E.
  if (turn === undefined && !hasMemory) return SYSTEM_PROMPT;

  const prompt = hasMemory
    ? `${SYSTEM_PROMPT}${renderPreferences(memory)}`
    : SYSTEM_PROMPT;

  if (turn === undefined) return prompt;

  const lines: string[] = [`Current time: ${now}`];

  const [lastSubject, ...earlierSubjects] = turn.subjects;

  if (lastSubject) {
    lines.push(`Last asked about: ${describeSubject(lastSubject)}`);

    if (earlierSubjects.length > 0) {
      lines.push(
        `Also asked about earlier: ${earlierSubjects.map(describeSubject).join(", ")}`
      );
    }
  }

  const [lastMetric, ...earlierMetrics] = turn.metrics;

  if (lastMetric) {
    lines.push(`Last metric requested: ${lastMetric}`);

    if (earlierMetrics.length > 0) {
      lines.push(`Also requested earlier: ${earlierMetrics.join(", ")}`);
    }
  }

  if (turn.window) {
    lines.push(`Last period analysed: ${turn.window.from} to ${turn.window.to}`);
  }

  return `${prompt}

## Conversation references

The lines below record WHAT EARLIER TURNS IN THIS CONVERSATION ASKED ABOUT.
They were built from the tool calls that actually ran, so each names something
the system genuinely acted on.

They exist for ONE purpose: resolving a reference. "That vehicle", "it", "the
same metric", "that period" — resolve them from here rather than guessing.

1. THERE ARE NO MEASUREMENTS HERE, and there never will be: no charge, health,
   temperature, location, speed or count. Nothing below is an answer.
2. RESOLVE, THEN CALL THE TOOL. Once a reference resolves to a vehicle or a
   metric, fetch the value exactly as you would if the user had typed it out. A
   figure you reported earlier in this conversation is NOT a figure you may
   report now — telemetry changes, and the grounding contract above admits no
   exception for a number you remember.
3. THE CURRENT MESSAGE ALWAYS WINS. Use these only for what the user left
   unsaid; anything the message names replaces what is below.
4. If a reference is genuinely ambiguous, ask which one is meant. Do not pick.

${lines.join("\n")}`;
}
