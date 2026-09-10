/**
 * Apply the byte-level repairs `analyze.ts` proposed to a chunk list. Pure: the caller
 * serialises the result and hands it to `api.document.sections.replaceFile`, then runs the
 * two host repairs (`rebuild`, `rebuild-isom`) that need the editor's model. Repairs are
 * resolved to chunk objects before anything moves, so an index from the analysis stays
 * valid however many removals come before it.
 */
import { chunk, combine, named, parseChunks, readableName, type Chunk, type ChunkFile } from "./chk";
import type { Repair } from "./analyze";
import type { SectionKnowledge } from "@scm-js/plugin-api";

export interface RepairContext {
  known: SectionKnowledge[];
  /** `api.document.sections.defaults`. */
  defaults(name: string): Uint8Array | null;
}

export interface RepairOutcome {
  file: ChunkFile;
  /** What could not be done, in words. */
  skipped: string[];
  /** The `rebuild` names, gathered for the host. */
  rebuild: string[];
  rebuildIsom: boolean;
  /** The `set-strings` changes chosen, which the host runs through `document.update` after the file is written. */
  setStrings: ("colours" | "stacks")[];
}

export function applyRepairs(input: ChunkFile, repairs: Repair[], ctx: RepairContext): RepairOutcome {
  const chunks = input.chunks.map((c) => ({ ...c }));
  const file: ChunkFile = { chunks, trailing: input.trailing };
  const at = (index: number) => chunks[index];
  const skipped: string[] = [];
  const rebuild = new Set<string>();
  let rebuildIsom = false;
  const setStrings = new Set<"colours" | "stacks">();
  const spec = (name: string) => ctx.known.find((k) => k.name === name);
  const order = ctx.known.map((k) => k.name);

  // Pin every targeted chunk first; later removals shift indices, the objects stay.
  const targets = repairs.map((r) => ("index" in r ? at(r.index) : null));
  const removals = new Set<Chunk>();
  const inserts: Chunk[] = [];
  let reorder = false;

  repairs.forEach((r, i) => {
    const target = targets[i];
    switch (r.kind) {
      case "fix-length":
        if (!target) { skipped.push(`no section at ${r.index}`); break; }
        target.declaredSize = target.data.length;
        target.truncated = false;
        break;
      case "drop-trailing":
        file.trailing = null;
        break;
      case "recover-trailing": {
        if (!file.trailing) { skipped.push("no trailing bytes"); break; }
        const parsed = parseChunks(file.trailing);
        inserts.push(...parsed.chunks.map((c) => chunk(c.name, c.data)));
        file.trailing = null;
        break;
      }
      case "remove":
        if (!target) { skipped.push(`no section at ${r.index}`); break; }
        removals.add(target);
        break;
      case "collapse": {
        const parts = named(file, r.name).filter((c) => !removals.has(c));
        if (parts.length < 2) break;
        const k = spec(r.name);
        const data = combine(parts, k?.mode ?? "last", k?.size)!;
        const last = parts[parts.length - 1];
        last.data = data;
        last.declaredSize = data.length;
        last.truncated = false;
        for (const p of parts.slice(0, -1)) removals.add(p);
        break;
      }
      case "resize": {
        if (!target) { skipped.push(`no section at ${r.index}`); break; }
        const data = new Uint8Array(r.size).fill(r.fill);
        data.set(target.data.subarray(0, r.size));
        target.data = data;
        target.declaredSize = r.size;
        target.truncated = false;
        break;
      }
      case "trim-records": {
        if (!target) { skipped.push(`no section at ${r.index}`); break; }
        const whole = target.data.length - (target.data.length % r.stride);
        target.data = target.data.slice(0, whole);
        target.declaredSize = whole;
        break;
      }
      case "insert": {
        const data = r.source === "defaults" ? ctx.defaults(r.name) : (() => { const k = spec(r.source.copyOf); return combine(named(file, r.source.copyOf), k?.mode ?? "last", k?.size); })();
        if (!data) { skipped.push(`nothing to write for ${r.name.trim()}`); break; }
        const k = spec(r.name);
        inserts.push(chunk(r.name, k?.size != null && data.length !== k.size ? fit(data, k.size, r.name === "MASK" ? 0xff : 0) : data));
        break;
      }
      case "write":
        if (!target) { skipped.push(`no section at ${r.index}`); break; }
        target.data = r.bytes.slice();
        target.declaredSize = r.bytes.length;
        target.truncated = false;
        break;
      case "reorder":
        reorder = true;
        break;
      case "rebuild":
        for (const n of r.names) rebuild.add(n);
        break;
      case "rebuild-isom":
        rebuildIsom = true;
        break;
      // Not a byte-level repair: the strings are rewritten through the editor's model
      // once the file below has been installed, so the fix survives it.
      case "set-strings":
        setStrings.add(r.change);
        break;
    }
  });

  file.chunks = chunks.filter((c) => !removals.has(c));
  // A new section goes where StarEdit would put it: after the last section that precedes it in the registry's order.
  for (const c of inserts) {
    const rank = order.indexOf(c.name);
    let pos = file.chunks.length;
    if (rank >= 0) {
      pos = 0;
      file.chunks.forEach((existing, i) => { const r = order.indexOf(existing.name); if (r >= 0 && r <= rank) pos = i + 1; });
    }
    file.chunks.splice(pos, 0, c);
  }
  if (reorder) {
    const rank = (c: Chunk) => { const i = readableName(c.name) ? order.indexOf(c.name) : -1; return i < 0 ? order.length : i; };
    file.chunks = file.chunks.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map(({ c }) => c);
  }
  return { file, skipped, rebuild: [...rebuild], rebuildIsom, setStrings: [...setStrings] };
}

/** Pad or cut to a size. */
export function fit(data: Uint8Array, size: number, fill: number): Uint8Array {
  const out = new Uint8Array(size).fill(fill);
  out.set(data.subarray(0, size));
  return out;
}
