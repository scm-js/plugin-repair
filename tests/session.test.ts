import { describe, expect, it } from "vitest";
import type { DocumentEvent, PluginApi } from "@scm-js/plugin-api";
import { Session } from "../plugin";

/**
 * Just enough editor for the document events: several maps, each with its file's bytes,
 * one in front. The check on open is turned off, so no dialog is drawn.
 */
function editor() {
  const files = new Map<number, Uint8Array>();
  let front: number | null = null;
  const replaced: { id: number | null; bytes: Uint8Array }[] = [];
  const api = {
    i18n: { t: (text: string) => text },
    storage: { get: () => false },
    ui: { status: () => {} },
    document: {
      isOpen: () => front !== null,
      list: () => [...files.keys()].map((id) => ({ id, active: id === front })),
      info: () => null,
      sections: {
        file: () => files.get(front!)!,
        replaceFile: (bytes: Uint8Array) => { replaced.push({ id: front, bytes }); return { warnings: [] }; },
      },
    },
  } as unknown as PluginApi;
  const session = new Session(api);
  // `gather` needs the whole editor; what Restore original writes is what these tests read.
  (session as unknown as { gather: () => Promise<unknown> }).gather = async () => ({ counts: { error: 0, warn: 0, info: 0 }, findings: [] });
  const event = (e: DocumentEvent) => session.onDocument(e);
  return {
    session,
    replaced,
    open(id: number, bytes: number[]) { files.set(id, new Uint8Array(bytes)); front = id; event({ reason: "open", fileName: `${id}.scx`, id }); },
    /** A repair happened: the file in front changed, and Repair knows it did. */
    repair(bytes: number[]) {
      files.set(front!, new Uint8Array(bytes));
      (session as unknown as { repaired: boolean }).repaired = true;
      event({ reason: "replace", fileName: null, id: front });
    },
    switchTo(id: number) { front = id; event({ reason: "switch", fileName: `${id}.scx`, id }); },
    close(id: number, next: number | null) { files.delete(id); front = next; event({ reason: next === null ? "close" : "switch", fileName: null, id: next }); },
    restore: () => (session as unknown as { restore: () => Promise<void> }).restore(),
    repaired: () => (session as unknown as { repaired: boolean }).repaired,
  };
}

describe("Repair with several maps open", () => {
  it("keeps a map's original while another map is in front", async () => {
    const ed = editor();
    ed.open(1, [1, 1]);
    ed.repair([1, 9]);
    ed.open(2, [2, 2]);
    expect(ed.repaired()).toBe(false);
    ed.switchTo(1);
    expect(ed.repaired()).toBe(true);
    await ed.restore();
    expect(ed.replaced).toEqual([{ id: 1, bytes: new Uint8Array([1, 1]) }]);
  });

  it("gives each map its own original", async () => {
    const ed = editor();
    ed.open(1, [1, 1]);
    ed.repair([1, 9]);
    ed.open(2, [2, 2]);
    ed.repair([2, 9]);
    ed.switchTo(1);
    ed.switchTo(2);
    await ed.restore();
    expect(ed.replaced).toEqual([{ id: 2, bytes: new Uint8Array([2, 2]) }]);
  });

  it("forgets a map that closed", () => {
    const ed = editor();
    ed.open(1, [1, 1]);
    ed.repair([1, 9]);
    ed.open(2, [2, 2]);
    ed.close(1, 2);
    ed.close(2, null);
    expect((ed.session as unknown as { parked: Map<number, unknown> }).parked.size).toBe(0);
  });

  it("starts afresh when a file opens in place of the map in front", () => {
    const ed = editor();
    ed.open(1, [1, 1]);
    ed.repair([1, 9]);
    ed.open(1, [3, 3]);
    expect(ed.repaired()).toBe(false);
  });
});
