# Loading Indicators

**Status**: In Progress — P1 built

## Description

Every wait in topiq is a network wait, and some of them are long: `password_cmd` shells out
to `az keyvault`, a connect does a TLS + SCRAM handshake, and a topic list on a large
cluster fetches watermarks for ~1900 topics ([003](./003-kafka-client-seam.md)). Before this
spec those waits looked like a frozen screen with one dim line of text — indistinguishable
from a hang.

The indication is graded by how much of the screen the wait owns, the same split monq uses:
a **blocking** wait (nothing to look at yet) takes the pane with an animated spinner and a
rotating message; an **incremental** wait (rows are already arriving, or will) gets a small
inline spinner and nothing else. Loading a message window is the incremental case — it
streams, it is usually fast, and taking the screen for it would flash on every range change.

## Capabilities

### P1 — Must Have

- **Connect** — from the moment a profile is picked until the session exists, the pane
  shows the full-screen loader. The status line keeps naming the actual cluster
  (`connecting to core-test…`); the loader carries the animation and the flavour text.
- **Topic list** — the full-screen loader replaces the "loading topics…" line until
  `listTopics` resolves ([006](./006-topic-list.md)).
- **Message window** — a small inline spinner in the window line beside the `loading`
  label while the consume runs ([007](./007-message-table.md), [009](./009-paging-and-fetch-modes.md)).
  No takeover, no flavour text: the rows below it are the feedback.
- The loader animates on a timer, so a stalled network still visibly ticks — a frozen
  spinner means the *process* is wedged, which is information ([nfr/004](./nfr/004-reliability-and-errors.md)).
- Flavour messages rotate every 5 s from a context-specific pool, so a long wait does not
  read as a repaint loop.

### P2 — Should Have

- Elapsed seconds beside the message once a wait passes ~10 s, so "slow" is
  distinguishable from "stuck".
- A count as the topic list resolves ("1 240 / 1 893 topics"), once the seam reports
  progress instead of one opaque promise.

### P3 — Nice to Have

- Cancel a wait in flight (`esc` during connect) rather than waiting it out.

## Out of Scope

- **Error rendering.** A failed connect or consume still surfaces through the status line
  and the view's own error row ([nfr/004](./nfr/004-reliability-and-errors.md)); the loader
  only covers the pending state.
- **A permanent status bar.** The spinner is live state and renders nothing when idle —
  the standing convention from [022](./022-help-panel.md).
- **Progress bars.** Nothing on the seam reports fractional progress today; a fake bar
  would be a lie ([nfr/006](./nfr/006-data-fidelity.md)'s spirit, applied to the UI).

## Technical Notes

- `Loading` and `Spinner` are ported from monq's `components/Loading.tsx` — braille frames,
  120 ms tick. The big loader runs one deterministic wave pass, then random frames, so two
  long waits side by side do not look mechanically identical.
- The spinner colour is `theme.primary`, the message `theme.textDim`; no hex literals
  outside `theme.ts` ([nfr/005](./nfr/005-code-quality-and-architecture.md)).
- App already guards double-connect with a ref; rendering the loader needs the same fact as
  *state*, so `connecting` is both — the ref for the synchronous guard, the state for the
  paint.
- The message pools live in `src/views/loadingMessages.ts`, split by context (connect vs
  topics) so a topic-list wait never claims to be talking to a key vault.

## File Structure

| File | Change |
|------|--------|
| `src/views/Loading.tsx` | New — `Loading` (full pane) and `Spinner` (inline) |
| `src/views/loadingMessages.ts` | New — connect and topic message pools |
| `src/App.tsx` | `connecting` state; the loader replaces the picker while it runs |
| `src/views/TopicList.tsx` | `Loading` in place of the "loading topics…" line |
| `src/views/MessageTable.tsx` | `Spinner` beside the window line's `loading` label |
