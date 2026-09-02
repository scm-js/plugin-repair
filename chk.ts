/**
 * The CHK container, read the way the game reads it: a flat run of chunks, each a
 * four-character name, a signed 32-bit length and that many bytes. Nothing here knows
 * what any section means — that is `analyze.ts` — and nothing touches the editor, so
 * the tests run over bytes alone. The rules match the editor's own reader: a chunk
 * whose length runs past the end of the file keeps what is there and is marked
 * `truncated`; a negative length stops the read and everything after the header is
 * `trailing`.
 */

export interface Chunk {
  /** Four characters as stored, latin1; may be junk in a protected map. */
  name: string;
  /** Byte offset of the eight-byte header within the file. */
  offset: number;
  /** The length field as written, which may disagree with `data.length`. */
  declaredSize: number;
  data: Uint8Array;
  /** The declared length ran past the end of the file (or was negative). */
  truncated: boolean;
}

export interface ChunkFile {
  chunks: Chunk[];
  /** Bytes after the last chunk header the reader could act on; null when the file ends cleanly. */
  trailing: Uint8Array | null;
}

const decoder = new TextDecoder("latin1");
const MAX_CHUNKS = 20000;

export function parseChunks(bytes: Uint8Array): ChunkFile {
  const chunks: Chunk[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 0;
  while (pos + 8 <= bytes.length && chunks.length < MAX_CHUNKS) {
    const offset = pos;
    const name = decoder.decode(bytes.subarray(pos, pos + 4));
    const declaredSize = view.getInt32(pos + 4, true);
    pos += 8;
    if (declaredSize < 0) {
      chunks.push({ name, offset, declaredSize, data: new Uint8Array(0), truncated: true });
      return { chunks, trailing: bytes.slice(pos) };
    }
    const available = Math.min(declaredSize, bytes.length - pos);
    chunks.push({ name, offset, declaredSize, data: bytes.slice(pos, pos + available), truncated: available < declaredSize });
    pos += available;
  }
  return { chunks, trailing: pos < bytes.length ? bytes.slice(pos) : null };
}

/** Write the chunks back, each with the length of the data it actually carries, then the trailing bytes. */
export function serializeChunks(file: ChunkFile): Uint8Array {
  let total = file.trailing?.length ?? 0;
  for (const c of file.chunks) total += 8 + c.data.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let pos = 0;
  for (const c of file.chunks) {
    for (let i = 0; i < 4; i++) out[pos + i] = c.name.charCodeAt(i) & 0xff;
    view.setInt32(pos + 4, c.data.length, true);
    pos += 8;
    out.set(c.data, pos);
    pos += c.data.length;
  }
  if (file.trailing) out.set(file.trailing, pos);
  return out;
}

/** A fresh chunk with the length its data has. */
export function chunk(name: string, data: Uint8Array): Chunk {
  return { name: padName(name), offset: -1, declaredSize: data.length, data, truncated: false };
}

/** Section names are four characters; shorter ones are padded with spaces, as the game's own are. */
export function padName(name: string): string {
  return name.padEnd(4, " ").slice(0, 4);
}

/** Whether a name is made of the printable ASCII the game's own sections use. */
export function readableName(name: string): boolean {
  return name.length === 4 && [...name].every((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) <= 0x7e);
}

/** Every occurrence of a name, in file order. */
export function named(file: ChunkFile, name: string): Chunk[] {
  return file.chunks.filter((c) => c.name === name);
}

export type CombineMode = "overlay" | "append" | "last" | "first";

/**
 * The bytes the game acts on for a repeated section: `overlay` copies each occurrence
 * over the front of a zeroed fixed buffer in file order, `append` keeps every record,
 * `last` / `first` take one occurrence. Null when the name is absent.
 */
export function combine(parts: Chunk[], mode: CombineMode, size?: number | null): Uint8Array | null {
  if (parts.length === 0) return null;
  switch (mode) {
    case "first": return parts[0].data.slice();
    case "last": return parts[parts.length - 1].data.slice();
    case "append": {
      const out = new Uint8Array(parts.reduce((n, p) => n + p.data.length, 0));
      let pos = 0;
      for (const p of parts) { out.set(p.data, pos); pos += p.data.length; }
      return out;
    }
    case "overlay": {
      const width = size ?? Math.max(...parts.map((p) => p.data.length));
      const out = new Uint8Array(width);
      for (const p of parts) out.set(p.data.subarray(0, width), 0);
      return out;
    }
  }
}

export const u16 = (b: Uint8Array, at: number) => (at + 2 <= b.length ? b[at] | (b[at + 1] << 8) : null);
export const u32 = (b: Uint8Array, at: number) => (at + 4 <= b.length ? (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0 : null);
