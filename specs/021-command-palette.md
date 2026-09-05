# Command Palette

**Status**: In Progress — P1 built (`^p` overlay, fuzzy match, fixed sections, direct keys,
state-aware list, blocked writes listed with their reason); P2's submenus and P3 pending.
Verified through the pure command modules, the geometry model and the reducer; the overlay
component and its `^p` binding have no render harness, as with every other view here.

## Description

A `Ctrl+P` fuzzy command palette — the way to reach an action without knowing its key,
mirroring monq's and lane's. Every action that has a direct binding is reachable here; the
palette is a second door, and it teaches the direct key while you use it.

With no persistent status bar ([022](./022-help-panel.md)), discoverability comes from
exactly two places: this palette and the `?` help panel.

## Capabilities

### P1 — Must Have

- `Ctrl+P` opens a centered overlay: a fuzzy-filtered command list over a query field.
  `↑/↓` (and `^p`/`^n`) move, `Enter` runs, `Esc` closes. Precedence: inside an open
  list/menu `Ctrl+P` navigates ([020](./020-keyboard-navigation.md)); the palette
  binding fires only when no list owns the keyboard.
- **State-aware**: a command that can't act right now is absent, so `Enter` never lands on
  a no-op — message commands need a focused message, write commands need `allow_write`
  ([019](./019-write-safety.md)), "clear filter" needs a filter, follow-mode commands need
  follow mode ([012](./012-live-tail.md)).
- Each command shows its **direct key** right-aligned.
- Grouped sections in fixed order: Topic, Fetch, Filter, Message, Replay, Groups, General.

### P2 — Should Have

- Submenus for parameterised commands (pick fetch mode, pick destination cluster for a
  copy) instead of throwing you back to the main view — lane's palette-submenu model.
- ~~A write command that is gated shows *why*~~ — **built with P1**. It is the one
  exception to the state-awareness rule, so it belongs with the rule
  ([019](./019-write-safety.md) P1).

### P3 — Nice to Have

- Fuzzy-jump to a topic from the same prompt.
- Command history / recents.
- Render the help panel ([022](./022-help-panel.md)) from the same command registry, so
  the two lists cannot drift.

## Out of Scope

- User-defined or scripted commands.
- Commands that aren't reachable by a key — the palette is a second door, not a place for
  functionality to hide.

## Technical Notes

- Lane's structure transplants: a pure `buildCommands(ctx)` over a state-only
  `CommandContext` (assertable without stubbing callbacks), behaviour keyed by id in a
  separate `runCommand(id, actions)`, and the palette remounted per submenu mode so each
  descent starts with a clean query. Lane's spec 010 records why the alternative
  (`execute(ctx)` on the command, dialogs hosted in the palette component) grows an
  1800-line component — keep the split.
- Build **after** the command surface exists (replay, fetch modes, groups) — the palette
  lists actions, it doesn't create them. Sequenced late in milestone 4+.

## File Structure

| File | Change |
|------|--------|
| `src/commands/types.ts` | `Command`, `CommandCategory`, `CommandContext`, `CommandFocus`, `ViewActions` |
| `src/commands/builder.ts` | `buildCommands(ctx)` — the state-aware list |
| `src/commands/run.ts` | `runCommand(id, actions)` + `runPaletteCommand` (the blocked case) |
| `src/commands/context.ts` | `commandContext(state, …)` and `keyboardOwned(state)` — the precedence rule |
| `src/commands/match.ts` | `fuzzyScore` / `matchCommands` |
| `src/commands/registry.ts` | `useViewCommands` — how a view publishes its focus and actions |
| `src/state/palette.ts` | Open/close, query, highlight |
| `src/views/CommandPalette.tsx` | The overlay |
| `src/views/commandPaletteModel.ts` | Sections and geometry (`paletteEntries`, `paletteCapacity`, `paletteWindow`) |

Not built: `src/hooks/usePickList.ts`. Query and highlight live in the app reducer like
every other overlay's state here, because App's global keymap has to see that the palette
owns the keyboard — a hook holding it in component state could not tell it that. There is
no second picker to share it with yet either.

## Decisions

- **Half the commands need a cursor row the reducer never sees**, so the on-screen view
  registers two things — its focus and its actions (`useViewCommands`). `buildCommands`
  stays pure over the focus and `runCommand` stays a switch over ids; the alternative was
  lifting broker rows and client handles into `App`.
- **The base views give `^p` up rather than the palette yielding to them.** Both keymaps see
  the same key event, so a shared chord would open the palette *and* move the cursor
  underneath it. `listNav`'s `ctrlPrev: false` marks the four base views; inside a list,
  menu or text field `keyboardOwned` is true, the palette stands down, and `^p` keeps
  meaning "previous" ([020](./020-keyboard-navigation.md)).
- **Sections are fixed, ranking happens inside them.** The query ranks matches, the palette
  regroups them into the seven sections in declared order — so the sections never reshuffle
  under a keystroke while the best match still leads its own group.
- **The direct key is displayed, never matched.** Matching single letters would rank half
  the list on one keystroke.
- **A blocked write says "blocked" on its row and spells out the reason above the query
  field**, and running it repeats that reason rather than acting.
- **The overlay is absolutely positioned**, like the confirm dialog: out of the flow, so no
  list has to reserve rows for it (AGENTS.md). What it must not outgrow is the terminal, and
  `paletteCapacity` is the one helper both the window and the box use for that.

## Open Questions

- Matched characters are not highlighted in the row — the ranking is visible in the order
  only. A span-returning matcher would fix it and is a small change to `match.ts`.
- `groups.open` is offered from the topic list, where `c` binds it; from the message table
  there is no binding to expose, so the palette cannot offer it either. If the table ever
  gains one, the command follows.
- The picker view offers only help and quit: connecting is `enter` on a row, and a palette
  entry for it would need the profile list as focus. Worth doing with P3's fuzzy topic jump,
  which has the same shape.
