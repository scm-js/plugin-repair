/**
 * Presentation helpers for the two string findings. The knowledge itself — which control
 * bytes set a colour, what 1.16.1's per-line reset means for a string Remastered draws
 * differently, and which lines the old game stacked at more than one alignment — lives in
 * the editor and reaches the plugin as `api.text` (`TextApi.bleedingLines` / `.fixBleeding`,
 * `.stackedLines` / `.flattenStacks`); `analyze.ts` takes those four functions as
 * `TextHelpers` so it stays pure and testable over data.
 *
 * This file used to carry its own copy of the byte classification. It does not any more:
 * the numbering is easy to get wrong — the editor's own table was, from 0x12 up, until it
 * was checked against the classic player palette — and one copy is enough to get wrong.
 * The stacked-text pair went into the editor for the same reason and not into this file:
 * where 0x12 and 0x13 place the text after them is the editor's table's business, and
 * every plugin that shows or rewrites map text wants the same answer.
 */

/** What `analyze` needs from `api.text`, named so a test can pass its own. */
export interface TextHelpers {
  bleedingLines(text: string): { line: number; carried: { code: string; label: string } }[];
  fixBleeding(text: string): string;
  stackedLines(text: string): { line: number; pieces: number }[];
  flattenStacks(text: string): string;
}

/** A short, single-line look at a string, for a finding that quotes one. */
export function snippet(text: string, max = 40): string {
  let out = "";
  for (const ch of text) {
    const b = ch.charCodeAt(0);
    if (b === 0x0a || b === 0x0d) out += "⏎";
    else if (b < 0x20) continue;
    else out += ch;
    if (out.length >= max) return `${out.slice(0, max)}…`;
  }
  return out;
}
