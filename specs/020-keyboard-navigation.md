# Keyboard Navigation

**Status**: In Progress — P1 complete: movement, `g`/`G`, `enter`/`esc`, `h`/`l`, the
`/` filter bar (010, 011) and normalisation, plus P2's `?` panel and the `^p` palette chord
([021](./021-command-palette.md)). The mode chords are the remaining P2 work. `keys.ts` is
unit tested; the `useKeyboard` blocks that consume it are not (no OpenTUI render harness)

## Description

Everything reachable from the keyboard, vim-style, with the same key vocabulary as
[`monq`](../../monq) and [`lane`](../../lane) so the three tools don't need separate muscle
memory.

## Capabilities

### P1 — Must Have

- `j`/`k` plus ↑/↓ for cursor movement; `g`/`G` to top/bottom; `Enter` to descend
  (cluster → topics → messages), `Esc` to ascend. `l`/→ is the descend synonym and
  `h`/← the ascend one — one `levelNav` helper owns the pair, as `listNav` owns the
  movement synonyms.
- `h`/`l` (and `←`/`→`) move horizontally: the column cursor in the message table
  ([024](./024-table-column-navigation.md)), a level of hierarchy in the single-column
  views where no columns compete for them.
- `Ctrl+D`/`Ctrl+U` move half a viewport — vim's and monq's binding. Half, not whole, so
  a row you were reading survives the jump.
- `Ctrl+N`/`Ctrl+P` move through any menu/list, including while typing in a filter or
  prompt (where `j`/`k` must keep inserting text) — one `listNav` helper owns the
  synonym set so views can't drift. Inside a list, `Ctrl+P` means "previous"; the global
  palette binding ([021](./021-command-palette.md)) only fires outside list contexts.
  Resolved in 021: a *base* view is not a list context — it hands `^p` to the palette via
  `listNav`'s `ctrlPrev: false`, because both keymaps see the same event and a shared chord
  would move the cursor while the palette opened over it. An open list, menu, modal or text
  field keeps `^p` as "previous" and the palette stands down (`keyboardOwned`).
- `/` opens the filter bar ([010](./010-filter-bar.md)); `q` quits from the root view.
- Raw keys are normalised (lowercase name + implicit-shift detection) — some terminals
  send `"H"` with the shift flag unset instead of shift+`h`
  ([nfr/002](./nfr/002-terminal-compatibility.md)).
- Destructive/write keys are distinct from navigation keys and never adjacent to them
  ([019](./019-write-safety.md)).

### P2 — Should Have

- `?` opens the help panel ([022](./022-help-panel.md)) — there is no persistent status
  bar with keyboard hints, by decision.
- `Ctrl+P` opens the command palette ([021](./021-command-palette.md)) once the command
  surface exists.
- Chords for mode switching (fetch mode, view mode) following lane's `v…`/`g…` families.

## Out of Scope

- Mouse support.
- User-configurable bindings until there's a reason to want them.

## Technical Notes

- Key handling lives in `App.tsx` / dedicated hooks, not scattered in presentational
  components ([nfr/005](./nfr/005-code-quality-and-architecture.md)).
- Input handling must stay off any async path — a keypress renders on the next frame
  regardless of broker state ([nfr/001](./nfr/001-performance.md)).

## File Structure

| File | Change |
|------|--------|
| `src/keys.ts` | Normalisation (implicit-shift folding), `listNav`, `levelNav` — renderer-free for tests |
| `src/views/useClusterPickerKeys.ts` | Picker bindings as a hook, view stays presentational |
| `src/views/HelpPanel.tsx` | `?` panel — [022](./022-help-panel.md) |

## Implementation Notes

- Esc ascends exactly one level: table → topic list → picker. View-local esc meanings
  (clear filter, close the partition pane, cancel a prompt) win first; App and the view
  read the same state snapshot per key event, so exactly one meaning fires.
- `q` currently quits from every non-capturing view, not only the root — revisit if a
  view ever needs `q` locally.

## Decisions

- **Ascend lives in App, descend lives in the views.** `h`/← is handled once in `App.tsx`
  next to esc; `l`/→ is handled per view, because only the view knows what the cursor is
  on. Same split enter and esc already had.
- **`h` ascends unconditionally — it is not an esc alias.** Esc first claims view-local
  dismissals (clear a filter, close the partition pane); `h` skips them and leaves the
  level. Two keys for "go back" would be redundant if they behaved identically, and a
  navigation key that sometimes clears a filter instead of moving is worse than one that
  always moves. Stated in the help panel as "back one level".
- **`l` does not open the $EDITOR message view.** In the picker and the topic list `l`
  descends exactly like enter. In the message table it does nothing: the editor suspends
  the TUI for an external process, and `h` cannot bring it back, so binding it to the
  descend key breaks the pair the key exists to form. The table is the deepest level
  `h`/`l` reach; opening a message stays an explicit act on enter ([008](./008-message-detail.md)).
- **←/→ are the arrow synonyms of `h`/`l`** — spec P1 promised arrows alongside the vim
  keys, no view uses horizontal scrolling, and lane binds the same pair.
- **Any modifier declines a level move.** ctrl+h arrives as backspace on many terminals
  ([nfr/002](./nfr/002-terminal-compatibility.md)), and leaving shift free lets views
  bind `J`/`K` (the topic list scrolls its partition pane with them, [006](./006-topic-list.md)).
- **`letters: false` mirrors `listNav`.** While a filter or a prompt captures text, `h`
  and `l` are characters; App's capture guard already returns before the level check, so
  the flag is there for any future view that needs a text field plus level moves.

## Open Questions

- Nothing in the app scrolls horizontally yet. If the message table ever pans across
  columns, `h`/`l` are the obvious keys for it and the level pair would need to move to
  ←/→ only, or to a chord.
