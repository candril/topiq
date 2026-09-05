# Help Panel

**Status**: In Progress — P1 built; P2 context-awareness and P3 registry generation open

## Description

There is **no persistent status bar with keyboard hints**. Shortcuts are discoverable
through an on-demand panel — `?` opens a centered overlay listing the bindings, grouped by
area; dismissing it returns to an unchanged view. The main pane gets the full terminal
height; discoverability costs zero rows until asked for.

Same decision lane made (its spec 011), same reasoning: a hint bar eats rows permanently
to serve only the first week of use.

## Capabilities

### P1 — Must Have

- The panel lays its sections into as many columns as the terminal height needs: with
  eleven sections it no longer fits one column, and drawing it anyway overlapped every
  section header with its own first binding.
- `?` opens a modal overlay listing the key bindings, grouped by area (Navigation, Fetch,
  Filter, Message, Replay, Groups, General).
- Dismissible with `Esc` / `?` / `q`; focus and view state return unchanged.
- No shortcut hints occupy permanent screen space anywhere in the app — including inside
  an idle filter bar or prompt, which render nothing until they carry state.

### P2 — Should Have

- Context-aware: show the bindings valid in the current view/state, not the full flat list.
- Write-gated keys shown with their gate state (`allow_write=false`) rather than hidden
  ([019](./019-write-safety.md)).

### P3 — Nice to Have

- Generated from the command registry ([021](./021-command-palette.md) P3) so panel,
  palette and bindings cannot drift.

## Out of Scope

- Rebindable keys ([020](./020-keyboard-navigation.md) Out of Scope).
- The transient status line from [001](./001-app-shell.md) — that surfaces async results
  and errors, appears only when it has something to say, and is not a keyboard-hint bar.

## Technical Notes

- Reuses the overlay/dialog pattern shared with the palette and confirm dialog — one
  themed modal component, not three.
- Unlike lane, topiq never builds a `HelpBar` to remove later: [001](./001-app-shell.md)'s
  layout has no hint row from the start.

## File Structure

| File | Change |
|------|--------|
| `src/views/HelpPanel.tsx` | The overlay |
| `src/App.tsx` | `?` open state |

## Implementation Notes

- Groups shipped: Navigation, Topics, Fetch, Follow, Filter, Message, General. The spec's
  Replay and Groups areas have no bindings yet (specs 013/017 not built). Regroup when the
  replay/group keys land.
- The panel is not context-aware (P2), so it states where a binding does *not* apply:
  Navigation offers `l →` as "open cluster / topic" and Message spells out that `l` is not
  the $EDITOR key ([020](./020-keyboard-navigation.md)).
