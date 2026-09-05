# NFR: Performance & Responsiveness

**Status**: Draft

## Requirement

The TUI feels instant. Local interactions (cursor movement, opening a detail pane,
re-applying a filter) render on the next frame; broker and registry I/O never block input
or rendering.

## Criteria

- Keyboard navigation produces a visible response within one render frame.
- No synchronous network or disk I/O on the input path — including `password_cmd`, which
  runs once at connect, not per request ([../002-cluster-config](../002-cluster-config.md)).
- **The first frame never waits on the network.** `password_cmd` shells out to a vault
  (~2.5s against Azure KeyVault) and the first metadata round trip costs ~1.7s, so the
  renderer starts and paints *before* connecting; the cluster connect runs from a mount
  effect with the wait on the status line ([../001-app-shell](../001-app-shell.md)).
- All Kafka and registry calls are async; the UI stays interactive while they are in flight,
  with a visible in-flight state.
- Arriving messages in follow mode batch into **one state update per frame**, not one per
  message ([../012-live-tail](../012-live-tail.md)).
- Re-applying a filter re-evaluates the loaded window without re-fetching
  ([../010-filter-bar](../010-filter-bar.md)).
- Schema lookups are cached per cluster; a decode never triggers a registry round trip for
  an id already seen ([../005-schema-registry](../005-schema-registry.md)).
- Column inference is memoised over the window, not recomputed per render
  ([../007-message-table](../007-message-table.md)).

## Notes

- Memory is bounded by the buffer cap, not by topic size — the cap is a correctness
  property, not a tuning knob ([../012-live-tail](../012-live-tail.md)).
- If large windows become slow, virtualise row rendering before adding caches.
