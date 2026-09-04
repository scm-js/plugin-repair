import { describe, expect, it } from "vitest";
import { analyze, describeName, recoverable, type AnalysisInput, type Finding } from "../analyze";
import { chunk, parseChunks, serializeChunks, type ChunkFile } from "../chk";
import type { SectionKnowledge } from "@scm-js/plugin-api";

/* A registry the shape the editor hands out, sized for a 4 × 2 map. */
const W = 4, H = 2;
const K = (name: string, what: string, mode: SectionKnowledge["mode"], size: number | null, stride: number | null = null, modelled = true): SectionKnowledge => ({ name, what, mode, size, stride, modelled });
const KNOWN: SectionKnowledge[] = [
  K("TYPE", "Map type", "last", 4), K("VER ", "Version", "last", 2), K("IVE2", "StarEdit version", "last", 2, null, false), K("VCOD", "Verification", "last", 1040, null, false),
  K("OWNR", "Player types", "last", 12), K("ERA ", "Tileset", "last", 2), K("DIM ", "Dimensions", "last", 4), K("SIDE", "Races", "last", 12),
  K("MTXM", "Terrain", "overlay", W * H * 2), K("UNIT", "Units", "append", null, 36), K("ISOM", "Isometric", "overlay", (Math.floor(W / 2) + 1) * (H + 1) * 8),
  K("TILE", "Editor terrain", "overlay", W * H * 2), K("THG2", "Sprites", "append", null, 10), K("MASK", "Fog", "overlay", W * H), K("STR ", "Strings", "last", null),
  K("MRGN", "Locations", "overlay", null, 20), K("TRIG", "Triggers", "append", null, 2400), K("SPRP", "Name", "last", 4), K("FORC", "Forces", "last", 20), K("STRx", "Strings (wide)", "last", null),
];
const REQUIRED = ["VER ", "VCOD", "OWNR", "ERA ", "DIM ", "SIDE", "MTXM", "UNIT", "THG2", "STR ", "MRGN", "TRIG", "SPRP", "FORC"];
const VCOD = new Uint8Array(1040).fill(7);

const u16 = (...v: number[]) => new Uint8Array(v.flatMap((n) => [n & 0xff, (n >> 8) & 0xff]));
const text = (s: string) => new Uint8Array([...s].map((c) => c.charCodeAt(0)));
/** A string table: count, offsets, then the strings. */
function strings(list: string[], wide = false): Uint8Array {
  const w = wide ? 4 : 2;
  const header = w * (1 + list.length);
  const bodies = list.map(text);
  const out = new Uint8Array(header + bodies.reduce((n, b) => n + b.length + 1, 0));
  const view = new DataView(out.buffer);
  const put = (at: number, v: number) => (wide ? view.setUint32(at, v, true) : view.setUint16(at, v, true));
  put(0, list.length);
  let pos = header;
  bodies.forEach((b, i) => { put(w * (1 + i), pos); out.set(b, pos); pos += b.length + 1; });
  return out;
}

/** A sound 4 × 2 map, section by section, in the registry's order. */
function goodFile(): ChunkFile {
  const mtxm = u16(...Array.from({ length: W * H }, (_, i) => 0x20 + i));
  return {
    chunks: [
      chunk("TYPE", text("RAWB")), chunk("VER ", u16(205)), chunk("IVE2", u16(11)), chunk("VCOD", VCOD.slice()),
      chunk("OWNR", new Uint8Array([6, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7])), chunk("ERA ", u16(4)), chunk("DIM ", u16(W, H)), chunk("SIDE", new Uint8Array([5, 5, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7])),
      chunk("MTXM", mtxm), chunk("UNIT", new Uint8Array(0)), chunk("ISOM", new Uint8Array((Math.floor(W / 2) + 1) * (H + 1) * 8)), chunk("TILE", mtxm.slice()),
      chunk("THG2", new Uint8Array(0)), chunk("MASK", new Uint8Array(W * H).fill(0xff)), chunk("STR ", strings(["a", "b"])), chunk("MRGN", new Uint8Array(64 * 20)),
      chunk("TRIG", new Uint8Array(0)), chunk("SPRP", u16(1, 2)), chunk("FORC", new Uint8Array(20)),
    ],
    trailing: null,
  };
}
const input = (file: ChunkFile, extra: Partial<AnalysisInput> = {}): AnalysisInput => ({ file, known: KNOWN, required: REQUIRED, vcod: VCOD, isom: { present: true, report: { rects: 8, mismatched: 0, stale: false } }, ...extra });
const ids = (findings: Finding[]) => findings.map((f) => f.id);
const byId = (findings: Finding[], id: string) => findings.find((f) => f.id === id)!;
const at = (file: ChunkFile, name: string) => file.chunks.findIndex((c) => c.name === name);
const JUNK = "\x00\x01\x02\x03";

describe("a sound file", () => {
  it("has nothing to report", () => {
    const a = analyze(input(goodFile()));
    expect(a.findings).toEqual([]);
    expect(a.counts).toEqual({ error: 0, warn: 0, info: 0 });
  });

  it("survives a round trip through the chunk reader", () => {
    const file = goodFile();
    const again = parseChunks(serializeChunks(file));
    expect(again.chunks.map((c) => [c.name, c.data.length, c.truncated])).toEqual(file.chunks.map((c) => [c.name, c.data.length, false]));
    expect(again.trailing).toBeNull();
    expect(again.chunks[1].offset).toBe(12);
  });
});

describe("the container", () => {
  it("reports a truncated section and declares the length it has", () => {
    const bytes = serializeChunks(goodFile());
    const file = parseChunks(bytes.subarray(0, bytes.length - 10));
    const a = analyze(input(file));
    const f = byId(a.findings, `truncated:${file.chunks.length - 1}`);
    expect(f).toMatchObject({ level: "warn", section: "FORC", repair: { kind: "fix-length" }, recommended: true });
    expect(f.title).toContain("declares 20 bytes but the file has 10");
    // The short FORC is not also reported as the wrong size: one problem, one finding.
    expect(ids(a.findings).filter((i) => i.startsWith("size:"))).toEqual([]);
  });

  it("reports a negative length, and recovers the sections after it", () => {
    const file = goodFile();
    const head = serializeChunks({ chunks: file.chunks.slice(0, 8), trailing: null });
    const tail = serializeChunks({ chunks: file.chunks.slice(8), trailing: null });
    const bytes = new Uint8Array(head.length + 8 + tail.length);
    bytes.set(head);
    bytes.set([0x4d, 0x54, 0x58, 0x4d, 0xff, 0xff, 0xff, 0xff], head.length); // "MTXM", -1
    bytes.set(tail, head.length + 8);
    const parsed = parseChunks(bytes);
    expect(parsed.chunks).toHaveLength(9);
    expect(parsed.chunks[8]).toMatchObject({ name: "MTXM", declaredSize: -1, truncated: true });
    expect(parsed.trailing).toHaveLength(tail.length);
    expect(recoverable(parsed.trailing!)!.map((c) => c.name)).toEqual(file.chunks.slice(8).map((c) => c.name));
    const a = analyze(input(parsed));
    expect(byId(a.findings, "negative:8")).toMatchObject({ level: "error", repair: { kind: "remove", index: 8 }, recommended: true });
    expect(byId(a.findings, "trailing")).toMatchObject({ level: "warn", repair: { kind: "recover-trailing" }, recommended: true });
    expect(byId(a.findings, "trailing").title).toContain("MTXM, UNIT, ISOM");
    // What the reader can see is missing, until recovered.
    expect(ids(a.findings)).toContain("missing:MTXM");
    expect(ids(a.findings)).toContain("missing:STR ");
  });

  it("offers to drop trailing bytes that are not sections", () => {
    const file = goodFile();
    file.trailing = new Uint8Array([1, 2, 3]);
    const a = analyze(input(file));
    expect(byId(a.findings, "trailing")).toMatchObject({ level: "info", repair: { kind: "drop-trailing" }, recommended: true });
    expect(recoverable(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(recoverable(serializeChunks({ chunks: [chunk(JUNK, new Uint8Array(2))], trailing: null }))).toBeNull();
  });

  it("removes junk-named sections and keeps unknown readable ones", () => {
    const file = goodFile();
    file.chunks.push(chunk(JUNK, new Uint8Array(5)), chunk("MYSC", new Uint8Array(3)));
    const a = analyze(input(file));
    const junk = byId(a.findings, `junk-name:${file.chunks.length - 2}`);
    expect(junk).toMatchObject({ level: "warn", repair: { kind: "remove", index: file.chunks.length - 2 }, recommended: true });
    expect(junk.title).toContain('"\\x00\\x01\\x02\\x03"');
    expect(byId(a.findings, `unknown:${file.chunks.length - 1}`)).toMatchObject({ level: "info", repair: null });
    expect(describeName("RAW\xff")).toBe('"RAW\\xff"');
    // An empty unknown section is what the editor makes of a negative-length header; it can go.
    file.chunks.push(chunk("ABCD", new Uint8Array(0)));
    expect(byId(analyze(input(file)).findings, `unknown:${file.chunks.length - 1}`)).toMatchObject({ level: "info", repair: { kind: "remove", index: file.chunks.length - 1 }, recommended: true });
  });

  it("reports repeats with the game's rule for the section", () => {
    const file = goodFile();
    file.chunks.splice(at(file, "DIM ") + 1, 0, chunk("DIM ", u16(W)));
    file.chunks.push(chunk("UNIT", new Uint8Array(36)));
    file.chunks.push(chunk("MTXM", new Uint8Array(2)));
    const a = analyze(input(file));
    expect(byId(a.findings, "repeat:DIM ")).toMatchObject({ level: "warn", repair: { kind: "collapse", name: "DIM " }, recommended: true });
    expect(byId(a.findings, "repeat:DIM ").detail).toContain("last occurrence");
    expect(byId(a.findings, "repeat:UNIT").detail).toContain("every occurrence's records");
    expect(byId(a.findings, "repeat:MTXM").detail).toContain("16-byte buffer");
    // A repeated section's size is judged on the combined bytes, not each piece.
    expect(ids(a.findings).some((i) => i.startsWith("size:MTXM"))).toBe(false);
    // The combined DIM is what the game sees: the last occurrence, a fragment two bytes long, so the height is unreadable.
    expect(byId(a.findings, "dim").title).toContain("4 × ?");
  });

  it("pads and cuts sections to the size the game reads, and trims stray record bytes", () => {
    const file = goodFile();
    file.chunks[at(file, "OWNR")] = chunk("OWNR", new Uint8Array([6, 6]));
    file.chunks[at(file, "MASK")] = chunk("MASK", new Uint8Array(3));
    file.chunks[at(file, "SPRP")] = chunk("SPRP", new Uint8Array(9));
    file.chunks[at(file, "UNIT")] = chunk("UNIT", new Uint8Array(36 + 5));
    const a = analyze(input(file));
    expect(byId(a.findings, `size:OWNR:${at(file, "OWNR")}`)).toMatchObject({ level: "warn", repair: { kind: "resize", size: 12, fill: 0 }, recommended: true });
    expect(byId(a.findings, `size:MASK:${at(file, "MASK")}`)).toMatchObject({ repair: { kind: "resize", size: 8, fill: 0xff } });
    expect(byId(a.findings, `size:MASK:${at(file, "MASK")}`).detail).toContain("fog everywhere");
    expect(byId(a.findings, `size:SPRP:${at(file, "SPRP")}`)).toMatchObject({ repair: { kind: "resize", size: 4 } });
    expect(byId(a.findings, `size:SPRP:${at(file, "SPRP")}`).detail).toContain("ignores the rest");
    expect(byId(a.findings, `stride:UNIT:${at(file, "UNIT")}`)).toMatchObject({ level: "warn", repair: { kind: "trim-records", stride: 36 }, recommended: true });
    expect(byId(a.findings, `stride:UNIT:${at(file, "UNIT")}`).title).toContain("5 stray bytes");
  });
});

describe("missing sections", () => {
  it("names each required section that is not there, on defaults", () => {
    const file = goodFile();
    file.chunks = file.chunks.filter((c) => c.name !== "VCOD" && c.name !== "TRIG");
    const a = analyze(input(file));
    expect(byId(a.findings, "missing:VCOD")).toMatchObject({ level: "error", section: "VCOD", repair: { kind: "insert", name: "VCOD", source: "defaults" }, recommended: true });
    expect(byId(a.findings, "missing:VCOD").title).toBe("VCOD is missing (Verification)");
    expect(byId(a.findings, "missing:TRIG")).toMatchObject({ level: "error" });
    expect(a.counts.error).toBe(2);
  });

  it("restores MTXM from TILE and TILE from MTXM", () => {
    const noMtxm = goodFile();
    noMtxm.chunks = noMtxm.chunks.filter((c) => c.name !== "MTXM");
    expect(byId(analyze(input(noMtxm)).findings, "missing:MTXM")).toMatchObject({ level: "error", repair: { kind: "insert", name: "MTXM", source: { copyOf: "TILE" } } });
    const noTile = goodFile();
    noTile.chunks = noTile.chunks.filter((c) => c.name !== "TILE");
    const f = byId(analyze(input(noTile)).findings, "missing:TILE");
    expect(f).toMatchObject({ level: "warn", repair: { kind: "insert", name: "TILE", source: { copyOf: "MTXM" } }, recommended: true });
    // Neither there: MTXM on defaults, and no TILE finding (there is nothing to copy).
    const neither = goodFile();
    neither.chunks = neither.chunks.filter((c) => c.name !== "TILE" && c.name !== "MTXM");
    const a = analyze(input(neither));
    expect(byId(a.findings, "missing:MTXM").repair).toEqual({ kind: "insert", name: "MTXM", source: "defaults" });
    expect(ids(a.findings)).not.toContain("missing:TILE");
  });
});

describe("header values", () => {
  it("flags an impossible DIM without a repair", () => {
    const file = goodFile();
    file.chunks[at(file, "DIM ")] = chunk("DIM ", u16(300, 0));
    const f = byId(analyze(input(file)).findings, "dim");
    expect(f).toMatchObject({ level: "error", repair: null });
    expect(f.title).toContain("300 × 0");
  });

  it("masks ERA to what the game uses", () => {
    const file = goodFile();
    file.chunks[at(file, "ERA ")] = chunk("ERA ", u16(0xff04));
    const f = byId(analyze(input(file)).findings, "era");
    expect(f).toMatchObject({ level: "info", recommended: true, repair: { kind: "write", index: at(file, "ERA "), bytes: new Uint8Array([4, 0]) } });
    expect(f.title).toBe("ERA is 65284; the game uses 4");
  });

  it("questions VER and puts TYPE right for it", () => {
    const file = goodFile();
    file.chunks[at(file, "VER ")] = chunk("VER ", u16(100));
    file.chunks[at(file, "TYPE")] = chunk("TYPE", text("XXXX"));
    const a = analyze(input(file));
    expect(byId(a.findings, "ver")).toMatchObject({ level: "warn", repair: null });
    expect(byId(a.findings, "type")).toMatchObject({ level: "info", repair: { kind: "write", bytes: text("RAWB") } });
    file.chunks[at(file, "VER ")] = chunk("VER ", u16(59));
    expect(byId(analyze(input(file)).findings, "type").repair).toMatchObject({ bytes: text("RAWS") });
  });

  it("sets unknown player types and races inactive, unticked", () => {
    const file = goodFile();
    file.chunks[at(file, "OWNR")] = chunk("OWNR", new Uint8Array([6, 99, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7]));
    file.chunks[at(file, "SIDE")] = chunk("SIDE", new Uint8Array([5, 5, 200, 7, 7, 7, 7, 7, 7, 7, 7, 201]));
    const a = analyze(input(file));
    const ownr = byId(a.findings, "ownr");
    expect(ownr).toMatchObject({ level: "warn", recommended: false });
    expect(ownr.title).toContain("player 2");
    expect((ownr.repair as { bytes: Uint8Array }).bytes).toEqual(new Uint8Array([6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 7]));
    const side = byId(a.findings, "side");
    expect(side.title).toContain("players 3, 12");
    expect((side.repair as { bytes: Uint8Array }).bytes[2]).toBe(7);
  });
});

describe("tables", () => {
  it("counts string offsets that point outside the table and rebuilds it", () => {
    const file = goodFile();
    const bad = strings(["a", "b", "c"]);
    new DataView(bad.buffer).setUint16(2 * 3, 500, true);
    file.chunks[at(file, "STR ")] = chunk("STR ", bad);
    const f = byId(analyze(input(file)).findings, "str:STR ");
    expect(f).toMatchObject({ level: "warn", repair: { kind: "rebuild", names: ["STR "] }, recommended: true });
    expect(f.title).toBe("1 of 3 string offsets point outside STR");
    // A count the section cannot hold, and the wide table, are the same finding under their own names.
    const tooShort = u16(4000);
    file.chunks[at(file, "STR ")] = chunk("STR ", tooShort);
    expect(byId(analyze(input(file)).findings, "str:STR ").title).toContain("declares 4,000 strings");
    file.chunks.push(chunk("STRx", strings(["x"], true)));
    expect(ids(analyze(input(file)).findings)).not.toContain("str:STRx");
  });

  it("finds unit records the game cannot place and offers to drop them, unticked", () => {
    const file = goodFile();
    const units = new Uint8Array(36 * 3);
    const v = new DataView(units.buffer);
    v.setUint16(8, 0, true); units[10] = 0;
    v.setUint16(36 + 8, 900, true); units[36 + 10] = 1;
    v.setUint16(72 + 8, 7, true); units[72 + 10] = 200;
    file.chunks[at(file, "UNIT")] = chunk("UNIT", units);
    const f = byId(analyze(input(file)).findings, "units");
    expect(f).toMatchObject({ level: "warn", recommended: false });
    expect(f.title).toBe("2 of 3 unit records name a unit type or owner the game does not have");
    expect((f.repair as { bytes: Uint8Array }).bytes).toEqual(units.subarray(0, 36));
  });

  it("notices a VCOD that is not StarEdit's, as an optional restore", () => {
    const file = goodFile();
    file.chunks[at(file, "VCOD")] = chunk("VCOD", new Uint8Array(1040).fill(9));
    const f = byId(analyze(input(file)).findings, "vcod");
    expect(f).toMatchObject({ level: "info", recommended: false, repair: { kind: "write", bytes: VCOD } });
    // Without the editor's table to compare against, nothing is said.
    expect(ids(analyze(input(file, { vcod: null })).findings)).not.toContain("vcod");
  });
});

describe("ISOM and TILE", () => {
  it("rebuilds a missing, wrongly sized or stale ISOM, and says when it cannot", () => {
    const file = goodFile();
    file.chunks = file.chunks.filter((c) => c.name !== "ISOM");
    expect(byId(analyze(input(file, { isom: { present: false, report: null } })).findings, "isom")).toMatchObject({ level: "warn", repair: { kind: "rebuild-isom" }, recommended: true });
    expect(byId(analyze(input(file, { isom: "unchecked" })).findings, "isom")).toMatchObject({ level: "warn", repair: null });
    const wrong = goodFile();
    wrong.chunks[at(wrong, "ISOM")] = chunk("ISOM", new Uint8Array(10));
    const f = byId(analyze(input(wrong, { isom: { present: false, report: null } })).findings, "isom");
    expect(f.title).toBe("ISOM is 10 bytes; a 72-byte lattice fits this map");
    expect(ids(analyze(input(wrong, { isom: "unchecked" })).findings)).not.toContain("isom");
    const stale = byId(analyze(input(goodFile(), { isom: { present: true, report: { rects: 100, mismatched: 30, stale: true } } })).findings, "isom-stale");
    expect(stale).toMatchObject({ level: "warn", repair: { kind: "rebuild-isom" }, recommended: true });
    expect(stale.title).toContain("30%");
  });

  it("tells a zeroed TILE from one that merely differs under doodads", () => {
    const zeroed = goodFile();
    zeroed.chunks[at(zeroed, "TILE")] = chunk("TILE", new Uint8Array(W * H * 2));
    const f = byId(analyze(input(zeroed)).findings, "tile");
    expect(f).toMatchObject({ level: "warn", recommended: true, repair: { kind: "write", index: at(zeroed, "TILE") } });
    expect(f.title).toContain("blank");
    expect((f.repair as { bytes: Uint8Array }).bytes).toEqual(zeroed.chunks[at(zeroed, "MTXM")].data);
    const differs = goodFile();
    const tile = differs.chunks[at(differs, "TILE")].data;
    tile[0] = 0x99;
    const g = byId(analyze(input(differs)).findings, "tile");
    expect(g).toMatchObject({ level: "info", recommended: false });
    expect(g.title).toBe("TILE and MTXM differ on 1 of 8 tiles");
  });
});

describe("order and sorting", () => {
  it("offers StarEdit's order as an optional note, and sorts errors first", () => {
    const file = goodFile();
    const [dim] = file.chunks.splice(at(file, "DIM "), 1);
    file.chunks.push(dim);
    file.chunks = file.chunks.filter((c) => c.name !== "TRIG");
    file.trailing = new Uint8Array([0]);
    const a = analyze(input(file));
    expect(byId(a.findings, "order")).toMatchObject({ level: "info", repair: { kind: "reorder" }, recommended: false });
    expect(a.findings.map((f) => f.level)).toEqual(["error", "info", "info"]);
    expect(a.findings[0].id).toBe("missing:TRIG");
  });
});
