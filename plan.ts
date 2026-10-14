/**
 * What happens to the findings: which the plugin repairs by itself when a map opens, which
 * wait for the user, which are only worth a note — and the words the status bar shows for
 * that. Pure, so the split and the wording are tested without the editor.
 */
import type { Finding } from "./analyze";
import { english, type Translate } from "./i18n";

/** Edit ▸ Preferences ▸ Repair: what a map opening does. */
export type Mode = "auto" | "ask" | "off";

export const MODES: readonly Mode[] = ["auto", "ask", "off"];

/**
 * The stored choice, or the one the old *Check maps when they open* tick meant: off stays
 * off, and on (the default) becomes the new default, repairing by itself.
 */
export function readMode(stored: unknown, legacyAsk: unknown): Mode {
  if (MODES.includes(stored as Mode)) return stored as Mode;
  return legacyAsk === false ? "off" : "auto";
}

export interface Groups {
  /** Recommended repairs: they write what the game already does, or put back what the editor needs. Done without asking in `auto`. */
  safe: Finding[];
  /** An error or warning with no recommended repair: a judgement call, or something nothing can fix. */
  review: Finding[];
  /** Notes with no recommended repair — worth knowing, nothing to decide. */
  notes: Finding[];
}

export function group(findings: readonly Finding[]): Groups {
  const groups: Groups = { safe: [], review: [], notes: [] };
  for (const f of findings) {
    if (f.repair && f.recommended) groups.safe.push(f);
    else if (f.level === "info") groups.notes.push(f);
    else groups.review.push(f);
  }
  return groups;
}

/** The status bar cell: null when there is nothing to show (a clean map, or one never checked). */
export function cellText(groups: Groups, repaired: number, t: Translate = english): { text: string; warn: boolean } | null {
  const parts: string[] = [];
  if (repaired > 0) parts.push(t("Repaired {n}", { n: repaired }));
  if (groups.safe.length > 0) parts.push(t("{n} to fix", { n: groups.safe.length }));
  if (groups.review.length > 0) parts.push(t("{n} to review", { n: groups.review.length }));
  if (parts.length === 0) return null;
  const joined = parts.join(" · ");
  return { text: repaired > 0 ? joined : t("Repair: {parts}", { parts: joined }), warn: groups.safe.length + groups.review.length > 0 };
}
