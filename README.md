# Repair

A plugin for [scmJS](https://github.com/scm-js/scm-js), the browser-based StarCraft 1 /
Brood War map editor. It checks a map as it opens, the way the game reads it. Repairs that
are safe are made straight away. The rest are listed for you to decide.

Protected and damaged maps often have sections that are missing, cut short, too long or
repeated. The game is forgiving about most of this, and map protectors rely on it. For each
problem, the plugin says what it found, what the game does with the file as it is, and what
the repair would change.

A repair is *safe* when it only writes what the game already sees, or puts back something
the editor needs and the game ignores. Safe repairs are made as the map opens. Repairs that
change what the map is are never made for you. They wait in the status bar, each with a note
explaining why.

The file as it was opened stays available for as long as the map is open.

## Install

Repair comes with scmJS. It is in the plugin list from the start, marked *default* and
turned on.

To add it by hand, open **Plugins ▸ Manage Plugins…**, paste

```
https://github.com/scm-js/plugin-repair
```

and press **Add**. To pin a version, add a ref: `github:scm-js/plugin-repair@v1.6.2`.

## Use

Open a map. Safe repairs are made at once and count as part of reading the file. The map
does not show as changed, closing it does not ask to save, and Save writes the repaired file.

A cell in the status bar says what happened (*Repaired 3*) and what is left
(*Repaired 3 · 1 to review*). A clean map gets no cell.

Safe repairs are held back in two cases: when you changed the map before the check finished,
and on a shared map, where they would land on everyone's copy. The cell then says
*Repair: 3 to fix*.

Click the cell, or use **Tools ▸ Repair Map…**, to open the dialog. It has these parts:

- *Safe to repair*: safe repairs that were not made on open, with a button to repair them all.
- *Needs your decision*: the judgement calls. Each says what the game does with the file
  now and what the repair would change, and has its own **Apply** button. A problem that
  nothing can repair says so.
- *Repaired when the map opened*: what was done, with **Undo**. Undo puts the bytes back
  as they were when the map opened.
- *Notes*: things worth knowing that do no harm.
- *Advanced*: every finding with its level and the section it is about.

A repair from the dialog rewrites the file and the editor reads it again. Every view
updates, and the undo history is cleared, as after Section Explorer or Resize. These repairs,
and Undo, mark the map as changed. After a save, the file on disk is no longer the one you
opened, so use **File ▸ Save As…** if you want to keep both.

With several maps open, each keeps its own cell and its own original file.

A map open to view only (a replay's map, in Aftermath) gets only the byte-level repairs. Use
**File ▸ Edit a Copy** to repair the rest in a copy.

### Settings

**Edit ▸ Preferences ▸ Plugins ▸ Repair** sets what happens when a map opens:

- *Repair what is safe, list the rest* (the default).
- *Ask before repairing anything*. The dialog opens when there is an error or a warning, and
  nothing changes until you press a button.
- *Do not check*. **Tools ▸ Repair Map…** still runs the check.

## What it looks for

### The container

- A section declared longer than the file. Repair: declare the real length.
- A header with a negative length. Repair: remove it, and recover any whole sections after it.
- Bytes after the last readable section. Repair: recover them as sections, or drop them.
- A section whose name is not text. Repair: remove it. A readable unknown name is left alone,
  since other editors store their own data that way.
- A section that appears more than once. Repair: fold the copies into one the way the game
  does. For most sections the last copy wins. List sections (UNIT, THG2, TRIG, MBRF, DD2)
  keep every record. Terrain layers are copied over one another in order.
- A section that is not the size the game reads. Repair: pad it (with fog for MASK) or cut it.
- A list section with stray bytes after its last whole record. Repair: trim them.

### What the game needs

- Sections a map of this revision must have to load. Repair: add them with StarEdit's
  defaults. A missing MTXM is rebuilt from TILE, and a missing TILE from MTXM, so the terrain
  is kept.
- DIM outside 1 × 1 to 256 × 256, or a VER StarEdit never writes. Reported only, since the
  right value cannot be read from the file. Use **Scenario ▸ Resize / Crop Map…** and
  **Scenario ▸ Map Revision…** once the map is open.
- ERA with its high bits set. Repair: keep the low three bits, which are all the game uses.
- TYPE other than RAWS or RAWB. Repair: write the one StarEdit pairs with the version.
- OWNR or SIDE with a player type or race the game does not have. Repair (your decision): set
  those slots inactive.
- String offsets pointing outside STR or STRx. The game shows these strings as empty. Repair:
  rewrite the string table with every string that could be read.
- Units with a type past 227 or an owner past player 12. Repair (your decision): remove them.
- A VCOD that is not StarEdit's standard table. Repair (your decision): restore it.

### What the editor needs

- No ISOM, or one of the wrong size. Repair: rebuild it from the tiles as one undo step. This
  is exact for terrain laid down isometrically, and a best guess under doodads and for
  hand-placed tiles.
- An ISOM out of step with the tiles after Rect or Tile edits. Repair: rebuild it. Only the
  part a rebuild would fix is offered. Terrain that no isometric layout can describe (hand-placed
  tiles, blends, another editor's ground) is reported as a note.
- A TILE that is all zeros. Repair: copy MTXM over it. A TILE that only differs from MTXM is a
  note, since the two always differ under doodads.
- Sections out of StarEdit's order. Repair (your decision): reorder them.

### Map text

Two checks are about strings that the old game drew one way and Remastered draws another.
Both are left to you.

- Colours that carry over a line break. In 1.16.1 every line started in the default
  colour. Remastered carries the previous line's colour into the next one. The repair writes
  the colour reset at the start of each affected line, so both games draw the string the same
  way. The words do not change. The plugin cannot tell whether the map was made before or
  after Remastered, so it explains and lets you choose.
- Text stacked on one line. Codes 0x12 and 0x13 move the text after them to the right or
  the centre of the line. 1.16.1 obeyed each one, so `Name<12>by Author` drew two pieces in two
  places. Remastered and the editor use one alignment per line, so earlier pieces land in the
  wrong place. The finding names where the stacks are (the map name, unit names) and shows
  what the first one would read once flattened. The repair removes the codes and joins the
  pieces left to right. Colours and words stay; where each piece sat is lost.

### What it does not do

Nothing at the archive level. A `.scx` whose MPQ is damaged fails before the editor has a
file to give the plugin.

## Development

```sh
npm install
npm run build      # dist/plugin.js
npm run dev        # rebuild on change
npm test
npm run typecheck
```

- `chk.ts` reads and writes the section container with the editor's rules.
- `analyze.ts` turns the sections into findings, each with its repair.
- `repair.ts` applies the byte-level repairs.
- `plan.ts` sorts findings into safe, to review and notes, and words the status cell.
- `plugin.ts` runs the check on open, keeps the status cell and the dialog, and applies repairs.

The four files before `plugin.ts` are pure functions with tests. The text checks call the
editor's own helpers (`api.text.bleedingLines`, `fixBleeding`, `stackedLines`,
`flattenStacks`), so the plugin keeps no copy of the control-code table.

Types come from [`@scm-js/plugin-api`](https://github.com/scm-js/plugin-api), a devDependency
generated from the editor's plugin contract. `npm update @scm-js/plugin-api` picks up the
newest version. The [plugin guide](https://docs.scmjs.dev/plugins/) covers writing plugins.

## License

MIT.
