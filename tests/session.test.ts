import { describe, expect, it } from "vitest";
import type { DocumentEvent, PluginApi } from "@scm-js/plugin-api";
import type { Analysis, Finding } from "../analyze";
import { english } from "../i18n";
import { Session } from "../plugin";

const finding = (id: string, recommended: boolean, level: Finding["level"] = "warn"): Finding => ({
  id, level, section: "MTXM", title: id, detail: "", repair: { kind: "remove", index: 0 }, recommended,
});

/**
 * Just enough editor for the document events: several maps, each with its file's bytes,
 * one in front. `mode` is the stored choice for a map opening; `findings` what every
 * check finds. The dialog is never drawn here, and a repair is recorded rather than run.
 */
function editor(options: { mode?: string; findings?: Finding[]; modified?: boolean; shared?: boolean } = {}) {
  const files = new Map<number, Uint8Array>();
  let front: number | null = null;
  const replaced: { id: number | null; bytes: Uint8Array }[] = [];
  const repairs: { ids: string[]; asOpened: boolean }[] = [];
  const cell: { text: string | null; warn: boolean } = { text: null, warn: false };
  const dialogs: number[] = [];
  const stored: Record<string, unknown> = { "on-open": options.mode ?? "off" };
  const api = {
    i18n: { t: english },
    storage: { get: (key: string, fallback: unknown) => (key in stored ? stored[key] : fallback) },
    sync: { current: () => (options.shared ? {} : null) },
    ui: {
      status: () => {},
      dialog: () => { dialogs.push(front!); return { isOpen: () => false, close: () => {}, setBusy: () => {}, setTitle: () => {} }; },
      statusItem: (spec: { text: string; warn?: boolean }) => {
        Object.assign(cell, { text: spec.text, warn: spec.warn ?? false });
        return { set: (p: { text?: string; warn?: boolean }) => Object.assign(cell, p), remove: () => { cell.text = null; }, isShown: () => cell.text !== null };
      },
    },
    document: {
      isOpen: () => front !== null,
      list: () => [...files.keys()].map((id) => ({ id, active: id === front })),
      info: () => ({ modified: options.modified ?? false, fileName: null, name: "m" }),
      sections: {
        file: () => files.get(front!)!,
        replaceFile: (bytes: Uint8Array) => { replaced.push({ id: front, bytes }); return { warnings: [] }; },
      },
    },
  } as unknown as PluginApi;
  const session = new Session(api);
  const internals = session as unknown as { gather: () => Promise<Analysis>; repair: (chosen: Finding[], asOpened: boolean) => Promise<void>; done: Finding[] };
  // `gather` needs the whole editor; what Restore original writes is what these tests read.
  internals.gather = async () => {
    const findings = options.findings ?? [];
    const counts = { error: 0, warn: 0, info: 0 };
    for (const f of findings) counts[f.level]++;
    return { counts, findings };
  };
  internals.repair = async (chosen, asOpened) => {
    repairs.push({ ids: chosen.map((f) => f.id), asOpened });
    internals.done = [...internals.done, ...chosen];
  };
  const event = (e: DocumentEvent) => session.onDocument(e);
  return {
    session,
    replaced,
    repairs,
    cell,
    dialogs,
    open(id: number, bytes: number[]) { files.set(id, new Uint8Array(bytes)); front = id; event({ reason: "open", fileName: `${id}.scx`, id }); },
    /** A repair happened: the file in front changed, and Repair knows it did. */
    repair(bytes: number[]) {
      files.set(front!, new Uint8Array(bytes));
      internals.done = [finding("fixed", true)];
      event({ reason: "replace", fileName: null, id: front });
    },
    switchTo(id: number) { front = id; event({ reason: "switch", fileName: `${id}.scx`, id }); },
    close(id: number, next: number | null) { files.delete(id); front = next; event({ reason: next === null ? "close" : "switch", fileName: null, id: next }); },
    restore: () => (session as unknown as { restore: () => Promise<void> }).restore(),
    repaired: () => internals.done.length > 0,
  };
}

/** Past the `setTimeout` the open waits on, and the check it starts. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

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

describe("Repair when a map opens", () => {
  it("repairs the safe findings as the file that was opened, and leaves the rest to the status bar", async () => {
    const ed = editor({ mode: "auto", findings: [finding("safe", true), finding("call", false), finding("note", false, "info")] });
    ed.open(1, [1]);
    await settle();
    expect(ed.repairs).toEqual([{ ids: ["safe"], asOpened: true }]);
    expect(ed.dialogs).toEqual([]);
  });

  it("does not repair a map the user already changed, or a shared one", async () => {
    for (const ed of [editor({ mode: "auto", modified: true, findings: [finding("safe", true)] }), editor({ mode: "auto", shared: true, findings: [finding("safe", true)] })]) {
      ed.open(1, [1]);
      await settle();
      expect(ed.repairs).toEqual([]);
      expect(ed.cell).toEqual({ text: "Repair: 1 to fix", warn: true });
    }
  });

  it("asks first when told to, and only about something worth asking", async () => {
    const ed = editor({ mode: "ask", findings: [finding("safe", true)] });
    ed.open(1, [1]);
    await settle();
    expect(ed.repairs).toEqual([]);
    expect(ed.dialogs).toEqual([1]);
    const quiet = editor({ mode: "ask", findings: [finding("note", false, "info")] });
    quiet.open(1, [1]);
    await settle();
    expect(quiet.dialogs).toEqual([]);
    expect(quiet.cell.text).toBeNull();
  });

  it("does nothing when told not to check", async () => {
    const ed = editor({ mode: "off", findings: [finding("safe", true)] });
    ed.open(1, [1]);
    await settle();
    expect(ed.repairs).toEqual([]);
    expect(ed.cell.text).toBeNull();
  });

  it("takes the status cell away with the map", async () => {
    const ed = editor({ mode: "ask", findings: [finding("call", false)] });
    ed.open(1, [1]);
    await settle();
    expect(ed.cell).toEqual({ text: "Repair: 1 to review", warn: true });
    ed.close(1, null);
    expect(ed.cell.text).toBeNull();
  });
});
