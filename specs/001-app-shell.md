# App Shell

**Status**: Done — P1+P2 built and verified (entry, layout, theme, reducer router,
transient status line, clean shutdown); P3 debug pane not built (optional)

## Description

The scaffold every other spec builds on: an OpenTUI renderer, argument parsing, the
top-level layout, a theme, and a clean startup/shutdown path. Nothing Kafka-specific —
this is the frame the panes hang in.

## Capabilities

### P1 — Must Have

- `topiq` boots into a full-screen OpenTUI React app and restores the terminal on exit
  (`q` / `Ctrl+C`), including on an unhandled error — never leave a mangled terminal.
- Layout skeleton: header (cluster + topic + mode) and main pane. **No persistent status
  bar with keyboard hints** — discoverability is the help panel
  ([022](./022-help-panel.md)) and later the palette ([021](./021-command-palette.md));
  the transient status line (P2) appears only when it has an async result or error to
  show.
- `src/theme.ts` holds every colour; components import `theme`, never a literal hex
  ([nfr/005](./nfr/005-code-quality-and-architecture.md)).
- Arg parsing: `topiq [cluster] [topic]` preselects a cluster profile and topic; no args
  opens the cluster picker ([002](./002-cluster-config.md)).
- A single `useReducer` owns app state, with a router delegating to domain sub-reducers
  (monq's pattern) — not state scattered across components.

### P2 — Should Have

- `--version` / `--help`.
- **Built:** `just build` compiles a standalone binary (`scripts/build.ts`, lane's shape:
  the OpenTUI tree-sitter worker passed as a second entrypoint, version stamped in via
  `--define`), and `just install-bin` puts it on `PATH` at `~/.local/bin/topiq`.
- Toast/status-line mechanism for async results and errors
  ([nfr/004](./nfr/004-reliability-and-errors.md)).
- Resize handling: panes reflow, no clipped rows.

### P3 — Nice to Have

- A debug/console pane for client logs (redacted — [nfr/003](./nfr/003-security-and-credentials.md)).

## Out of Scope

- Any broker connection — [003](./003-kafka-client-seam.md).
- Key bindings beyond quit — [020](./020-keyboard-navigation.md).
- A `HelpBar`-style hint row. Never built, so never removed
  ([022](./022-help-panel.md)).

## Technical Notes

- Mirrors `monq`/`lane` startup: a single `index.tsx` render call is also the one place
  the client seam is chosen, so the UI never imports a Kafka library.
- Shutdown must `disconnect()` any live consumer before the renderer tears down, or Bun
  hangs on an open socket.

## File Structure

| File | Change |
|------|--------|
| `src/index.tsx` | Entry: arg parse, client seam, render |
| `src/App.tsx` | Layout + root reducer |
| `src/state.ts` | Reducer router |
| `src/theme.ts` | Colours |
