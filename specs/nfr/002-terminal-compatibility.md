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
- **Nothing but the renderer writes to the terminal while it owns the screen.** A runtime
  warning printed to stderr splices into a frame mid-cell, and the renderer repaints only
  the cells it believes changed — so the text stays, no keystroke repairs it, and rows below
  drift out of column. Process warnings are therefore taken off the `warning` event before
  the renderer is created and routed to the debug log (`src/warnings.ts`,
  `TOPIQ_KAFKA_LOG`). Known reachable in practice: kafkajs 2.2.4 schedules its pending-request
  check at `throttledUntil - Date.now()` with `throttledUntil` still `-1`, so every session
  against a real broker raises one `TimeoutNegativeWarning` on the first response.
- Exit always restores the terminal (alt screen off, cursor visible), including on an
  unhandled error ([../001-app-shell](../001-app-shell.md)).
- `$EDITOR` hand-off suspends and restores the UI cleanly, under tmux and without
  ([../014-edit-and-replay](../014-edit-and-replay.md)).

## Notes

- Message payloads are arbitrary bytes from an untrusted-ish source; treat them as
  hostile to the renderer, not just as text.
- The warning guard covers the `warning` event, which is how runtimes and libraries raise
  these. A dependency that writes to stdout/stderr directly would still land on the frame;
  no such writer is known in the tree, and intercepting the streams wholesale would fight
  the renderer for its own output.
- Warning lines keep their `name` unredacted. Every warning class name is a long CamelCase
  run, which is the shape the secret filter matches, so redacting it would destroy the one
  token that identifies the line ([003-security-and-credentials](./003-security-and-credentials.md)).
