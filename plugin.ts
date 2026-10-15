/**
 * Repair — a plugin for the scmJS map editor (https://github.com/jeany55/scm-js).
 *
 * When a map opens, the plugin reads the file the way the game does — every section,
 * its declared and real length, repeats, the values in the headers and tables — and
 * repairs what is safe to repair by itself: what only writes what the game already does,
 * or puts back what the editor needs. Those repairs count as the reading of the file, so
 * the map does not come up modified. What is left — the judgement calls, and what nothing
 * can fix — waits behind a cell in the status bar; the dialog behind it explains each one
 * and applies it on request. The original bytes stay in memory while the map is open, so
 * Undo in the dialog puts the file back as it opened, even after another map was in front
 * meanwhile. Edit ▸ Preferences ▸ Plugins ▸ Repair chooses between repairing by itself, asking first
 * and not checking; Tools ▸ Repair Map… runs the same check by hand.
 *
 * `chk.ts` reads the container, `analyze.ts` turns a chunk list into findings, `plan.ts`
 * sorts them into what is repaired by itself and what waits, and `repair.ts` applies the
 * byte-level ones — all pure, all tested; this file gathers the inputs from the editor,
 * shows the status cell and the dialog and runs the repairs that need the editor's model
 * (the two string rewrites through `document.update`, then
 * `api.document.sections.rebuild` and `tx.rebuildIsom`).
 * `@scm-js/plugin-api` is the editor's type declarations, a devDependency generated from
 * its own `src/plugins/api.ts`; the host erases the type-only import.
 */
import type { DialogHandle, DocumentEvent, PluginApi, StatusItemHandle } from "@scm-js/plugin-api";
import { analyze, describeName, type Analysis, type Finding, type IsomFacts, type Level } from "./analyze";
import { parseChunks, readableName, serializeChunks } from "./chk";
import { applyRepairs } from "./repair";
import { cellText, group, readMode, type Mode } from "./plan";
import { msg } from "./i18n";
import { KO } from "./ko";

/** Repairs made through the editor's model rather than the file's bytes; a view-only map refuses them. */
const HOST_REPAIRS: ReadonlySet<string> = new Set(["rebuild", "rebuild-isom", "set-strings"]);

export default function activate(api: PluginApi) {
  api.i18n.register({ ko: KO });
  const session = new Session(api);
  api.commands.register({ id: "check", title: msg("Repair Map…"), enabled: () => api.document.isOpen(), run: () => { void session.check(); } });
  api.menu.add("Tools", { label: msg("Repair Map…"), after: "Check Map…", enabled: () => api.document.isOpen(), command: "check" });
  api.events.on("document", (e) => session.onDocument(e));
  api.events.on("language", () => { void session.relabel(); });
  registerPreferencesPage(api);
  return () => session.dispose();
}

const MODE_KEY = "on-open";
/** The 1.4 tick, *Check maps when they open*; read for a user who has not chosen since. */
const ASK_KEY = "ask-on-open";

const modeOf = (api: PluginApi): Mode => readMode(api.storage.get<unknown>(MODE_KEY, null), api.storage.get<unknown>(ASK_KEY, true));

/**
 * The plugin's page under Edit ▸ Preferences ▸ Plugins: what a map opening does. Written
 * on OK or Apply, so Cancel leaves it as it was.
 */
function registerPreferencesPage(api: PluginApi) {
  const w = api.ui.widgets;
  const t = api.i18n.t;
  let pick: HTMLSelectElement | null = null;
  api.ui.preferencesPage({
    mount(body) {
      pick = w.select([
        { value: "auto", label: t("Repair what is safe, list the rest") },
        { value: "ask", label: t("Ask before repairing anything") },
        { value: "off", label: t("Do not check") },
      ], { value: modeOf(api) });
      body.append(
        w.form([{ label: t("When a map opens"), field: pick }]),
        w.hint(t("A safe repair only writes what the game already does with the file, or puts back something the editor needs, such as the terrain record a protector stripped. It does not mark the map as changed, and Save writes it. Anything that is a judgement call waits in the status bar until you open it. Tools ▸ Repair Map… runs the check whichever you choose.")),
      );
      return () => { pick = null; };
    },
    apply() { if (pick) api.storage.set(MODE_KEY, pick.value); },
    reset() { if (pick) pick.value = "auto"; },
  });
}

const LEVEL_LABEL: Record<Level, string> = { error: msg("error"), warn: msg("warning"), info: msg("note") };

const STYLE = `
.rp { display: flex; flex-direction: column; gap: 10px; font-size: 12px; min-height: 0; }
.rp .rp-head { display: flex; flex-direction: column; gap: 2px; line-height: 1.45; }
.rp .rp-head b { color: var(--text, #e6e9ef); font-size: 13px; }
.rp .rp-dim { color: var(--text-dim, #99a2b3); }
.rp .rp-scroll { display: flex; flex-direction: column; gap: 12px; max-height: 58vh; overflow: auto; padding-right: 2px; }
.rp .rp-section { display: flex; flex-direction: column; gap: 6px; }
.rp .rp-section > h4 { margin: 0; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .05em; color: var(--text-dim, #99a2b3); }
.rp .rp-card { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border: 1px solid var(--border, #333); border-radius: 4px; background: var(--bg-0, #0f1115); }
.rp .rp-card.error { border-left: 3px solid rgba(255,90,74,.7); }
.rp .rp-card.warn { border-left: 3px solid rgba(230,185,92,.7); }
.rp .rp-card-head { display: flex; align-items: center; gap: 10px; }
.rp .rp-card-head > .rp-title { flex: 1; min-width: 0; color: var(--text, #e6e9ef); }
.rp .rp-detail { color: var(--text-dim, #99a2b3); line-height: 1.45; }
.rp .rp-again { color: #ffcf7a; line-height: 1.4; }
.rp .rp-cant { color: var(--text-faint, #6b7382); font-style: italic; }
.rp .rp-lines { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 2px; color: var(--text-dim, #99a2b3); line-height: 1.4; }
.rp .rp-row { display: flex; align-items: baseline; gap: 8px; min-width: 0; padding: 5px 2px; border-bottom: 1px solid rgba(255,255,255,.05); }
.rp .rp-row:last-child { border-bottom: none; }
.rp .rp-row > div { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.rp .rp-badge { flex: none; width: 58px; text-align: center; font-size: 10px; text-transform: uppercase; letter-spacing: .04em; padding: 1px 0; border-radius: 3px; border: 1px solid transparent; }
.rp .rp-badge.error { color: #ff8a7a; border-color: rgba(255,90,74,.5); }
.rp .rp-badge.warn { color: #ffcf7a; border-color: rgba(230,185,92,.5); }
.rp .rp-badge.info { color: var(--text-dim, #99a2b3); border-color: var(--border, #333); }
.rp .rp-sec { flex: none; width: 40px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--gold, #e6b95c); white-space: pre; }
.rp .rp-none { padding: 4px 2px; color: var(--text-dim, #99a2b3); line-height: 1.45; }
.rp .rp-log { color: var(--text-dim, #99a2b3); line-height: 1.4; white-space: pre-wrap; margin-top: 4px; }
.rp .rp-foot { color: var(--text-faint, #6b7382); line-height: 1.4; }
`;

/** What Repair keeps for an open map that is not in front. */
interface Parked {
  original: { fileName: string | null; bytes: Uint8Array } | null;
  analysis: Analysis | null;
  done: Finding[];
  auto: number;
  log: string[];
  attempted: Set<string>;
}

export class Session {
  private handle: DialogHandle | null = null;
  private body: HTMLElement | null = null;
  private cell: StatusItemHandle | null = null;
  private analysis: Analysis | null = null;
  /** Findings the last press tried to repair and that came back, so they are shown as having survived it. */
  private attempted = new Set<string>();
  private original: { fileName: string | null; bytes: Uint8Array } | null = null;
  /** What was repaired since the map opened, in the order it was done. */
  private done: Finding[] = [];
  /** How many of `done` were made by themselves as the map opened — the first ones. */
  private auto = 0;
  private log: string[] = [];
  /** The map the fields above are about; the other open maps' copies wait in `parked`. */
  private front: number | null = null;
  private parked = new Map<number, Parked>();
  private busy = false;
  /** Bumped on every open / close / switch so a check still gathering for the previous map throws its result away. */
  private generation = 0;

  private readonly api: PluginApi;

  constructor(api: PluginApi) { this.api = api; }

  private t = (text: string, params?: Record<string, string | number>) => this.api.i18n.t(text, params);

  /** The language changed: the findings are written in it, so read the map again and draw anew. */
  async relabel() {
    if (this.busy || !this.analysis || !this.api.document.isOpen()) return;
    const generation = this.generation;
    const analysis = await this.gather();
    if (generation !== this.generation) return;
    this.analysis = analysis;
    this.handle?.setTitle(this.t("Repair Map"));
    this.render();
    this.updateCell();
  }

  onDocument(e: DocumentEvent) {
    if (e.reason === "replace") return;
    this.generation++;
    // Whatever dialog was up was about the map that just went, behind or away.
    this.handle?.close();
    // The map that was in front keeps what Repair knows of it while it stays open, so Undo
    // and the status cell are still there when it comes back; a map that closed takes its copy with it.
    const open = new Set(this.api.document.list().map((d) => d.id));
    if (this.front !== null && this.front !== e.id && open.has(this.front)) {
      this.parked.set(this.front, { original: this.original, analysis: this.analysis, done: this.done, auto: this.auto, log: this.log, attempted: this.attempted });
    }
    for (const id of this.parked.keys()) if (!open.has(id)) this.parked.delete(id);
    this.front = e.id;
    const back = e.id === null ? undefined : this.parked.get(e.id);
    if (e.id !== null) this.parked.delete(e.id);
    if (e.reason === "switch" && back) {
      ({ original: this.original, analysis: this.analysis, done: this.done, auto: this.auto, log: this.log, attempted: this.attempted } = back);
      this.updateCell();
      return;
    }
    this.original = null;
    this.analysis = null;
    this.done = [];
    this.auto = 0;
    this.log = [];
    this.attempted = new Set();
    this.updateCell();
    if (e.reason !== "open") return;
    // The bytes as they came in, before any repair; kept until the map closes or another file opens in its place.
    this.original = { fileName: e.fileName, bytes: this.api.document.sections.file() };
    const mode = modeOf(this.api);
    // The editor is still installing the document when the event fires; let it finish.
    if (mode !== "off") setTimeout(() => { void this.onOpen(mode); }, 0);
  }

  dispose() {
    this.handle?.close();
    this.cell?.remove();
    this.cell = null;
  }

  /**
   * A map just opened. `auto` repairs the safe findings as the reading of the file and
   * leaves the rest to the status cell; `ask` opens the dialog when anything is worth it.
   */
  private async onOpen(mode: Mode) {
    const { api } = this;
    if (!api.document.isOpen() || this.busy) return;
    const generation = this.generation;
    this.busy = true;
    let analysis: Analysis;
    try {
      analysis = await this.gather();
    } finally {
      this.busy = false;
    }
    if (generation !== this.generation) return;
    this.analysis = analysis;
    const { safe } = group(analysis.findings);
    // Not when the user already changed the map while it was being read — a repair
    // replaces the whole file and would take the change with it — and not on a shared
    // map, where it would land on everyone else's copy too. The cell offers them instead.
    const untouched = api.document.info()?.modified !== true && !api.sync?.current();
    if (mode === "auto" && safe.length > 0 && untouched) {
      await this.repair(safe, true);
      return;
    }
    this.updateCell();
    if (mode === "ask" && analysis.counts.error + analysis.counts.warn > 0) this.openDialog();
  }

  /** Tools ▸ Repair Map…: check again and show the dialog whatever it finds. */
  async check() {
    const { api } = this;
    if (!api.document.isOpen() || this.busy) return;
    this.original ??= { fileName: api.document.info()?.fileName ?? null, bytes: api.document.sections.file() };
    const generation = this.generation;
    this.busy = true;
    if (this.handle?.isOpen()) this.handle.setBusy(this.t("Checking the map…"));
    try {
      const analysis = await this.gather();
      if (generation !== this.generation) return;
      this.analysis = analysis;
      this.updateCell();
      if (this.handle?.isOpen()) this.render(); else this.openDialog();
    } finally {
      this.busy = false;
      this.handle?.setBusy(false);
    }
  }

  private name(): string { return this.api.document.info()?.fileName ?? this.api.document.info()?.name ?? this.t("the map"); }

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
    return analyze({ file, known, required, vcod, isom, strings: this.api.query.strings(), text: this.api.text, usage: this.api.query.stringUsage(), t: this.t });
  }

  /* ── The status bar cell ────────────────────────────────── */

  private updateCell() {
    const shown = this.analysis ? cellText(group(this.analysis.findings), this.done.length, this.t) : null;
    if (!shown) {
      this.cell?.remove();
      this.cell = null;
      return;
    }
    const spec = { text: shown.text, warn: shown.warn, busy: this.busy, title: this.t("Repair Map: what was repaired, and what is left") };
    if (this.cell?.isShown()) this.cell.set(spec);
    else this.cell = this.api.ui.statusItem({ ...spec, onClick: () => this.openDialog() });
  }

  /* ── The dialog ─────────────────────────────────────────── */

  private openDialog() {
    if (!this.analysis) { void this.check(); return; }
    if (this.handle?.isOpen()) { this.render(); return; }
    this.handle = this.api.ui.dialog({
      title: this.t("Repair Map"),
      size: "lg",
      mount: (body) => {
        this.body = body;
        this.render();
        return () => { this.body = null; this.handle = null; };
      },
    });
  }

  private render() {
    const { api, body, analysis, t } = this;
    if (!body || !analysis) return;
    const { el, widgets } = api.ui;
    body.replaceChildren();
    const root = el("div", { className: "rp" }, el("style", {}, STYLE));
    const { safe, review, notes } = group(analysis.findings);

    root.append(el("div", { className: "rp-head" }, el("b", {}, this.name()), el("span", { className: "rp-dim" }, this.summary(safe.length, review.length))));
    const scroll = el("div", { className: "rp-scroll" });

    if (safe.length > 0) {
      const section = el("div", { className: "rp-section" }, el("h4", {}, t("Safe to repair")));
      for (const f of safe) section.append(this.card(f, null));
      section.append(el("div", {}, widgets.button(t("Repair {n, plural, one {this one} other {all #}}", { n: safe.length }), { primary: true, disabled: this.busy, onClick: () => { void this.repair(safe, false); } })));
      scroll.append(section);
    }

    if (review.length > 0) {
      const section = el("div", { className: "rp-section" }, el("h4", {}, t("Needs your decision")));
      for (const f of review) section.append(this.card(f, t("Apply")));
      scroll.append(section);
    }

    if (safe.length + review.length === 0) {
      scroll.append(el("div", { className: "rp-none" }, this.done.length > 0
        ? t("Nothing else to repair.")
        : t("Every section is where the game expects it, at the size it reads, with nothing repeated or left over.")));
    }

    if (this.done.length > 0) {
      const fold = widgets.fold({ text: this.auto === this.done.length ? t("Repaired when the map opened ({n})", { n: this.done.length }) : t("Repaired ({n})", { n: this.done.length }) });
      fold.mark("✓", "ok");
      fold.body.append(el("ul", { className: "rp-lines" }, ...this.done.map((f) => el("li", {}, f.title))));
      if (this.log.length > 0) fold.body.append(el("div", { className: "rp-log" }, this.log.join("\n")));
      if (this.original) fold.action(widgets.button(t("Undo"), { ghost: true, disabled: this.busy, title: t("Put the file back as it was when it opened"), onClick: () => { void this.restore(); } }));
      scroll.append(fold);
    } else if (this.log.length > 0) {
      scroll.append(el("div", { className: "rp-log" }, this.log.join("\n")));
    }

    if (notes.length > 0) {
      const fold = widgets.fold({ text: t("{n, plural, one {# note} other {# notes}}", { n: notes.length }) });
      for (const f of notes) fold.body.append(this.card(f, t("Apply")));
      scroll.append(fold);
    }

    if (analysis.findings.length > 0) {
      const fold = widgets.fold({ text: t("Advanced: every finding by section") });
      for (const f of analysis.findings) {
        fold.body.append(el("div", { className: "rp-row" },
          el("span", { className: `rp-badge ${f.level}` }, t(LEVEL_LABEL[f.level])),
          el("span", { className: "rp-sec", title: f.section ? (readableName(f.section) ? api.document.sections.spec(f.section)?.what ?? "" : describeName(f.section)) : t("the file") }, f.section ? (readableName(f.section) ? f.section : "????") : t("file")),
          el("div", {}, el("span", {}, f.title), el("span", { className: "rp-detail" }, f.detail)),
        ));
      }
      scroll.append(fold);
    }

    root.append(scroll);
    root.append(el("div", { className: "rp-foot" }, t("A repair rewrites the file and clears the undo history, as Section Explorer and Resize do. Edit ▸ Preferences ▸ Plugins ▸ Repair chooses what happens when a map opens.")));
    body.append(root);
  }

  /** The line under the map's name. */
  private summary(safe: number, review: number): string {
    const { t } = this;
    const parts: string[] = [];
    if (this.auto > 0) parts.push(t("{n, plural, one {# problem was} other {# problems were}} repaired when the map opened. Each writes what the game already does with the file, or puts back something the editor needs.", { n: this.auto }));
    const since = this.done.length - this.auto;
    if (since > 0) parts.push(this.auto > 0 ? t("{n} more repaired since.", { n: since }) : t("{n, plural, one {# problem} other {# problems}} repaired.", { n: since }));
    if (safe > 0) parts.push(t("{n, plural, one {# problem is} other {# problems are}} safe to repair.", { n: safe }));
    if (review > 0) parts.push(t("{n, plural, one {# thing needs} other {# things need}} your decision. Read what each one changes first.", { n: review }));
    return parts.join(" ");
  }

  /** One finding: what it is, what the game does about it, and its button (`action` null for none). */
  private card(f: Finding, action: string | null): HTMLElement {
    const { api, t } = this;
    const { el, widgets } = api.ui;
    const head = el("div", { className: "rp-card-head" }, el("span", { className: "rp-title" }, f.title));
    if (action && f.repair) head.append(widgets.button(action, { disabled: this.busy, onClick: () => { void this.repair([f], false); } }));
    const card = el("div", { className: `rp-card ${f.level}` }, head, el("div", { className: "rp-detail" }, f.detail));
    if (!f.repair && f.level !== "info") card.append(el("div", { className: "rp-cant" }, t("Nothing the plugin can change. This is how the game reads the map.")));
    if (this.attempted.has(f.id)) card.append(el("div", { className: "rp-again" }, t("Still reported after the last repair.")));
    return card;
  }

  /* ── Doing it ───────────────────────────────────────────── */

  /**
   * One of the two string repairs, through the editor's model so it stays undoable and STR
   * is marked dirty. `rewrite` is `api.text`'s own rewriter and `measure` says how much of
   * a string it acted on, for the note and the line in the report.
   */
  private rewriteStrings(label: string, rewrite: (s: string) => string, measure: (s: string) => number, note: (strings: number) => string) {
    let strings = 0;
    let units = 0;
    const r = this.api.document.update(label, (tx) => {
      for (const [index, entry] of tx.strings.list().entries()) {
        if (entry === null) continue;
        const next = rewrite(entry);
        if (next === entry) continue;
        units += measure(entry);
        tx.strings.set(index, next);
        strings++;
      }
      tx.note(note(strings));
    });
    return { strings, units, changed: r.changed };
  }

  /**
   * Apply `chosen`. `asOpened` is the on-open pass: every step is taken as the reading of
   * the file that was opened, so the map is left unmodified — the steps that go through
   * the editor's model (a rebuild, the ISOM) are settled the same way at the end.
   */
  private async repair(chosen: Finding[], asOpened: boolean) {
    const { api, t } = this;
    // A map open to look at only (a replay's) takes the bytes as the reading of its file and
    // nothing that goes through the editor's model: the on-open pass does the byte-level part.
    if (asOpened && (api.document.info() as { viewOnly?: boolean } | null)?.viewOnly === true) {
      chosen = chosen.filter((f) => !HOST_REPAIRS.has(f.repair!.kind));
    }
    if (chosen.length === 0 || this.busy || !api.document.isOpen()) return;
    const { sections } = api.document;
    const generation = this.generation;
    this.busy = true;
    this.handle?.setBusy(t("Repairing…"));
    this.cell?.set({ busy: true });
    const done: string[] = [];
    try {
      const outcome = applyRepairs(parseChunks(sections.file()), chosen.map((f) => f.repair!), { known: sections.known(), defaults: (n) => sections.defaults(n), t });
      const byteLevel = chosen.filter((f) => !HOST_REPAIRS.has(f.repair!.kind));
      if (byteLevel.length > 0) {
        const r = sections.replaceFile(serializeChunks(outcome.file), { asOpened });
        done.push(r.warnings.length > 0
          ? t("{n, plural, one {# repair} other {# repairs}} written to the file — the parser still says: {warnings}", { n: byteLevel.length, warnings: r.warnings.join("; ") })
          : t("{n, plural, one {# repair} other {# repairs}} written to the file", { n: byteLevel.length }));
      }
      // After `replaceFile`, which installs a whole new scenario and would drop these, and
      // before `rebuild`, which re-encodes STR from the model they write into. The strings
      // are read again here rather than carried in the repair, since the byte-level pass
      // above may have moved them. Each is its own `update`, so the user can undo the one
      // they regret without losing the other.
      if (outcome.setStrings.includes("colours")) {
        const { strings, units, changed } = this.rewriteStrings(
          t("Fix string colours"),
          (s) => api.text.fixBleeding(s),
          (s) => api.text.bleedingLines(s).length,
          (n) => t("{n, plural, one {# string} other {# strings}} given the line-break colour reset", { n }),
        );
        done.push(strings === 0
          ? t("the strings already read the same in both games")
          : t("{n, plural, one {# string} other {# strings}} given the reset 1.16.1 supplied at {breaks, plural, one {# line break} other {# line breaks}}", { n: strings, breaks: units }) + (changed ? "" : t(" (nothing changed)")));
      }
      if (outcome.setStrings.includes("stacks")) {
        const { strings, units, changed } = this.rewriteStrings(
          t("Flatten stacked text"),
          (s) => api.text.flattenStacks(s),
          (s) => api.text.stackedLines(s).length,
          (n) => t("{n, plural, one {# string} other {# strings}} laid out on one line", { n }),
        );
        done.push(strings === 0
          ? t("no string stacked text on a line")
          : t("{n, plural, one {# string} other {# strings}} unstacked — {lines, plural, one {# line} other {# lines}} laid out left to right", { n: strings, lines: units }) + (changed ? "" : t(" (nothing changed)")));
      }
      if (outcome.rebuild.length > 0) {
        const r = sections.rebuild(outcome.rebuild);
        done.push(r.rebuilt.length > 0 ? t("{names} rebuilt from the editor's model", { names: r.rebuilt.map((n) => n.trim()).join(", ") }) : t("nothing to rebuild"));
      }
      if (outcome.rebuildIsom) {
        let note = t("the ISOM could not be rebuilt (tileset graphics not loaded)");
        api.document.edit(t("Rebuild ISOM"), (tx) => {
          const r = tx.rebuildIsom();
          if (!r) return;
          note = r.created
            ? (r.unresolved > 0
              ? t("ISOM rebuilt from the tiles — {n, plural, one {# diamond} other {# diamonds}}, {guessed} guessed under doodads or off the edge", { n: r.diamonds, guessed: r.unresolved })
              : t("ISOM rebuilt from the tiles — {n, plural, one {# diamond} other {# diamonds}}", { n: r.diamonds }))
            : r.changed > 0 ? t("ISOM brought back in step — {n, plural, one {# lattice value} other {# lattice values}} changed", { n: r.changed }) : t("the lattice was already the closest fit the tiles allow");
        });
        done.push(note);
      }
      // The rebuild and the ISOM went through the editor's model, which marks the map
      // modified; on open they are as much the reading of the file as the bytes above.
      if (asOpened && (outcome.rebuild.length > 0 || outcome.rebuildIsom)) sections.replaceFile(sections.file(), { asOpened: true });
      for (const s of outcome.skipped) done.push(t("skipped: {why}", { why: s }));
      if (!asOpened) api.ui.status(t("Repair: {done}.", { done: done.join("; ") }));
      this.log = [t("Done: {done}.", { done: done.join("; ") })];
      if (generation === this.generation) {
        // The event listener sees a "replace" and leaves the original alone; a fresh look shows what is left.
        // A finding that survives its own repair is not offered again as if new: it says so.
        this.analysis = await this.gather();
        const left = new Set(this.analysis.findings.map((f) => f.id));
        const repaired = chosen.filter((f) => !left.has(f.id));
        this.attempted = new Set(chosen.filter((f) => left.has(f.id)).map((f) => f.id));
        this.done = [...this.done, ...repaired];
        if (asOpened) this.auto = repaired.length;
      }
    } catch (err) {
      this.log = [t("Repair failed: {error}", { error: err instanceof Error ? err.message : String(err) })];
      api.ui.status(this.log[0]);
    } finally {
      this.busy = false;
      this.handle?.setBusy(false);
      this.cell?.set({ busy: false });
      if (generation === this.generation) {
        this.render();
        this.updateCell();
      }
    }
  }

  private async restore() {
    const { api } = this;
    if (!this.original || this.busy || !api.document.isOpen()) return;
    const generation = this.generation;
    this.busy = true;
    this.handle?.setBusy(this.t("Restoring the original…"));
    try {
      // Marked modified, as any edit: whether the file on disk is still the original (it
      // is not after a Save) is not something the plugin can tell.
      api.document.sections.replaceFile(this.original.bytes);
      this.done = [];
      this.auto = 0;
      this.attempted.clear();
      this.log = [this.t("The file is back as it was when it opened.")];
      api.ui.status(this.t("Repair: {name} restored to the file that was opened.", { name: this.name() }));
      if (generation === this.generation) this.analysis = await this.gather();
    } finally {
      this.busy = false;
      this.handle?.setBusy(false);
      if (generation === this.generation) {
        this.render();
        this.updateCell();
      }
    }
  }
}
