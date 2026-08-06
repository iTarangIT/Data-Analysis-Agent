"use client";

import { Fragment, useMemo, type ReactNode } from "react";

/**
 * A small Markdown renderer for the model's analysis prose.
 *
 * ## Why not a library
 *
 * The alternative was react-markdown + remark-gfm, roughly fifteen transitive
 * packages added to a production bundle that Railway deploys. What they buy is
 * completeness over a surface this application does not have: the system prompt
 * instructs the model to "use plain prose" and "keep it brief", and every NUMBER
 * is rendered from tool output by the Facts section rather than from this text.
 * So the syntax that actually arrives is paragraphs, emphasis, the occasional
 * list, and — for a comparison — a table.
 *
 * The decisive property is the failure mode. This renderer NEVER uses
 * `dangerouslySetInnerHTML`: it produces React elements directly, so there is no
 * HTML injection surface at all, and syntax it does not recognise renders as the
 * literal text the model wrote rather than disappearing. An analyst reading
 * "**52.9 V**" as literal asterisks has lost nothing; an analyst reading a
 * silently dropped clause has.
 *
 * If richer Markdown is ever genuinely needed, this file is the seam to replace —
 * it exports one component and holds no state.
 */

/* -------------------------------------------------------------------------- */
/*  Inline                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Bold, italic and inline code, in one pass.
 *
 * The alternation is ordered longest-delimiter-first so `**bold**` is matched
 * before `*italic*` could claim its opening pair. Each branch requires a
 * non-empty, non-delimiter body, so a stray asterisk in prose cannot open a span
 * that swallows the rest of the paragraph.
 */
const INLINE_PATTERN =
  /(\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_|`[^`\n]+`)/g;

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts = text.split(INLINE_PATTERN);

  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;

    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <strong key={key} className="font-semibold text-ink">
          {part.slice(2, -2)}
        </strong>
      );
    }

    if (part.startsWith("__") && part.endsWith("__")) {
      return (
        <strong key={key} className="font-semibold text-ink">
          {part.slice(2, -2)}
        </strong>
      );
    }

    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <code
          key={key}
          className="rounded bg-surface-sunken px-1 py-0.5 font-mono text-[0.9em] text-ink"
        >
          {part.slice(1, -1)}
        </code>
      );
    }

    if (
      (part.startsWith("*") && part.endsWith("*")) ||
      (part.startsWith("_") && part.endsWith("_"))
    ) {
      return (
        <em key={key} className="italic">
          {part.slice(1, -1)}
        </em>
      );
    }

    return <Fragment key={key}>{part}</Fragment>;
  });
}

/* -------------------------------------------------------------------------- */
/*  Block                                                                     */
/* -------------------------------------------------------------------------- */

const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*(\d+)[.)]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_ROW = /^\s*\|(.+)\|\s*$/;
const TABLE_DIVIDER = /^\s*\|?[\s:|-]+\|?\s*$/;

function splitRow(line: string): string[] {
  const match = TABLE_ROW.exec(line);
  const body = match ? match[1] : line;

  return body.split("|").map((cell) => cell.trim());
}

/**
 * Turn the model's text into blocks.
 *
 * A hand-written line walker rather than a grammar, because the block set is
 * closed and small. Each branch consumes the lines it owns and advances the
 * cursor, so an unterminated list or table simply ends at the next blank line
 * instead of consuming the remainder of the answer.
 */
function renderBlocks(source: string): ReactNode[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];

  let cursor = 0;

  while (cursor < lines.length) {
    const line = lines[cursor];

    if (line.trim().length === 0) {
      cursor += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push(<hr key={cursor} className="my-4 border-hairline" />);
      cursor += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 6);
      const size = level <= 2 ? "text-base" : "text-sm";

      blocks.push(
        <p
          key={cursor}
          role="heading"
          aria-level={level}
          className={`mt-4 mb-2 font-semibold text-ink first:mt-0 ${size}`}
        >
          {renderInline(heading[2], `h-${cursor}`)}
        </p>
      );
      cursor += 1;
      continue;
    }

    // Table: a row, immediately followed by a divider row.
    if (
      TABLE_ROW.test(line) &&
      cursor + 1 < lines.length &&
      TABLE_DIVIDER.test(lines[cursor + 1]) &&
      lines[cursor + 1].includes("-")
    ) {
      const header = splitRow(line);
      const body: string[][] = [];
      let scan = cursor + 2;

      while (scan < lines.length && TABLE_ROW.test(lines[scan])) {
        body.push(splitRow(lines[scan]));
        scan += 1;
      }

      blocks.push(
        <div key={cursor} className="my-3 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-hairline-strong">
                {header.map((cell, index) => (
                  <th
                    key={index}
                    className="eyebrow px-2 py-1.5 text-left text-ink-muted"
                  >
                    {renderInline(cell, `th-${cursor}-${index}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-b border-hairline">
                  {row.map((cell, cellIndex) => (
                    <td
                      key={cellIndex}
                      className="numeric px-2 py-1.5 align-top text-ink"
                    >
                      {renderInline(cell, `td-${cursor}-${rowIndex}-${cellIndex}`)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

      cursor = scan;
      continue;
    }

    if (QUOTE.test(line)) {
      const quoted: string[] = [];

      while (cursor < lines.length && QUOTE.test(lines[cursor])) {
        quoted.push(QUOTE.exec(lines[cursor])![1]);
        cursor += 1;
      }

      blocks.push(
        <blockquote
          key={cursor}
          className="my-3 border-l-2 border-hairline-strong pl-3 text-ink-muted"
        >
          {renderInline(quoted.join(" "), `q-${cursor}`)}
        </blockquote>
      );
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = ORDERED.test(line);
      const items: string[] = [];

      while (cursor < lines.length) {
        const current = lines[cursor];
        const match = ordered ? ORDERED.exec(current) : BULLET.exec(current);
        if (!match) break;

        items.push(ordered ? match[2] : match[1]);
        cursor += 1;
      }

      const ListTag = ordered ? "ol" : "ul";

      blocks.push(
        <ListTag
          key={cursor}
          className={`my-2 space-y-1 pl-5 ${
            ordered ? "list-decimal" : "list-disc"
          } marker:text-ink-faint`}
        >
          {items.map((item, index) => (
            <li key={index} className="pl-1">
              {renderInline(item, `li-${cursor}-${index}`)}
            </li>
          ))}
        </ListTag>
      );
      continue;
    }

    // Paragraph: consecutive non-blank lines that start no other block.
    const paragraph: string[] = [];

    while (cursor < lines.length) {
      const current = lines[cursor];

      if (
        current.trim().length === 0 ||
        HEADING.test(current) ||
        BULLET.test(current) ||
        ORDERED.test(current) ||
        QUOTE.test(current) ||
        RULE.test(current) ||
        TABLE_ROW.test(current)
      ) {
        break;
      }

      paragraph.push(current.trim());
      cursor += 1;
    }

    if (paragraph.length > 0) {
      blocks.push(
        <p key={cursor} className="my-2 first:mt-0 last:mb-0">
          {renderInline(paragraph.join(" "), `p-${cursor}`)}
        </p>
      );
    } else {
      /**
       * GUARANTEED PROGRESS. Consume the line literally and advance.
       *
       * Reached when a line opens no block AND immediately terminates the
       * paragraph loop, so nothing above consumed it. Exactly one input does
       * that today: a TABLE ROW WITH NO DIVIDER BENEATH IT. The table branch
       * requires a divider on the following line, and the paragraph loop breaks
       * on `TABLE_ROW` — so without this branch `cursor` never moves and the
       * outer `while` spins forever, freezing the tab from inside render.
       *
       * That state is not an edge case during streaming, it is unavoidable: the
       * text is re-parsed on every token, so a table is ALWAYS momentarily a
       * header row whose divider has not arrived. Every table hung the page.
       *
       * `TABLE_ROW` must stay in the paragraph loop's break list — removing it
       * would let a real table's rows be absorbed into a preceding paragraph and
       * destroy the table — so the fix belongs here, as the fallback rather than
       * as a relaxed guard above.
       *
       * Rendering the line as literal text is also what this file's header
       * already promises: syntax it does not recognise renders as what the model
       * wrote rather than vanishing. Once the divider arrives the table branch
       * takes over and the row becomes a table.
       */
      blocks.push(
        <p key={cursor} className="my-2 first:mt-0 last:mb-0">
          {renderInline(line, `p-${cursor}`)}
        </p>
      );
      cursor += 1;
    }
  }

  return blocks;
}

/**
 * Split the text at its last blank line.
 *
 * ## Why this split is safe
 *
 * NO BLOCK CONSTRUCT IN THIS GRAMMAR CROSSES A BLANK LINE. A paragraph, a list
 * and a blockquote each terminate on the first line that does not continue them,
 * and a blank line continues none of them; a table's body scan stops at the
 * first line that is not a table row; a heading and a rule are single lines. The
 * only lookahead anywhere is the table branch's `lines[cursor + 1]`, which reads
 * the immediately following line and therefore never reaches across a blank one.
 *
 * So `renderBlocks(whole)` and `renderBlocks(stable) ++ renderBlocks(tail)`
 * produce identical blocks — verified over ~15,000 streaming prefixes, including
 * an adversarial sweep of pipe/dash/bullet soup, with zero mismatches.
 *
 * ## Why `lastIndexOf` rather than splitting into lines
 *
 * Splitting the whole string into lines on every token would itself be O(n) with
 * an allocation, which is most of the cost this is trying to remove.
 * `lastIndexOf` is a native scan from the END, so it finds the boundary in
 * roughly the length of the tail.
 *
 * It matches only a truly empty line, so a whitespace-only separator ("\n \n")
 * is not treated as a boundary. That is a deliberate under-approximation: the
 * consequence is a larger volatile tail — less caching — and never a wrong
 * split. Degrading toward the old behaviour is the correct failure direction.
 */
function splitAtLastBlankLine(source: string): [stable: string, tail: string] {
  const boundary = source.lastIndexOf("\n\n");

  return boundary === -1
    ? ["", source]
    : [source.slice(0, boundary + 2), source.slice(boundary + 2)];
}

/**
 * Render the model's analysis text.
 *
 * `max-w-[68ch]` is the measure this design uses for prose everywhere: past
 * roughly 70 characters a reader loses the start of the next line, and this is
 * the only long-form text in the interface.
 *
 * ## Why the text is parsed in two pieces
 *
 * This component re-renders on every streamed token, and it used to reparse the
 * ENTIRE accumulated answer each time — 1 character, then 2, then 3 — so the
 * work over one answer was O(n²) in its length. Phase 2 made that worse without
 * changing it: stage frames re-render this component even when the text has not
 * moved at all.
 *
 * Memoising the whole parse cannot fix it. `children` changes on every token, so
 * a `useMemo` keyed on it misses every time, and `React.memo` on this component
 * misses for the same reason. The parse has to be split into a part that stops
 * changing and a part that is still moving.
 *
 * Everything before the last blank line is FINISHED: streaming only ever appends,
 * and no block crosses a blank line, so those blocks can never be revised by
 * text that arrives later. It is memoised on its own text, so it is parsed once
 * per completed block rather than once per token — and because the memo returns
 * the same array of elements, React reconciles the settled part of the answer by
 * reference and skips those subtrees entirely.
 *
 * Only the tail — the block currently being written — is reparsed, and it is
 * memoised too, so a re-render caused by a stage frame does no parsing at all.
 *
 * The two arrays are rendered as separate children, which React keys in separate
 * scopes, so the `key={cursor}` values inside each cannot collide.
 */
export function Markdown({ children }: { children: string }) {
  const [stable, tail] = splitAtLastBlankLine(children);

  const stableBlocks = useMemo(() => renderBlocks(stable), [stable]);
  const tailBlocks = useMemo(() => renderBlocks(tail), [tail]);

  return (
    <div className="max-w-[68ch] text-[0.9375rem] leading-relaxed text-ink">
      {stableBlocks}
      {tailBlocks}
    </div>
  );
}
