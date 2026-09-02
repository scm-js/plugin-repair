# Repair

A plugin for [scmJS](https://github.com/jeany55/scm-js), the browser-based StarCraft 1 /
Brood War map editor. It checks a map file the way the game reads it and repairs what
you tick.

A scenario is a run of sections, each a four-character name, a length and that many
bytes. The game is forgiving about them: it reads a section that is too short into a
zeroed buffer, ignores the tail of one that is too long, folds repeats together by a
rule that differs per section, skips names it does not know, and stops at a header with
a negative length. Map protectors lean on every one of those habits, and so does plain
damage. The plugin lists what it finds, says what the game does with the file as it is,
and offers a repair for each finding — most of them writing out exactly what the game
already sees, some restoring what the editor needs and the game does not, a few that
change what the map is and are left unticked with a note saying why.

It is an unprotector that explains itself. Nothing is rewritten that you did not tick,
and the file as it came in stays at hand until the next map opens.

## Install

It is in scmJS's plugin list from the start, marked *default* and switched on. To add it
by hand: **Plugins ▸ Manage Plugins…**, paste

```
https://github.com/scm-js/plugin-repair
```

and press **Add**. To pin a version, add a ref: `github:scm-js/plugin-repair@v1.0.0`.

## Use

Open a map. If anything is wrong, the **Repair Map** dialog comes up over it; if not, the
status bar says so, or says nothing when there is nothing at all to note. **Tools ▸
Repair Map…** runs the same check on the open map whenever you like.

Each row is one finding: a level (*error* — the game will not load the map, or data has
been lost; *warning* — something the game or the editor cannot use as it is; *note* —
worth knowing, harmless), the section it is about, and what was found. The line under it
says what the game does with the file as it is and what the repair changes. The tick is
the repair; recommended ones start ticked. **Recommended** / **All** / **None** set the
ticks, **Repair** applies the ticked ones, and the list is checked again straight after.

A repair rewrites the file and hands it back to the editor, which parses it afresh: every
view follows, and the undo history is cleared, as it is after Section Explorer and
Resize. **Restore original** puts the bytes back as they were when the map opened. Save
under a new name if you want to keep both.

*Check maps when they open*, in the dialog's footer, turns the automatic check off; Tools
▸ Repair Map… still works.

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
  inactive, unticked;
- string offsets pointing outside STR / STRx (the game shows those strings empty) — the
  editor rewrites the table with every string it could read;
- unit records naming a unit type past 227 or an owner past player 12 — remove them,
  unticked, since it is data loss;
- a VCOD that is not StarEdit's fixed table — restore it, unticked.

The editor's own:

- no ISOM, or one the wrong size — rebuild the lattice from the tiles (exact for terrain
  laid down isometrically, a best guess under doodads and for hand-placed tiles), one
  undo step;
- an ISOM out of step with the tiles after Rect or Tile edits — rebuild it;
- a TILE that is all zeros — copy MTXM over it; one that merely differs from MTXM is a
  note, since the two differ under every doodad by design;
- sections out of StarEdit's order — reorder, unticked.

What it does not do: anything at the archive level. A `.scx` whose MPQ is damaged fails
before the editor has a file to hand the plugin.

## How it is built

`chk.ts` reads and writes the container with the editor's own rules. `analyze.ts` turns
a chunk list, plus what the editor knows about each section name (`api.document.sections
.known()` and `.required()`), StarEdit's VCOD (`.defaults("VCOD")`) and the ISOM report
(`api.terrain.checkIsom()`), into findings, each carrying its repair. `repair.ts` applies
the byte-level repairs to a chunk list, resolving indices to chunk objects first so a
removal never shifts a later one. All three are pure and tested (`npm test`). `plugin.ts`
listens for the `"document"` event with reason `"open"`, gathers the inputs, shows the
dialog, and applies a repair in three steps: the byte-level ones as one
`api.document.sections.replaceFile`, then `sections.rebuild` for the string table, then
one `api.document.edit` with `tx.rebuildIsom`.

`plugin-api/` is the editor's emitted type declarations, vendored so the repository
type-checks alone (`npm run typecheck`); refresh it from `npm run build:plugin-types` in
the editor when the API changes.

## License

MIT.
