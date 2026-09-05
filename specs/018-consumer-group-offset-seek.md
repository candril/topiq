# Consumer Group Offset Seek

**Status**: In Progress — P1 built, P2 and P3 open. Exercised against a fake client only:
nothing in the suite can reach a broker, and no `setGroupOffsets` has ever run against a live
cluster (`allow_write` is `false` on both configured profiles).

## Description

Move a consumer group's committed offsets — to an offset, a timestamp, the beginning, or
the end. This subsumes the org's documented dance of scale down → edit the group in a web
console → scale up, replacing the middle step.

## Capabilities

### P1 — Must Have

- Set offsets for a group on a topic: `beginning` | `end` | absolute offset | timestamp
  (resolved per partition, reusing [009](./009-paging-and-fetch-modes.md)'s lookup).
- **Requires the group to be empty.** Show the group's state and refuse with an
  explanation when it isn't — do not attempt and surface a broker error.
- Gated by `allow_write` plus a confirm dialog naming group, topic, cluster and the
  before → after offsets per partition ([019](./019-write-safety.md)).
- Report the resulting committed offsets after the write.

### P2 — Should Have

- Seek a single partition rather than the whole topic.
- Show the resulting lag change before confirming.

### P3 — Nice to Have

- Shift by a relative amount (`-1000`).

## Out of Scope

- Scaling the consumer down and up. That stays manual/kubectl
  ([000](./000-vision.md) Non-Goals) — topiq replaces the console step, not the deployment
  step. Said in three places so nobody expects otherwise: the seek bar's hint, the refusal
  when the group is not empty, and a warning line in the confirm dialog.

## Behaviour

### Keys (group list)

| Key | Action |
|-----|--------|
| `o` | Open the seek bar on the group under the cursor |
| `h`/`l`, `←`/`→`, `j`/`k` | Pick beginning / end / offset / timestamp |
| `enter` | Resolve the target against the broker and open the confirm dialog |
| `shift+S` | Confirm the write |
| `esc` | Cancel, at any step |

`o` opens and `shift+S` confirms: trigger and confirm are different keys, so a held key
cannot open the dialog and answer it in one stroke ([013](./013-byte-exact-replay.md)).
`o` is the fetch prompt's "offset" mnemonic; `s` in this view already cycles the sort.

### The flow

1. `o` — refused immediately with its reason if writes are off or no cluster is connected
   ([019](./019-write-safety.md) P1: a blocked command is drawn disabled, never absent).
2. Pick a target; `offset` and `timestamp` open an `<input>` for the value, parsed by the
   same `parseRangeInput` the fetch prompt uses.
3. `enter` resolves the plan against the broker: the group is re-described (state, member
   count, committed offsets) and the target is resolved per partition. Anything other than
   `Empty` refuses here, naming the state and the member count.
4. The confirm dialog names cluster, env, group, topic, target, the partition count and the
   per-partition `before → after` lines.
5. `shift+S` writes, then re-reads the group's committed offsets and reports them.

## Technical Notes

- **`end` is a `FetchRange` kind**, not `latestN` arithmetic: `latestN` cannot express "the
  high watermark" (its `n` is ≥ 1), and the seek needs Kafka's own LATEST.
- **"Empty" is checked twice, and the second check is the one that counts.** The preview
  checks it to explain rather than attempt; `setGroupOffsets` re-checks immediately before
  the write, because a group can rejoin while the dialog is open. Both call
  `groupSeekRefusal` in `src/kafka/groups.ts` — one wording, so the explanation and the
  refusal cannot diverge.
- **The seam resolves, the write re-resolves.** The dialog's `after` column comes from
  `resolveOffsets`; `setGroupOffsets` resolves the same `FetchRange` again at write time,
  so `end` means "the end when you confirmed it", not a number that went stale while the
  dialog was open. What makes that honest is the read-back below.
- **The result line is read back from the broker**, never echoed from the plan. A plan that
  was only partly applied is reported as `1/2 partitions moved` with the partitions that
  missed — see the resolved question below.
- A target that resolves to where the group already sits moves nothing, and the gate then
  refuses with "nothing to seek" instead of opening a dialog for a no-op.
- A partition the target does not resolve to (a timestamp past the end of that partition)
  is **left alone**, not rewound to the log start, and the dialog counts it as `unchanged`.
- Every offset is `bigint` from the broker to the confirm line ([nfr/006](./nfr/006-data-fidelity.md));
  a partition count is the only `number` here.

## Resolved Questions

- **What does the client do if the group rebalances mid-write?** kafkajs' `setOffsets` is
  one request per topic, but it is not a transaction and the reply does not say what
  landed. Rather than trust it, the write is followed by a `describeGroup` and the report
  compares the committed offsets against the plan: a mismatch is reported as a partial
  apply naming each partition (`p1 asked 0, committed 5`) and shown as an **error**, not a
  success. A rejoin *before* the write is caught by the emptiness re-check and nothing is
  written at all.

## Open Questions

- P2's single-partition seek needs the seam to take resolved starts rather than a
  `FetchRange` — worth doing when `--to-datetime`-style partial seeks come up, not before.
- The bar seeks the group it was opened on, not the group under the cursor. That is
  deliberate (a refresh can move the cursor), but nothing on screen restates the group id
  once the dialog is open beyond the dialog's own `group` line.

## File Structure

| File | Change |
|------|--------|
| `src/kafka/groups.ts` | `groupSeekRefusal` — the one wording of "must be Empty" |
| `src/kafka/range.ts` | `end` range kind |
| `src/kafka/types.ts` | `resolveOffsets` on the seam; `setGroupOffsets`' refusal contract |
| `src/kafka/client.ts` | `resolveOffsets`; the pre-write emptiness re-check |
| `src/seek/model.ts` | Targets, `before → after` rows, preview lines, the result report — pure |
| `src/seek/run.ts` | `planSeek` (broker round trip + gate) and `commitSeek` |
| `src/safety/gate.ts` | `seek` action carries `moves`; the "scaling stays manual" warning |
| `src/state/types.ts`, `src/state/groups.ts` | `GroupSeekState` and its actions |
| `src/views/OffsetSeek.tsx` | The bottom bar + `seekBarRows`, the shared row count |
| `src/views/GroupList.tsx` | `o`, the seek keymap, the confirm answer |
