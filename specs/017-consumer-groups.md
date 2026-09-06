# Consumer Groups & Lag

**Status**: In Progress — P1 and P2 built, P3 open

## Description

Which groups consume a topic, what state they're in, and how far behind each partition is.
The read half of the consumer-group story; the write half is
[018](./018-consumer-group-offset-seek.md).

Lag is a per-topic figure, so there is no group view without a topic: the view is opened
from a topic row in the topic list (`c`) and reports every number against that topic.
Everything in it reads, with one exception: `o` starts the offset seek of
[018](./018-consumer-group-offset-seek.md), which mutates only behind the write gate.

## Capabilities

### P1 — Must Have

- List groups on the cluster with state (`Stable`, `Empty`, `PreparingRebalance`, …) and
  member count.
- Per-group detail: per-partition committed offset, high watermark, and **lag as
  `high − committed`, computed in `bigint`** ([004](./004-data-model.md),
  [nfr/006](./nfr/006-data-fidelity.md)).
- Total lag per group, visible in the list.

### P2 — Should Have

- Filter the group list to those consuming the current topic.
- Member detail: client id/host and assigned partitions — the "who is stuck" question.
- Refresh on demand; lag is a moving number and a stale one misleads.

### P3 — Nice to Have

- Lag trend over the session (is it draining or growing?).

## Out of Scope

- Deleting groups; scaling consumers ([000](./000-vision.md) Non-Goals).
- Changing offsets — [018](./018-consumer-group-offset-seek.md) owns the write, its gate
  and its dialog; this spec owns only the list it is launched from.

## Behaviour

### Keys

| Key | Action |
|-----|--------|
| `c` (topic list) | Open the group view for the topic under the cursor |
| `j`/`k`, `↑`/`↓`, `^n`/`^p`, `^d`/`^u`, `g`/`G` | Move ([020](./020-keyboard-navigation.md)) |
| `p` / `enter` | Per-partition committed · high · lag for the cursor group |
| `m` | Members: client id, host, assigned partitions |
| `J`/`K` | Scroll the open pane |
| `t` | Toggle "only groups consuming this topic" (on by default) |
| `e` | Toggle topiq's own `topiq-read-*` reader groups (off by default) |
| `s` | Cycle sort: name → lag → state |
| `/` | Filter by group id |
| `r` | Refresh state and lag |
| `o` | Seek this group's committed offsets ([018](./018-consumer-group-offset-seek.md)) |
| `h`/`←`/`esc` | Back to the topic list |

One pane at a time (`p` and `m` replace each other), so `J`/`K` never has two things it
could scroll. Asking for the open pane closes it.

### What the lag column can say

| Cell | Meaning |
|------|---------|
| `1,234` | Measured lag: Σ `high − committed` over the group's partitions |
| `—` | **Undefined**, not zero: the group has committed nothing on this topic |
| `1,234+?` | A floor: some partition has no committed offset, so the real total is higher |
| `…` | The committed-offset fetch for this group is still in flight |
| `?` | The fetch finished without an answer for this group — the row stays, unmeasured |

## Technical Notes

- A group with no committed offset for a partition has *undefined* lag, not zero. Render
  it as `—`; reporting zero would be a lie in the dangerous direction. The same rule
  propagates to the total: an uncommitted partition is **counted**, never summed as zero,
  and the total is marked `+?` to say it is a floor.
- **topiq's own reader groups are hidden by default.** kafkajs cannot read without a
  consumer group, so every window topiq opens joins an ephemeral
  `topiq-read-<os user>-<random>` group with autoCommit off
  ([003](./003-kafka-client-seam.md), [009](./009-paging-and-fetch-modes.md),
  [029](./029-connection-hygiene-and-fetch-latency.md)). Those are our litter, not the
  user's consumers: on a topic that has been peeked at all day they would bury the real
  ones. `e` reveals them, dimmed. `src/kafka/groups.ts` owns the prefix constant and
  `identity.ts` builds the ids from it, so the filter cannot drift from the generator.
- **Two-phase load.** The listing is one round-trip; lag costs a committed-offset fetch
  *per group*, batched behind the seam's `describeGroups` — one `DescribeGroups` and one
  watermark read for the whole list, `OffsetFetch` per group at a concurrency of 8
  ([029](./029-connection-hygiene-and-fetch-latency.md)). The list paints on the listing
  and lag fills in after — one combined await would leave the view blank for as long as
  the slowest group takes. Rows whose detail fetch failed stay in the list with unmeasured
  lag (`null` in the batch): dropping them would under-report which groups exist.
- **"Consumes this topic"** means a committed offset on it *or* a member assigned one of
  its partitions. Membership alone does not count — a member of a multi-topic group can be
  assigned nothing here. A group whose detail has not landed yet stays visible under the
  filter: "not measured yet" is not "does not consume this topic".
- Member assignments come from the broker's opaque assignment blob, decoded with kafkajs'
  `AssignerProtocol`. A custom assignor can write something it cannot read, so a failed
  decode reports "no partitions listed", never a crash that takes the group list down.
- Lag is `high − committed` from two reads that are not atomic, so a fast-moving partition
  can briefly show a negative lag. It is rendered as read rather than clamped to zero — the
  clamp would hide that the two figures disagree.
- The seam's `listGroups` carries `memberCount` (free: `describeGroups` already returns the
  members), which is what lets the list render before any lag is known.

## File Structure

| File | Change |
|------|--------|
| `src/kafka/groups.ts` | Lag math, ephemeral-group prefix, row shaping/sort/filter — pure |
| `src/kafka/types.ts` | `listGroups` returns `GroupOverview[]` (adds `memberCount`) |
| `src/kafka/client.ts` | Members + decoded assignment on `describeGroup` |
| `src/types.ts` | `GroupOverview`, `GroupMemberMeta`; `ConsumerGroupMeta.members` |
| `src/state/groups.ts` | View state: cursor, toggles, sort, the single pane |
| `src/views/GroupList.tsx` | The list, its keymap, the bottom bar |
| `src/views/GroupPanes.tsx` | Offsets and members panes + the shared row-count helper |
| `src/views/useGroups.ts` | Two-phase load and refresh — one `describeGroups` call, not a fan-out |

## Open Questions

- P3 lag trend needs a sampling cadence and somewhere to keep the samples. Poll on a timer,
  or only on each manual `r`? A timer that fetches offsets for every group is the most
  expensive thing this view could do, so the default is probably manual.
