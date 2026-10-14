# Repair

A plugin for [scmJS](https://github.com/scm-js/scm-js), the browser-based StarCraft 1 /
Brood War map editor. It checks a map file the way the game reads it, repairs what is safe
to repair as the map opens, and lists the rest for you to decide.

A scenario is a run of sections, each a four-character name, a length and that many
bytes. The game is forgiving about them: it reads a section that is too short into a
zeroed buffer, ignores the tail of one that is too long, folds repeats together by a
rule that differs per section, skips names it does not know, and stops at a header with
a negative length. Map protectors lean on every one of those habits, and so does plain
damage. The plugin says what it finds, what the game does with the file as it is, and
what each repair changes. Most repairs write out exactly what the game already sees, and
some restore what the editor needs and the game does not; those are *safe*, and are made
as the map opens. A few change what the map is. Those are never made for you: they wait
in the status bar, each with a note saying why.

It is an unprotector that explains itself, and the file as it came in stays at hand for
as long as the map is open.

## Install

It is in scmJS's plugin list from the start, marked *default* and switched on. To add it
by hand: **Plugins ▸ Manage Plugins…**, paste

```
https://github.com/scm-js/plugin-repair
```

and press **Add**. To pin a version, add a ref: `github:scm-js/plugin-repair@v1.0.0`.

## Use

Open a map. The safe repairs are made straight away, and they count as reading the file:
the map does not come up as changed, closing it does not ask to save, and Save writes the
repaired file. A cell in the status bar says what happened — *Repaired 3* — and what is
left — *Repaired 3 · 1 to review*. A clean map gets no cell. A safe repair is not made if
you changed the map before the check finished, or on a shared map, where it would land on
everyone's copy; the cell then says *Repair: 3 to fix*.

Click the cell, or use **Tools ▸ Repair Map…**, for the dialog:

- **Safe to repair** — safe repairs still waiting (after *Ask before repairing anything*,
  or when they could not be made on open), with **Repair all**;
- **Needs your decision** — the judgement calls, each with what the game does with the
  file now and what the repair would change, and an **Apply** button of its own; an
  error or warning nothing can repair says so;
- **Repaired when the map opened** — the list, with **Undo**, which puts the bytes back
  as they were when the map opened;
- **Notes** — worth knowing, harmless;
- **Advanced** — every finding with its level and the section it is about.

A repair from the dialog rewrites the file and hands it back to the editor, which parses
it afresh: every view follows, and the undo history is cleared, as it is after Section
Explorer and Resize. Unlike the repairs made on open, it marks the map as changed, and so
does Undo — after a Save, the file on disk is no longer the one that was opened. Save
under a new name if you want to keep both. With several maps open, each keeps its own
cell and its own original.

**Edit ▸ Preferences ▸ Plugins ▸ Repair** sets what happens when a map opens:

- *Repair what is safe, list the rest* (the default);
- *Ask before repairing anything* — the dialog comes up when there is an error or a
  warning, and nothing is repaired until you press a button;
- *Do not check* — Tools ▸ Repair Map… still runs the check.

## What it looks for

The container:

- a section declared longer than the file (the game reads what is there) — declare the
  real length;
- a header with a negative length (the game seeks backwards; the editor stops reading)
  — remove it, and when the bytes after it are sections in their own right, recover
  them;
- bytes after the last readable section — recover them as above, or drop them;
- a section whose name is not text — remove it; one with an unknown but readable name
  is left alone, since other editors keep their own data that way;
- a section that appears more than once — fold the occurrences into one the way the
  game does: the last one for most sections, every record for lists (UNIT, THG2, TRIG,
  MBRF, DD2), each copied over the front of one fixed buffer for the terrain layers;
- a section that is not the size the game reads — pad it (with fog for MASK) or cut it;
- a list section with stray bytes after its last whole record — trim them.

What the game needs:

- every section a file of the map's revision must carry to load, on StarEdit's defaults
  — with two exceptions that keep the terrain: a missing MTXM is restored from TILE, and
  a missing TILE (the editor's copy of the terrain, which the game never reads and
  protectors strip) from MTXM;
- DIM outside 1 × 1 to 256 × 256, VER not one StarEdit writes — reported without a
  repair, since the true value cannot be read off the file; Scenario ▸ Resize and Map
  Revision set them once the map is open;
- ERA with its high bits set (the game uses the low three) — write the value it uses;
- TYPE not RAWS or RAWB — write the one StarEdit pairs with the version;
- OWNR or SIDE holding a player type or race the game does not have — set those slots
  inactive, left to you;
- string offsets pointing outside STR / STRx (the game shows those strings empty) — the
  editor rewrites the table with every string it could read;
- unit records naming a unit type past 227 or an owner past player 12 — remove them,
  left to you, since it is data loss;
- a VCOD that is not StarEdit's fixed table — restore it, left to you.

The editor's own:

- no ISOM, or one the wrong size — rebuild the lattice from the tiles (exact for terrain
  laid down isometrically, a best guess under doodads and for hand-placed tiles), one
  undo step;
- an ISOM out of step with the tiles after Rect or Tile edits — rebuild it. What is
  offered is the share a rebuild would put back, never the raw disagreement: a rebuild
  converges in one pass, and terrain no diamond lattice describes — hand-placed tiles,
  blends, ground another editor laid — disagrees with any lattice for ever. That part is
  reported as a note with no repair, so the finding cannot survive its own press;
- a TILE that is all zeros — copy MTXM over it; one that merely differs from MTXM is a
  note, since the two differ under every doodad by design;
- sections out of StarEdit's order — reorder, left to you.

What the map says — the two checks about content rather than shape, both of them about a
string the old game drew one way and nothing draws that way now:

- strings a remaster draws in a colour their author never chose. 1.16.1 started every
  line in the default colour; Remastered carries the previous line's colour across the
  break, so a colour set on one line bleeds into the next. The repair writes the reset
  the old game supplied at the head of each of those lines, which makes both games draw
  the string alike and changes nothing about what it says. It is never made for you:
  whether the map was written before or after the remaster is the one thing the
  plugin cannot read off the file, so it explains and leaves the choice to you;
- strings that stack text on one line — the classic lobby and unit names. 0x12 and 0x13
  move the text after them to the right or the centre of the line they are on, and
  1.16.1 obeyed every one of them, so `Name<12>by Author` drew two pieces in two places
  at once. Remastered does not draw them that way, and neither does the editor, which
  takes one alignment for the whole line — the last the line sets — so every piece before
  it lands somewhere nobody chose. The finding says
  where the stacks are — the map name, so many unit names, read from
  `api.query.stringUsage()` — and quotes what the first would read once flattened.
  The repair drops the codes that split each line and joins its pieces left to right in
  writing order, a space between two that would otherwise run together; colours and
  every word survive, and what is lost is where the pieces sat. That loss is real, and
  it is the reason this one is left to you: it is the only repair here that takes away
  something the map had, so it is offered rather than recommended.

What it does not do: anything at the archive level. A `.scx` whose MPQ is damaged fails
before the editor has a file to hand the plugin.

## How it is built

`chk.ts` reads and writes the container with the editor's own rules. `analyze.ts` turns
a chunk list, plus what the editor knows about each section name (`api.document.sections
.known()` and `.required()`), StarEdit's VCOD (`.defaults("VCOD")`) and the ISOM report
(`api.terrain.checkIsom()`), into findings, each carrying its repair. `repair.ts` applies
the byte-level repairs to a chunk list, resolving indices to chunk objects first so a
removal never shifts a later one. `plan.ts` sorts the findings into safe, to review and
notes, and words the status cell. All four are pure and tested (`npm test`). `plugin.ts`
listens for the `"document"` event with reason `"open"`, gathers the inputs, makes the
safe repairs, keeps the status cell and the dialog, and applies a repair in five steps,
in this order: the byte-level ones as one
`api.document.sections.replaceFile`; then the two string rewrites, each its own
`api.document.update` so either can be undone without the other — they go via the
editor's model and so stay undoable, where `replaceFile` installs a whole new scenario
and would drop them; then `sections.rebuild` for the string table, which re-encodes STR
from the model those steps wrote into; then one `api.document.edit` with
`tx.rebuildIsom`. On open, every `replaceFile` passes `{ asOpened: true }`, and when a
rebuild or the ISOM went through the editor's model, one last
`replaceFile(sections.file(), { asOpened: true })` settles them the same way, so the map
is left unmodified with an empty history. `colors.ts` holds the `TextHelpers` interface `analyze` takes its four
text readers through — `api.text.bleedingLines` / `.fixBleeding` and `.stackedLines` /
`.flattenStacks` — so the plugin carries no copy of the control-byte numbering, which is
easy to get wrong and is worth having wrong in only one place. The stacking pair was
added to the editor for this plugin and lives there rather than here for that reason:
where 0x12 and 0x13 put the text after them is the editor's table's business, and every
plugin that shows or rewrites map text wants the same answer.

Types come from [`@scm-js/plugin-api`](https://github.com/scm-js/plugin-api), a devDependency
generated from the editor's own `src/plugins/api.ts`; `npm update @scm-js/plugin-api` takes the
newest contract.

## License

MIT.
