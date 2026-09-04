/**
 * Repair — a plugin for the scmJS map editor (https://github.com/jeany55/scm-js).
 *
 * When a map opens, the plugin reads the file the way the game does — every section,
 * its declared and real length, repeats, the values in the headers and tables — and
 * lists what is missing, damaged or odd, each finding saying what the game does with
 * the file as it is and what fixing it would change. Tick what you want and press
 * Repair; the original bytes stay in memory until the next map opens, so Restore
 * original undoes the lot. Tools ▸ Repair Map… runs the same check by hand.
 *
 * `chk.ts` reads the container, `analyze.ts` turns a chunk list into findings and
 * `repair.ts` applies the byte-level ones — all pure, all tested; this file gathers the
 * inputs from the editor, shows the dialog and runs the two repairs that need the
 * editor's model (`api.document.sections.rebuild`, `tx.rebuildIsom`).
 * `@scm-js/plugin-api` is the editor's type declarations, a devDependency generated from
 * its own `src/plugins/api.ts`; the host erases the type-only import.
 */
import type { DialogHandle, DocumentEvent, PluginApi } from "@scm-js/plugin-api";
import { analyze, describeName, type Analysis, type Finding, type IsomFacts, type Level } from "./analyze";
import { parseChunks, readableName, serializeChunks } from "./chk";
import { applyRepairs } from "./repair";

export default function activate(api: PluginApi) {
  const session = new Session(api);
  api.commands.register({ id: "check", title: "Repair Map…", enabled: () => api.document.isOpen(), run: () => { void session.check(false); } });
  api.menu.add("Tools", { label: "Repair Map…", after: "Check Map…", enabled: () => api.document.isOpen(), command: "check" });
  api.events.on("document", (e) => session.onDocument(e));
  return () => session.dispose();
}

const ASK_KEY = "ask-on-open";
const LEVEL_LABEL: Record<Level, string> = { error: "error", warn: "warning", info: "note" };

const STYLE = `
.rp { display: flex; flex-direction: column; gap: 8px; font-size: 12px; min-height: 0; }
.rp .rp-head { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: baseline; line-height: 1.4; }
.rp .rp-head b { color: var(--text, #e6e9ef); }
.rp .rp-dim { color: var(--text-dim, #99a2b3); }
.rp .rp-list { display: flex; flex-direction: column; border: 1px solid var(--border, #333); border-radius: 4px; background: var(--bg-0, #0f1115); max-height: 46vh; overflow: auto; }
.rp .rp-item { display: flex; flex-direction: column; gap: 3px; padding: 6px 8px; border-bottom: 1px solid rgba(255,255,255,.05); }
.rp .rp-item:last-child { border-bottom: none; }
.rp .rp-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.rp .rp-row > label { flex: 1; min-width: 0; }
.rp .rp-badge { flex: none; width: 58px; text-align: center; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; padding: 1px 0; border-radius: 3px; border: 1px solid transparent; }
.rp .rp-badge.error { color: #ff8a7a; border-color: rgba(255,90,74,.5); }
.rp .rp-badge.warn { color: #ffcf7a; border-color: rgba(230,185,92,.5); }
.rp .rp-badge.info { color: var(--text-dim, #99a2b3); border-color: var(--border, #333); }
.rp .rp-sec { flex: none; width: 40px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--gold, #e6b95c); white-space: pre; }
.rp .rp-detail { margin-left: 114px; color: var(--text-dim, #99a2b3); line-height: 1.4; }
.rp .rp-none { padding: 12px 8px; color: var(--text-faint, #6b7382); }
.rp .rp-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.rp .rp-actions .rp-grow { flex: 1; }
.rp .rp-log { color: var(--text-dim, #99a2b3); line-height: 1.4; white-space: pre-wrap; }
.rp .rp-foot { display: flex; align-items: center; gap: 10px; color: var(--text-faint, #6b7382); }
`;

class Session {
  private handle: DialogHandle | null = null;
  private body: HTMLElement | null = null;
  private analysis: Analysis | null = null;
  private ticks = new Map<string, boolean>();
  private original: { fileName: string | null; bytes: Uint8Array } | null = null;
  private repaired = false;
  private log: string[] = [];
  private busy = false;
  /** Bumped on every open / close so a check still gathering for the previous map throws its result away. */
  private generation = 0;

  private readonly api: PluginApi;

  constructor(api: PluginApi) { this.api = api; }

  private get askOnOpen(): boolean { return this.api.storage.get(ASK_KEY, true); }

  onDocument(e: DocumentEvent) {
    if (e.reason === "replace") return;
    this.generation++;
    this.original = null;
    this.repaired = false;
    this.log = [];
    this.ticks.clear();
    // Whatever dialog was up was about the map that just went.
    this.handle?.close();
    if (e.reason !== "open") return;
    // The bytes as they came in, before any repair; kept until the next map.
    this.original = { fileName: e.fileName, bytes: this.api.document.sections.file() };
    // The editor is still installing the document when the event fires; let it finish.
    if (this.askOnOpen) setTimeout(() => { void this.check(true); }, 0);
  }

  dispose() { this.handle?.close(); }

  /** Analyse the open map; `auto` (on open) only shows the dialog when something is wrong. */
  async check(auto: boolean) {
    const { api } = this;
    if (!api.document.isOpen() || this.busy) return;
    this.original ??= { fileName: api.document.info()?.fileName ?? null, bytes: api.document.sections.file() };
    const generation = this.generation;
    this.busy = true;
    try {
      const analysis = await this.gather();
      if (generation !== this.generation) return;
      this.analysis = analysis;
      const { counts } = analysis;
      if (auto && counts.error + counts.warn === 0) {
        if (counts.info > 0) api.ui.status(`Repair: nothing wrong with ${this.name()}; ${plural(counts.info, "note")} (Tools ▸ Repair Map…).`);
        return;
      }
      if (this.handle?.isOpen()) this.render(); else this.open();
    } finally {
      this.busy = false;
    }
  }

  private name(): string { return this.api.document.info()?.fileName ?? this.api.document.info()?.name ?? "the map"; }

  private async gather(): Promise<Analysis> {
    const { sections } = this.api.document;
    const file = parseChunks(sections.file());
    const known = sections.known();
    const required = sections.required();
    const vcod = sections.defaults("VCOD");
    let isom: IsomFacts | "unchecked";
    try {
      const report = await this.api.terrain.checkIsom();
      isom = { present: this.api.terrain.hasIsom(), report };
    } catch {
      isom = "unchecked";
    }
    return analyze({ file, known, required, vcod, isom, strings: this.api.query.strings(), text: this.api.text });
  }

  /* ── The dialog ─────────────────────────────────────────── */

  private open() {
    this.handle = this.api.ui.dialog({
      title: "Repair Map",
      size: "lg",
      mount: (body) => {
        this.body = body;
        this.render();
        return () => { this.body = null; this.handle = null; };
      },
    });
  }

  private selected(): Finding[] {
    return (this.analysis?.findings ?? []).filter((f) => f.repair && (this.ticks.get(f.id) ?? f.recommended));
  }

  private render() {
    const { api, body, analysis } = this;
    if (!body || !analysis) return;
    const { el, widgets } = api.ui;
    body.replaceChildren();
    const root = el("div", { className: "rp" }, el("style", {}, STYLE));

    const { counts, findings } = analysis;
    const total = findings.length;
    const summary = total === 0
      ? "Nothing to repair."
      : [counts.error && plural(counts.error, "error"), counts.warn && plural(counts.warn, "warning"), counts.info && plural(counts.info, "note")].filter(Boolean).join(", ");
    root.append(el("div", { className: "rp-head" }, el("b", {}, this.name()), el("span", { className: "rp-dim" }, summary)));

    const list = el("div", { className: "rp-list" });
    if (total === 0) list.append(el("div", { className: "rp-none" }, "Every section is where the game expects it, at the size it reads, with nothing repeated or left over."));
    for (const f of findings) {
      const tick = widgets.checkbox(f.title, {
        value: f.repair ? (this.ticks.get(f.id) ?? f.recommended) : false,
        disabled: !f.repair,
        title: f.repair ? (f.recommended ? "Recommended" : "Optional — read the note first") : "Nothing the plugin can do about this one",
        onChange: (v) => { this.ticks.set(f.id, v); this.updateRepairButton(); },
      });
      const row = el("div", { className: "rp-row" },
        el("span", { className: `rp-badge ${f.level}`, title: LEVEL_LABEL[f.level] }, LEVEL_LABEL[f.level]),
        el("span", { className: "rp-sec", title: f.section ? (readableName(f.section) ? api.document.sections.spec(f.section)?.what ?? "" : describeName(f.section)) : "the file" }, f.section ? (readableName(f.section) ? f.section : "????") : "file"),
        tick,
      );
      list.append(el("div", { className: "rp-item" }, row, el("div", { className: "rp-detail" }, f.detail)));
    }
    root.append(list);

    const repairable = findings.filter((f) => f.repair);
    const setAll = (pick: (f: Finding) => boolean) => { for (const f of repairable) this.ticks.set(f.id, pick(f)); this.render(); };
    this.repairButton = widgets.button("Repair", { primary: true, onClick: () => { void this.repair(); } });
    const actions = el("div", { className: "rp-actions" },
      widgets.button("Recommended", { ghost: true, disabled: repairable.length === 0, title: "Tick the repairs that only write what the game already does, or restore what the editor needs", onClick: () => setAll((f) => f.recommended) }),
      widgets.button("All", { ghost: true, disabled: repairable.length === 0, onClick: () => setAll(() => true) }),
      widgets.button("None", { ghost: true, disabled: repairable.length === 0, onClick: () => setAll(() => false) }),
      el("span", { className: "rp-grow" }),
      this.original && this.repaired
        ? widgets.button("Restore original", { title: "Put the file back as it was when it opened", onClick: () => { void this.restore(); } })
        : null,
      this.repairButton,
    );
    root.append(actions);
    this.updateRepairButton();

    if (this.log.length > 0) root.append(el("div", { className: "rp-log" }, this.log.join("\n")));

    root.append(el("div", { className: "rp-foot" },
      widgets.checkbox("Check maps when they open", { value: this.askOnOpen, onChange: (v) => api.storage.set(ASK_KEY, v) }),
      el("span", {}, "A repair rewrites the file and clears the undo history, as Section Explorer and Resize do."),
    ));
    body.append(root);
  }

  private repairButton: HTMLButtonElement | null = null;

  private updateRepairButton() {
    const n = this.selected().length;
    if (!this.repairButton) return;
    this.repairButton.textContent = n === 0 ? "Repair" : `Repair ${n} selected`;
    this.repairButton.disabled = n === 0 || this.busy;
  }

  /* ── Doing it ───────────────────────────────────────────── */

  private async repair() {
    const { api } = this;
    const chosen = this.selected();
    if (chosen.length === 0 || this.busy || !api.document.isOpen()) return;
    const { sections } = api.document;
    const generation = this.generation;
    this.busy = true;
    this.updateRepairButton();
    const done: string[] = [];
    try {
      const outcome = applyRepairs(parseChunks(sections.file()), chosen.map((f) => f.repair!), { known: sections.known(), defaults: (n) => sections.defaults(n) });
      const hostRepairs = new Set(["rebuild", "rebuild-isom", "set-strings"]);
      const byteLevel = chosen.filter((f) => !hostRepairs.has(f.repair!.kind));
      if (byteLevel.length > 0) {
        const r = sections.replaceFile(serializeChunks(outcome.file));
        done.push(`${plural(byteLevel.length, "repair")} written to the file${r.warnings.length > 0 ? ` — the parser still says: ${r.warnings.join("; ")}` : ""}`);
      }
      // After `replaceFile`, which installs a whole new scenario and would drop this, and
      // before `rebuild`, which re-encodes STR from the model this writes into. The strings
      // are read again here rather than carried in the repair, since the byte-level pass
      // above may have moved them.
      if (outcome.setStrings) {
        let fixed = 0;
        let lines = 0;
        const r = api.document.update("Fix string colours", (tx) => {
          for (const [index, entry] of tx.strings.list().entries()) {
            if (entry === null) continue;
            const next = api.text.fixBleeding(entry);
            if (next === entry) continue;
            lines += api.text.bleedingLines(entry).length;
            tx.strings.set(index, next);
            fixed++;
          }
          tx.note(`${plural(fixed, "string")} given the line-break colour reset`);
        });
        done.push(fixed === 0
          ? "the strings already read the same in both games"
          : `${plural(fixed, "string")} given the reset 1.16.1 supplied at ${plural(lines, "line break")}${r.changed ? "" : " (nothing changed)"}`);
      }
      if (outcome.rebuild.length > 0) {
        const r = sections.rebuild(outcome.rebuild);
        done.push(r.rebuilt.length > 0 ? `${r.rebuilt.map((n) => n.trim()).join(", ")} rebuilt from the editor's model` : "nothing to rebuild");
      }
      if (outcome.rebuildIsom) {
        let note = "the ISOM could not be rebuilt (tileset graphics not loaded)";
        api.document.edit("Rebuild ISOM", (tx) => {
          const r = tx.rebuildIsom();
          if (!r) return;
          note = r.created
            ? `ISOM rebuilt from the tiles — ${plural(r.diamonds, "diamond")}${r.unresolved > 0 ? `, ${r.unresolved} guessed under doodads or off the edge` : ""}`
            : r.changed > 0 ? `ISOM brought back in step — ${plural(r.changed, "lattice value")} changed` : "the ISOM already matched the tiles";
        });
        done.push(note);
      }
      for (const s of outcome.skipped) done.push(`skipped: ${s}`);
      this.repaired = true;
      // The event listener sees a "replace" and leaves the original alone; a fresh look shows what is left.
      this.ticks.clear();
      api.ui.status(`Repair: ${done.join("; ")}.`);
      this.log = [`Done: ${done.join("; ")}.`];
      if (generation === this.generation) this.analysis = await this.gather();
    } catch (err) {
      this.log = [`Repair failed: ${err instanceof Error ? err.message : String(err)}`];
      api.ui.status(this.log[0]);
    } finally {
      this.busy = false;
      if (generation === this.generation) this.render();
    }
  }

  private async restore() {
    const { api } = this;
    if (!this.original || this.busy || !api.document.isOpen()) return;
    const generation = this.generation;
    this.busy = true;
    try {
      api.document.sections.replaceFile(this.original.bytes);
      this.repaired = false;
      this.ticks.clear();
      this.log = ["The file is back as it was when it opened."];
      api.ui.status(`Repair: ${this.name()} restored to the file that was opened.`);
      if (generation === this.generation) this.analysis = await this.gather();
    } finally {
      this.busy = false;
      if (generation === this.generation) this.render();
    }
  }
}

const plural = (n: number, word: string) => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
