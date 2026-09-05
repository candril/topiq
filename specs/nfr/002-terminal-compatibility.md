# NFR: Terminal Compatibility

**Status**: Draft

## Requirement

Correct rendering and input across the terminals people actually use (iTerm2, Ghostty,
Alacritty, tmux, VS Code's terminal), at ordinary sizes.

## Criteria

- No reliance on 24-bit colour for legibility — colour carries emphasis, never the only
  meaning (a production cluster is labelled as well as coloured,
  [../019-write-safety](../019-write-safety.md)).
- Key normalisation handles terminals that send `"H"` with the shift flag unset instead of
  shift+`h` ([../020-keyboard-navigation](../020-keyboard-navigation.md)).
- Resize reflows panes; no clipped or overlapping rows.
- Wide/CJK characters and control bytes in message payloads do not break table alignment —
  render them escaped rather than letting them corrupt the layout.
- Exit always restores the terminal (alt screen off, cursor visible), including on an
  unhandled error ([../001-app-shell](../001-app-shell.md)).
- `$EDITOR` hand-off suspends and restores the UI cleanly, under tmux and without
  ([../014-edit-and-replay](../014-edit-and-replay.md)).

## Notes

- Message payloads are arbitrary bytes from an untrusted-ish source; treat them as
  hostile to the renderer, not just as text.
