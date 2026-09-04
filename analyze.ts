/**
 * What is wrong with a map file, and what fixing it would mean. Pure over the chunk
 * list and what the editor knows about each section name (`api.document.sections.known()`
 * / `required()`), so the tests run over bytes; the plugin gathers the inputs and
 * `repair.ts` applies the byte-level repairs. Every finding says what the game does with
 * the file as it is — that is the point of the plugin over an unprotector that silently
 * rewrites everything.
 */
import { combine, named, parseChunks, readableName, u16, u32, type Chunk, type ChunkFile } from "./chk";
import type { IsomReport, SectionKnowledge } from "@scm-js/plugin-api";

export type Level = "error" | "warn" | "info";

/** A byte-level repair `repair.ts` applies, or one the host performs (`rebuild`, `rebuild-isom`). */
export type Repair =
  /** Declare the length the chunk actually has (what the game read anyway). */
  | { kind: "fix-length"; index: number }
  | { kind: "drop-trailing" }
  /** Parse the trailing bytes as chunks and append them. */
  | { kind: "recover-trailing" }
  | { kind: "remove"; index: number }
  /** Fold every occurrence of a name into one, the way the game combines them, at the last one's place. */
  | { kind: "collapse"; name: string }
  /** Pad (with `fill`) or cut a chunk to the size the game reads. */
  | { kind: "resize"; index: number; size: number; fill: number }
  /** Cut a list section to whole records. */
  | { kind: "trim-records"; index: number; stride: number }
  /** Add a missing section: the editor's default bytes, or a copy of another section's combined bytes. */
  | { kind: "insert"; name: string; source: "defaults" | { copyOf: string } }
  | { kind: "write"; index: number; bytes: Uint8Array }
  /** Put the sections in StarEdit's order. */
  | { kind: "reorder" }
  /** Re-encode sections from the editor's model (`api.document.sections.rebuild`). */
  | { kind: "rebuild"; names: string[] }
  /** Reconstruct the ISOM lattice from the tiles (`tx.rebuildIsom`). */
  | { kind: "rebuild-isom" };

export interface Finding {
  /** Stable across re-analyses of the same problem, so ticks survive a refresh. */
  id: string;
  level: Level;
  /** The section it is about, for display; null for the file as a whole. */
  section: string | null;
  title: string;
  /** What the game does with the file as it is, and what the repair changes. */
  detail: string;
  repair: Repair | null;
  /** Ticked by default: the repair is what the game effectively does already, or restores something the editor needs. */
  recommended: boolean;
}

export interface IsomFacts {
  present: boolean;
  /** `api.terrain.checkIsom()`; null when there is no lattice to measure. */
  report: IsomReport | null;
}

export interface AnalysisInput {
  file: ChunkFile;
  /** `api.document.sections.known()`: every name the editor knows, sized for this map. */
  known: SectionKnowledge[];
  /** `api.document.sections.required()`. */
  required: string[];
  /** StarEdit's VCOD table (`api.document.sections.defaults("VCOD")`), to compare against. */
  vcod?: Uint8Array | null;
  /** The ISOM's state, or `"unchecked"` when the tileset graphics are not there to measure it. */
  isom: IsomFacts | "unchecked";
}

export interface Analysis {
  findings: Finding[];
  counts: Record<Level, number>;
}

const MAP_VERSIONS = new Set([59, 63, 205, 206]);
const MAX_UNIT_ID = 227;
const UNIT_STRIDE = 36;
const PLAYER_TYPE_INACTIVE = 0;
const PLAYER_RACE_INACTIVE = 7;

export function analyze(input: AnalysisInput): Analysis {
  const { file, known, required } = input;
  const spec = new Map(known.map((k) => [k.name, k]));
  const findings: Finding[] = [];
  const add = (f: Finding) => { findings.push(f); };
  // A header with a negative length is not a section the game reads anything from; it is reported on its own below.
  const live = (name: string): Chunk[] => named(file, name).filter((c) => c.declaredSize >= 0);
  const has = (name: string) => live(name).length > 0;
  const bytesOf = (name: string): Uint8Array | null => {
    const k = spec.get(name);
    return combine(live(name), k?.mode ?? "last", k?.size ?? undefined);
  };

  /* ── The container ─────────────────────────────────────── */

  file.chunks.forEach((c, index) => {
    const label = c.name.trim() || `chunk at ${c.offset}`;
    if (c.declaredSize < 0) {
      add({
        id: `negative:${index}`, level: "error", section: c.name,
        title: `${label} declares a negative length (${c.declaredSize})`,
        detail: "A negative length makes the game seek backwards and read earlier bytes again; the editor stops reading here and keeps the rest of the file as-is. Removing the header leaves what came before it.",
        repair: { kind: "remove", index }, recommended: true,
      });
      return;
    } else if (c.truncated) {
      add({
        id: `truncated:${index}`, level: "warn", section: c.name,
        title: `${label} declares ${fmt(c.declaredSize)} bytes but the file has ${fmt(c.data.length)}`,
        detail: "The game reads what is there and stops. Declaring the length the section really has makes the file say the same thing.",
        repair: { kind: "fix-length", index }, recommended: true,
      });
    }
    if (!readableName(c.name)) {
      add({
        id: `junk-name:${index}`, level: "warn", section: c.name,
        title: `A section named ${describeName(c.name)} (${fmt(c.data.length)} bytes)`,
        detail: "The game ignores a section it does not know, but this one's name is not even text — a marker left by a protector or damage. Removing it drops those bytes.",
        repair: { kind: "remove", index }, recommended: true,
      });
    } else if (!spec.has(c.name)) {
      const empty = c.data.length === 0;
      add({
        id: `unknown:${index}`, level: "info", section: c.name,
        title: `An unknown section ${c.name.trim()} (${fmt(c.data.length)} bytes)`,
        detail: empty
          ? "The game ignores a section it does not know, and this one holds nothing — what a header with a negative length leaves behind once the editor has read the file. Removing it loses nothing."
          : "The game ignores a section it does not know; some editors keep their own data this way. It is left in place.",
        repair: empty ? { kind: "remove", index } : null, recommended: empty,
      });
    }
  });

  if (file.trailing && file.trailing.length > 0) {
    const recovered = recoverable(file.trailing);
    if (recovered) {
      add({
        id: "trailing", level: "warn", section: null,
        title: `${fmt(file.trailing.length)} bytes after the last readable section hold ${recovered.length} more (${recovered.map((c) => c.name.trim()).join(", ")})`,
        detail: "They follow a header the reader could not act on, so neither the game nor the editor sees them as sections. Recovering them appends them as sections in their own right.",
        repair: { kind: "recover-trailing" }, recommended: true,
      });
    } else {
      add({
        id: "trailing", level: "info", section: null,
        title: `${fmt(file.trailing.length)} bytes after the last readable section`,
        detail: "They are not sections; the game never reads them and Save writes them back unchanged. Dropping them loses nothing the game uses.",
        repair: { kind: "drop-trailing" }, recommended: true,
      });
    }
  }

  /* ── Repeats and sizes ─────────────────────────────────── */

  const seen = new Set<string>();
  for (const c of file.chunks) {
    if (seen.has(c.name) || !readableName(c.name)) continue;
    seen.add(c.name);
    const parts = live(c.name);
    if (parts.length > 1) {
      const k = spec.get(c.name);
      add({
        id: `repeat:${c.name}`, level: "warn", section: c.name,
        title: `${c.name.trim()} appears ${parts.length} times`,
        detail: `${repeatRule(k)} Folding them into one section holds exactly what the game ends up with.`,
        repair: { kind: "collapse", name: c.name }, recommended: true,
      });
    }
  }

  file.chunks.forEach((c, index) => {
    const k = spec.get(c.name);
    if (!k || c.truncated || c.name === "ISOM") return;
    if (k.size !== null && c.data.length !== k.size && live(c.name).length === 1) {
      const short = c.data.length < k.size;
      add({
        id: `size:${c.name}:${index}`, level: "warn", section: c.name,
        title: `${c.name.trim()} is ${fmt(c.data.length)} bytes; the game reads ${fmt(k.size)}`,
        detail: short
          ? `The game reads what is there into a zeroed buffer${c.name === "MASK" ? " (fog everywhere for the missing part)" : ""}. Padding the section to the full size writes those bytes out.`
          : "The game reads the first bytes and ignores the rest. Cutting the section to that size drops what it never sees.",
        repair: { kind: "resize", index, size: k.size, fill: c.name === "MASK" ? 0xff : 0 }, recommended: true,
      });
    } else if (k.stride !== null && k.size === null && c.data.length % k.stride !== 0) {
      const stray = c.data.length % k.stride;
      add({
        id: `stride:${c.name}:${index}`, level: "warn", section: c.name,
        title: `${c.name.trim()} ends with ${stray} stray bytes after its last whole record`,
        detail: `Records are ${k.stride} bytes each; the game reads whole ones and drops the remainder. Trimming does the same.`,
        repair: { kind: "trim-records", index, stride: k.stride }, recommended: true,
      });
    }
  });

  /* ── Missing sections ──────────────────────────────────── */

  for (const name of required) {
    if (has(name)) continue;
    const other = name === "MTXM" && has("TILE") ? "TILE" : null;
    add({
      id: `missing:${name}`, level: "error", section: name,
      title: `${name.trim()} is missing (${spec.get(name)?.what ?? "required"})`,
      detail: other
        ? "The game will not load a map without it. TILE — the editor's copy of the terrain — is here, so the terrain can be restored from it."
        : "The game will not load a map without it. Adding the section on StarEdit's defaults makes the file loadable; the data it held is gone.",
      repair: { kind: "insert", name, source: other ? { copyOf: other } : "defaults" }, recommended: true,
    });
  }
  if (has("MTXM") && !has("TILE")) {
    add({
      id: "missing:TILE", level: "warn", section: "TILE",
      title: "TILE is missing (the editor's terrain layer)",
      detail: "The game draws MTXM and never reads TILE, so protectors strip it. The editor's terrain brushes work on both; copying MTXM into a new TILE gives them the ground back (doodads included, which TILE normally leaves out).",
      repair: { kind: "insert", name: "TILE", source: { copyOf: "MTXM" } }, recommended: true,
    });
  }

  /* ── Header values ─────────────────────────────────────── */

  const dim = bytesOf("DIM ");
  const width = dim ? u16(dim, 0) : null;
  const height = dim ? u16(dim, 2) : null;
  if (dim && (width === null || height === null || width === 0 || height === 0 || width > 256 || height > 256)) {
    add({
      id: "dim", level: "error", section: "DIM ",
      title: `DIM says the map is ${width ?? "?"} × ${height ?? "?"} tiles`,
      detail: "The game takes maps from 1 × 1 to 256 × 256. The true size cannot be read off the file; Scenario ▸ Resize sets it once the map is open.",
      repair: null, recommended: false,
    });
  }

  const era = bytesOf("ERA ");
  const eraValue = era ? u16(era, 0) : null;
  if (eraValue !== null && eraValue > 7) {
    const masked = eraValue & 7;
    const bytes = new Uint8Array([masked, 0]);
    add({
      id: "era", level: "info", section: "ERA ",
      title: `ERA is ${eraValue}; the game uses ${masked}`,
      detail: "Only the low three bits pick the tileset, and some protectors set the rest. Writing the value the game uses changes nothing it draws.",
      repair: { kind: "write", index: lastIndex(file, "ERA "), bytes }, recommended: true,
    });
  }

  const ver = bytesOf("VER ");
  const version = ver ? u16(ver, 0) : null;
  if (version !== null && !MAP_VERSIONS.has(version)) {
    add({
      id: "ver", level: "warn", section: "VER ",
      title: `VER is ${version}, not a version StarEdit writes (59, 63, 205, 206)`,
      detail: "The game decides which settings sections to read from it. Scenario ▸ Map Revision sets a known one once the map is open.",
      repair: null, recommended: false,
    });
  }

  const type = bytesOf("TYPE");
  if (type) {
    const text = String.fromCharCode(...type.subarray(0, 4));
    if (text !== "RAWS" && text !== "RAWB") {
      const wanted = version !== null && version >= 63 ? "RAWB" : "RAWS";
      add({
        id: "type", level: "info", section: "TYPE",
        title: `TYPE is ${describeName(text)}, not RAWS or RAWB`,
        detail: `The game checks it against the version it is running. ${wanted} is what StarEdit writes for this file's VER.`,
        repair: { kind: "write", index: lastIndex(file, "TYPE"), bytes: new Uint8Array([...wanted].map((ch) => ch.charCodeAt(0))) }, recommended: true,
      });
    }
  }

  const ownr = bytesOf("OWNR");
  if (ownr) {
    const bad = [...ownr.subarray(0, 12)].map((v, i) => (v > 7 ? i : -1)).filter((i) => i >= 0);
    if (bad.length > 0) {
      const bytes = ownr.slice();
      for (const i of bad) bytes[i] = PLAYER_TYPE_INACTIVE;
      add({
        id: "ownr", level: "warn", section: "OWNR",
        title: `OWNR holds an unknown player type for ${players(bad)}`,
        detail: "Player types run 0 to 7 (inactive, computer, human, rescuable, neutral). Setting the unknown ones to inactive takes those slots out of the game; Scenario ▸ Player Settings can put them back.",
        repair: { kind: "write", index: lastIndex(file, "OWNR"), bytes }, recommended: false,
      });
    }
  }
  const side = bytesOf("SIDE");
  if (side) {
    const bad = [...side.subarray(0, 12)].map((v, i) => (v > 7 ? i : -1)).filter((i) => i >= 0);
    if (bad.length > 0) {
      const bytes = side.slice();
      for (const i of bad) bytes[i] = PLAYER_RACE_INACTIVE;
      add({
        id: "side", level: "warn", section: "SIDE",
        title: `SIDE holds an unknown race for ${players(bad)}`,
        detail: "Races run 0 to 7 (Zerg, Terran, Protoss, user-selectable, random, inactive). Setting the unknown ones to inactive; Scenario ▸ Player Settings can change them.",
        repair: { kind: "write", index: lastIndex(file, "SIDE"), bytes }, recommended: false,
      });
    }
  }

  /* ── Tables ────────────────────────────────────────────── */

  for (const name of ["STR ", "STRx"] as const) {
    const str = bytesOf(name);
    if (!str) continue;
    const wide = name === "STRx";
    const read = wide ? u32 : u16;
    const count = read(str, 0);
    if (count === null) {
      add({ id: `str:${name}`, level: "warn", section: name, title: `${name.trim()} is too short to hold its string count`, detail: "The game reads no strings from it. Rebuilding writes the table the editor holds (every string it could read).", repair: { kind: "rebuild", names: [name] }, recommended: true });
      continue;
    }
    const headerSize = (wide ? 4 : 2) * (1 + count);
    let outside = 0;
    for (let i = 0; i < count; i++) {
      const off = read(str, (wide ? 4 : 2) * (1 + i));
      if (off === null || off >= str.length) outside++;
    }
    if (headerSize > str.length || outside > 0) {
      add({
        id: `str:${name}`, level: "warn", section: name,
        title: headerSize > str.length ? `${name.trim()} declares ${fmt(count)} strings but is too short for their offsets` : `${fmt(outside)} of ${fmt(count)} string offsets point outside ${name.trim()}`,
        detail: "The game shows those strings empty (or reads garbage). Rebuilding writes the table the editor holds: every string it could read, each offset in range.",
        repair: { kind: "rebuild", names: [name] }, recommended: true,
      });
    }
  }

  const units = bytesOf("UNIT");
  if (units) {
    const records = Math.floor(units.length / UNIT_STRIDE);
    const bad: number[] = [];
    for (let i = 0; i < records; i++) {
      const at = i * UNIT_STRIDE;
      const id = u16(units, at + 8)!;
      const owner = units[at + 10];
      if (id > MAX_UNIT_ID || owner > 11) bad.push(i);
    }
    if (bad.length > 0) {
      const keep = new Uint8Array((records - bad.length) * UNIT_STRIDE);
      const drop = new Set(bad);
      let pos = 0;
      for (let i = 0; i < records; i++) {
        if (drop.has(i)) continue;
        keep.set(units.subarray(i * UNIT_STRIDE, (i + 1) * UNIT_STRIDE), pos);
        pos += UNIT_STRIDE;
      }
      add({
        id: "units", level: "warn", section: "UNIT",
        title: `${bad.length} of ${fmt(records)} unit records name a unit type or owner the game does not have`,
        detail: "A unit id past 227 or an owner past player 12 is nothing the game can place; it skips or misreads the record. Removing those records is the only clean repair, and it is data loss — look at them in the Units layer first.",
        repair: { kind: "write", index: lastIndex(file, "UNIT"), bytes: keep }, recommended: false,
      });
    }
  }

  const vcod = bytesOf("VCOD");
  if (vcod && input.vcod && !same(vcod, input.vcod)) {
    add({
      id: "vcod", level: "info", section: "VCOD",
      title: "VCOD is not StarEdit's table",
      detail: "Every map StarEdit writes carries the same 1040-byte verification table; the game uses it to hash the player sections. A different table is a sign of a protector or another editor, and the map may still play. Restoring the standard table is what the editor writes for a new map.",
      repair: { kind: "write", index: lastIndex(file, "VCOD"), bytes: input.vcod.slice() }, recommended: false,
    });
  }

  /* ── ISOM ──────────────────────────────────────────────── */

  const isomChunks = named(file, "ISOM");
  const isomSpec = spec.get("ISOM");
  if (input.isom === "unchecked") {
    if (isomChunks.length === 0) {
      add({ id: "isom", level: "warn", section: "ISOM", title: "No ISOM section — the isometric brush is off", detail: "The game never reads ISOM; it is the editor's record of the terrain lattice. Rebuilding it from the tiles needs the tileset graphics, which are not loaded.", repair: null, recommended: false });
    }
  } else if (!input.isom.present) {
    const wrongSize = isomChunks.length > 0 && isomSpec?.size != null && isomChunks[isomChunks.length - 1].data.length !== isomSpec.size;
    add({
      id: "isom", level: "warn", section: "ISOM",
      title: wrongSize ? `ISOM is ${fmt(isomChunks[isomChunks.length - 1].data.length)} bytes; a ${isomSpec!.size}-byte lattice fits this map` : "No ISOM section — the isometric brush is off",
      detail: "The game never reads ISOM; it is the editor's record of the terrain lattice, and protectors strip it. Rebuilding it from the tiles is exact for terrain laid down isometrically and a best guess under doodads and for hand-placed tiles. One undo step.",
      repair: { kind: "rebuild-isom" }, recommended: true,
    });
  } else if (input.isom.report?.stale) {
    const r = input.isom.report;
    const pct = Math.round((100 * r.mismatched) / Math.max(1, r.rects));
    add({
      id: "isom-stale", level: "warn", section: "ISOM",
      title: `ISOM disagrees with the tiles under about ${pct}% of the map`,
      detail: "Terrain edited with the Rect or Tile brush, or by another tool, left the lattice behind; isometric strokes near there will not join up. Rebuilding it from the tiles brings it back in step. One undo step.",
      repair: { kind: "rebuild-isom" }, recommended: true,
    });
  }

  /* ── TILE against MTXM ─────────────────────────────────── */

  const mtxm = bytesOf("MTXM");
  const tile = bytesOf("TILE");
  if (mtxm && tile && width && height) {
    const cells = Math.min(width * height, mtxm.length >> 1, tile.length >> 1);
    let differ = 0, zero = 0;
    for (let i = 0; i < cells; i++) {
      const a = mtxm[2 * i] | (mtxm[2 * i + 1] << 8);
      const b = tile[2 * i] | (tile[2 * i + 1] << 8);
      if (a !== b) differ++;
      if (b === 0) zero++;
    }
    const stripped = zero === cells && cells > 0;
    if (differ > 0) {
      add({
        id: "tile", level: stripped ? "warn" : "info", section: "TILE",
        title: stripped ? "TILE is blank: the editor's terrain layer was zeroed" : `TILE and MTXM differ on ${fmt(differ)} of ${fmt(cells)} tiles`,
        detail: stripped
          ? "The game draws MTXM and never reads TILE, so protectors zero it. Copying MTXM over it gives the terrain brushes the ground back (doodads included, which TILE normally leaves out)."
          : "TILE is the ground without doodads, so the two differ under every doodad, and that is normal. Where they differ everywhere else, TILE was edited by another tool. Copying MTXM over it makes them agree; the doodads' own records stay.",
        repair: { kind: "write", index: lastIndex(file, "TILE"), bytes: mtxm.slice(0, tile.length) }, recommended: stripped,
      });
    }
  }

  /* ── Order ─────────────────────────────────────────────── */

  const order = known.map((k) => k.name);
  const rank = (c: Chunk) => { const i = order.indexOf(c.name); return i < 0 ? order.length : i; };
  const ranks = file.chunks.filter((c) => readableName(c.name)).map(rank);
  if (ranks.some((r, i) => i > 0 && r < ranks[i - 1])) {
    add({
      id: "order", level: "info", section: null,
      title: "The sections are not in StarEdit's order",
      detail: "The game reads them in any order. Putting them in the order StarEdit writes them makes the file look like one it saved; unknown sections go to the end.",
      repair: { kind: "reorder" }, recommended: false,
    });
  }

  const weight: Record<Level, number> = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => weight[a.level] - weight[b.level]);
  const counts: Record<Level, number> = { error: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.level]++;
  return { findings, counts };
}

/** Chunks the trailing bytes parse into when they are wholly sections; null when they are not. */
export function recoverable(trailing: Uint8Array): Chunk[] | null {
  if (trailing.length < 8) return null;
  const parsed = parseChunks(trailing);
  if (parsed.trailing || parsed.chunks.length === 0) return null;
  if (parsed.chunks.some((c) => c.truncated || !readableName(c.name))) return null;
  return parsed.chunks;
}

function repeatRule(k: SectionKnowledge | undefined): string {
  switch (k?.mode) {
    case "overlay": return `The game copies each occurrence over the front of one ${k.size !== null ? `${fmt(k.size)}-byte ` : ""}buffer in file order, so a later short one changes only its first bytes.`;
    case "append": return "The game keeps every occurrence's records, in file order.";
    case "first": return "The game uses the first occurrence and ignores the rest.";
    default: return "The game uses the last occurrence and ignores the rest.";
  }
}

const lastIndex = (file: ChunkFile, name: string) => file.chunks.map((c) => c.name).lastIndexOf(name);
const fmt = (n: number) => n.toLocaleString("en-US");
const players = (slots: number[]) => (slots.length === 1 ? `player ${slots[0] + 1}` : `players ${slots.map((i) => i + 1).join(", ")}`);
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

/** A name as the user can read it: printable characters as they are, the rest as hex. */
export function describeName(name: string): string {
  const shown = [...name].map((ch) => { const c = ch.charCodeAt(0); return c >= 0x20 && c <= 0x7e ? ch : `\\x${c.toString(16).padStart(2, "0")}`; }).join("");
  return `"${shown}"`;
}
