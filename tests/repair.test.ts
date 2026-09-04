import { describe, expect, it } from "vitest";
import { analyze } from "../analyze";
import { chunk, parseChunks, serializeChunks, type ChunkFile } from "../chk";
import { applyRepairs, fit } from "../repair";
import type { SectionKnowledge } from "@scm-js/plugin-api";

const K = (name: string, mode: SectionKnowledge["mode"], size: number | null, stride: number | null = null): SectionKnowledge => ({ name, what: name, mode, size, stride, modelled: true });
const KNOWN: SectionKnowledge[] = [
  K("TYPE", "last", 4), K("VER ", "last", 2), K("VCOD", "last", 1040), K("OWNR", "last", 12), K("ERA ", "last", 2), K("DIM ", "last", 4), K("SIDE", "last", 12),
  K("MTXM", "overlay", 16), K("UNIT", "append", null, 36), K("ISOM", "overlay", 72), K("TILE", "overlay", 16), K("THG2", "append", null, 10), K("MASK", "overlay", 8),
  K("STR ", "last", null), K("MRGN", "overlay", null, 20), K("TRIG", "append", null, 2400), K("SPRP", "last", 4), K("FORC", "last", 20),
];
const ctx = { known: KNOWN, defaults: (name: string) => (name === "VCOD" ? new Uint8Array(1040).fill(1) : name === "TRIG" ? new Uint8Array(0) : name === "FORC" ? new Uint8Array(20) : null) };
const names = (file: ChunkFile) => file.chunks.map((c) => c.name);
const bytes = (...v: number[]) => new Uint8Array(v);
const JUNK = "\x00\x01\x02\x03";

describe("applyRepairs", () => {
  it("fixes lengths, resizes, trims and writes in place, by chunk identity", () => {
    const file: ChunkFile = {
      chunks: [
        { ...chunk("TYPE", bytes(1, 2)), declaredSize: 4, truncated: true },
        chunk("OWNR", bytes(6, 6)),
        chunk("UNIT", new Uint8Array(36 + 3)),
        chunk("MASK", bytes(1, 2, 3)),
        chunk("SPRP", new Uint8Array(9).fill(5)),
      ],
      trailing: null,
    };
    const out = applyRepairs(file, [
      { kind: "fix-length", index: 0 },
      { kind: "resize", index: 1, size: 12, fill: 0 },
      { kind: "trim-records", index: 2, stride: 36 },
      { kind: "resize", index: 3, size: 8, fill: 0xff },
      { kind: "resize", index: 4, size: 4, fill: 0 },
      { kind: "write", index: 1, bytes: bytes(7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7, 7) },
    ], ctx);
    expect(out.skipped).toEqual([]);
    expect(out.file.chunks[0]).toMatchObject({ declaredSize: 2, truncated: false });
    expect(out.file.chunks[1].data).toEqual(new Uint8Array(12).fill(7));
    expect(out.file.chunks[2].data).toHaveLength(36);
    expect(out.file.chunks[3].data).toEqual(bytes(1, 2, 3, 0xff, 0xff, 0xff, 0xff, 0xff));
    expect(out.file.chunks[4].data).toEqual(new Uint8Array(4).fill(5));
    // The input is untouched.
    expect(file.chunks[1].data).toEqual(bytes(6, 6));
    expect(file.chunks[0].truncated).toBe(true);
  });

  it("removes and collapses, keeping later indices valid", () => {
    const file: ChunkFile = {
      chunks: [
        chunk(JUNK, bytes(9)),
        chunk("DIM ", bytes(4, 0, 2, 0)),
        chunk("MTXM", new Uint8Array(16).fill(1)),
        chunk("DIM ", bytes(8, 0)),
        chunk("MTXM", bytes(2, 2)),
        chunk("UNIT", new Uint8Array(36).fill(3)),
        chunk("UNIT", new Uint8Array(36).fill(4)),
        chunk(JUNK, bytes(9)),
      ],
      trailing: null,
    };
    const out = applyRepairs(file, [
      { kind: "remove", index: 0 },
      { kind: "collapse", name: "DIM " },
      { kind: "collapse", name: "MTXM" },
      { kind: "collapse", name: "UNIT" },
      { kind: "remove", index: 7 },
    ], ctx);
    expect(names(out.file)).toEqual(["DIM ", "MTXM", "UNIT"]);
    // last: the fragment; overlay: the 16-byte buffer with the fragment over its front; append: both records.
    expect(out.file.chunks[0].data).toEqual(bytes(8, 0));
    expect(out.file.chunks[1].data).toEqual(new Uint8Array([2, 2, ...new Uint8Array(14).fill(1)]));
    expect(out.file.chunks[2].data).toHaveLength(72);
    expect(out.file.chunks[2].data[0]).toBe(3);
    expect(out.file.chunks[2].data[36]).toBe(4);
    expect(applyRepairs(file, [{ kind: "remove", index: 99 }], ctx).skipped).toEqual(["no section at 99"]);
  });

  it("inserts missing sections where StarEdit puts them, from defaults or a copy", () => {
    const file: ChunkFile = { chunks: [chunk("VER ", bytes(205, 0)), chunk("DIM ", bytes(4, 0, 2, 0)), chunk("MTXM", new Uint8Array(16).fill(1)), chunk("SPRP", bytes(1, 0, 2, 0))], trailing: null };
    const out = applyRepairs(file, [
      { kind: "insert", name: "VCOD", source: "defaults" },
      { kind: "insert", name: "TILE", source: { copyOf: "MTXM" } },
      { kind: "insert", name: "FORC", source: "defaults" },
      { kind: "insert", name: "STR ", source: "defaults" },
      { kind: "insert", name: "MYSC", source: { copyOf: "DIM " } },
    ], ctx);
    expect(names(out.file)).toEqual(["VER ", "VCOD", "DIM ", "MTXM", "TILE", "SPRP", "FORC", "MYSC"]);
    expect(out.file.chunks[1].data).toEqual(new Uint8Array(1040).fill(1));
    expect(out.file.chunks[4].data).toEqual(new Uint8Array(16).fill(1));
    expect(out.skipped).toEqual(["nothing to write for STR"]);
    // A copy that is the wrong size for its new name is fitted to what the game reads.
    const short = applyRepairs({ chunks: [chunk("MTXM", bytes(1, 1))], trailing: null }, [{ kind: "insert", name: "TILE", source: { copyOf: "MTXM" } }], ctx);
    expect(short.file.chunks[1].data).toEqual(new Uint8Array([1, 1, ...new Uint8Array(14)]));
  });

  it("drops or recovers trailing bytes and reorders", () => {
    const tail = serializeChunks({ chunks: [chunk("STR ", bytes(1, 0)), chunk("UNIT", new Uint8Array(0))], trailing: null });
    const file: ChunkFile = { chunks: [chunk("MTXM", new Uint8Array(16)), chunk("DIM ", bytes(4, 0, 2, 0)), chunk("ZZZZ", bytes(1)), chunk("TYPE", bytes(82, 65, 87, 66))], trailing: tail };
    const recovered = applyRepairs(file, [{ kind: "recover-trailing" }, { kind: "reorder" }], ctx);
    expect(recovered.file.trailing).toBeNull();
    expect(names(recovered.file)).toEqual(["TYPE", "DIM ", "MTXM", "UNIT", "STR ", "ZZZZ"]);
    const dropped = applyRepairs(file, [{ kind: "drop-trailing" }], ctx);
    expect(dropped.file.trailing).toBeNull();
    expect(names(dropped.file)).toEqual(names(file));
    expect(applyRepairs({ chunks: [], trailing: null }, [{ kind: "recover-trailing" }], ctx).skipped).toEqual(["no trailing bytes"]);
  });

  it("hands the host repairs back instead of applying them", () => {
    const out = applyRepairs({ chunks: [], trailing: null }, [{ kind: "rebuild", names: ["STR "] }, { kind: "rebuild", names: ["STR ", "MTXM"] }, { kind: "rebuild-isom" }], ctx);
    expect(out.rebuild).toEqual(["STR ", "MTXM"]);
    expect(out.rebuildIsom).toBe(true);
    expect(fit(bytes(1, 2, 3), 2, 0)).toEqual(bytes(1, 2));
    expect(fit(bytes(1), 3, 9)).toEqual(bytes(1, 9, 9));
  });

  it("takes a protected file to one the analysis has nothing to say about", () => {
    const good: ChunkFile = {
      chunks: [
        chunk("TYPE", bytes(82, 65, 87, 66)), chunk("VER ", bytes(205, 0)), chunk("VCOD", new Uint8Array(1040).fill(1)), chunk("OWNR", new Uint8Array(12)), chunk("ERA ", bytes(4, 0)),
        chunk("DIM ", bytes(4, 0, 2, 0)), chunk("SIDE", new Uint8Array(12).fill(7)), chunk("MTXM", new Uint8Array(16).fill(1)), chunk("UNIT", new Uint8Array(0)), chunk("ISOM", new Uint8Array(72)),
        chunk("TILE", new Uint8Array(16).fill(1)), chunk("THG2", new Uint8Array(0)), chunk("MASK", new Uint8Array(8).fill(0xff)), chunk("STR ", bytes(1, 0, 4, 0, 0)), chunk("MRGN", new Uint8Array(20 * 64)),
        chunk("TRIG", new Uint8Array(0)), chunk("SPRP", bytes(0, 0, 0, 0)), chunk("FORC", new Uint8Array(20)),
      ],
      trailing: null,
    };
    const required = ["VER ", "VCOD", "OWNR", "ERA ", "DIM ", "SIDE", "MTXM", "UNIT", "THG2", "STR ", "MRGN", "TRIG", "SPRP", "FORC"];
    const isom = { present: true, report: { rects: 8, mismatched: 0, stale: false } };
    const vcod = new Uint8Array(1040).fill(1);
    expect(analyze({ file: good, known: KNOWN, required, vcod, isom }).findings).toEqual([]);

    // Protect it: strip VCOD and TILE, repeat DIM, oversize ERA (the value the game reads is still 4), add junk, a negative header and the rest behind it.
    const protectedChunks = good.chunks.filter((c) => c.name !== "VCOD" && c.name !== "TILE" && c.name !== "TRIG" && c.name !== "FORC");
    const dimAt = protectedChunks.findIndex((c) => c.name === "DIM ");
    protectedChunks.splice(dimAt + 1, 0, chunk("DIM ", bytes(4, 0, 2, 0)));
    protectedChunks[protectedChunks.findIndex((c) => c.name === "ERA ")] = chunk("ERA ", bytes(4, 0, 0xff, 0xff));
    protectedChunks.push(chunk(JUNK, bytes(1, 2, 3)));
    const head = serializeChunks({ chunks: protectedChunks, trailing: null });
    const tail = serializeChunks({ chunks: [chunk("TRIG", new Uint8Array(0)), chunk("FORC", new Uint8Array(20))], trailing: null });
    const all = new Uint8Array(head.length + 8 + tail.length);
    all.set(head);
    all.set([0x41, 0x42, 0x43, 0x44, 0xff, 0xff, 0xff, 0xff], head.length);
    all.set(tail, head.length + 8);

    // Round one: the recommended byte-level repairs.
    let file = parseChunks(all);
    let a = analyze({ file, known: KNOWN, required, vcod, isom });
    expect(a.findings.map((f) => f.id).sort()).toEqual(
      ["junk-name:15", "missing:FORC", "missing:TILE", "missing:TRIG", "missing:VCOD", "negative:16", "repeat:DIM ", "size:ERA :3", "trailing"].sort(),
    );
    const out = applyRepairs(file, a.findings.filter((f) => f.recommended && f.repair).map((f) => f.repair!), ctx);
    expect(out.skipped).toEqual([]);
    file = parseChunks(serializeChunks(out.file));
    // Round two: the recovered sections and the ones inserted on defaults are now repeats of each other.
    a = analyze({ file, known: KNOWN, required, vcod, isom });
    expect(a.findings.map((f) => f.id).sort()).toEqual(["repeat:FORC", "repeat:TRIG"]);
    file = parseChunks(serializeChunks(applyRepairs(file, a.findings.map((f) => f.repair!), ctx).file));
    a = analyze({ file, known: KNOWN, required, vcod, isom });
    expect(a.findings).toEqual([]);
    // Recovered and inserted sections alike landed where StarEdit puts them.
    expect(names(file)).toEqual(["TYPE", "VER ", "VCOD", "OWNR", "ERA ", "DIM ", "SIDE", "MTXM", "UNIT", "ISOM", "TILE", "THG2", "MASK", "STR ", "MRGN", "TRIG", "SPRP", "FORC"]);
    expect(file.chunks.find((c) => c.name === "ERA ")!.data).toEqual(bytes(4, 0));
    expect(file.chunks.find((c) => c.name === "TILE")!.data).toEqual(new Uint8Array(16).fill(1));
  });
});
