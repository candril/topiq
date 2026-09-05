# Write Safety

**Status**: In Progress — P1 built (gate module + shared dialog), and every write path now
goes through it ([013](./013-byte-exact-replay.md)–[016](./016-cross-cluster-copy.md),
[018](./018-consumer-group-offset-seek.md)): `src/replay/produce.ts` and `src/seek/run.ts`
are the only callers of `client.produce` and `client.setGroupOffsets`, and both bodies sit
inside `commitWrite`. One P1 bullet is met only in part: a blocked write is drawn with its
**reason** in the command palette and stated in full when the key is pressed, but the message
table's own status line shows the word `read-only` rather than the reason. P2/P3 pending.

## Description

Every path that mutates a cluster — producing ([013](./013-byte-exact-replay.md),
[014](./014-edit-and-replay.md), [015](./015-craft-message.md),
[016](./016-cross-cluster-copy.md)) and offset seeking
([018](./018-consumer-group-offset-seek.md)) — goes through one gate. topiq is read-only
by default; writing is opt-in per cluster and confirmed at the point of action.

## Capabilities

### P1 — Must Have

- `allow_write` defaults to **false** on every profile ([002](./002-cluster-config.md)).
  With it false, write commands are visibly disabled with the reason, not silently absent
  and not failing at the broker.
- One confirm dialog for all writes, naming: **action, cluster (and its environment
  label), topic/group, and message count**.
- For a replay, the dialog surfaces the message's **age** — replaying an old snapshot
  re-applies stale state on snapshot-style topics, which is the realistic way this tool
  causes damage ([008](./008-message-detail.md)).
- For a cross-cluster copy, the dialog states that bytes will differ and why
  ([016](./016-cross-cluster-copy.md)).
- Confirmation is a deliberate keystroke, never `y`-on-Enter-by-reflex on a
  production-labelled cluster.

### P2 — Should Have

- Production-labelled profiles (declared `env`,
  [023](./023-cluster-groups-and-environments.md)) render in a distinct colour
  everywhere, so the mode is visible before the dialog, not only in it.
- A session write log: what was produced where, so a debugging session is reconstructable.
- **Built:** typed confirmation for **every** production write, not only a copy — the
  dialog holds an `<input>` and `shift+<key>` refuses until the cluster name matches
  (trimmed, case-sensitive: a cluster name is an identifier). Nothing about a prod replay
  or offset seek makes it safer than a prod copy, so the gate applies it uniformly
  ([016](./016-cross-cluster-copy.md) P1).

### P3 — Nice to Have

- `--read-only` flag overriding config for a session.

## Out of Scope

- Undo. Kafka has none — a produced message cannot be unproduced. The gate is the
  protection; do not imply reversibility anywhere in the UI.

## Technical Notes

- The gate is a single module every write path calls; a write that constructs its own
  confirmation is a review failure.
- `allow_write` is checked at the moment of the write as well as at render time — config
  reload must not leave a stale-enabled command.

## File Structure

| File | Change |
|------|--------|
| `src/safety/gate.ts` | The single write gate |
| `src/views/ConfirmWrite.tsx` | Shared dialog |

## Implementation Notes (P1)

The gate exports four things; a write path uses all of them and defines none of its own.

- `writeBlockedReason(profile | null): string | null` — render-time availability. A view
  draws the write command **disabled with this string**, never omits it. Null means
  writable.
- `evaluateWrite(profile | null, action, now): WriteGate` — the decision. Refuses with the
  same reason string (so pressing a disabled command shows *why*, rather than nothing), or
  allows with a `ConfirmPrompt` that already contains every line and warning the dialog
  shows. For a cross-cluster copy the profile passed is the **destination** — that is what
  gets written.
- `confirmResponse(prompt, key): "confirm" | "cancel" | null` — the deliberate keystroke,
  in one place. Confirm is `shift+<letter>`, the letter being the first of the dialog's own
  title verb (Replay → `R`, Produce → `P`, Copy → `C`, Seek → `S`), so it varies by action
  and cannot be hit by the enter/`y` reflex that dismisses every other prompt. Esc cancels;
  every other key is ignored rather than treated as an answer.
- `commitWrite(currentProfile, action, write)` — the moment-of-write recheck, throwing
  `WriteBlockedError` if the config reloaded `allow_write` to false in between. The first
  argument is a **thunk**, not a profile: a captured profile would re-answer with the same
  stale config the dialog was built from, which is the exact failure this check exists for.

`WriteAction` is a discriminated union (`replay` | `edit-replay` | `craft` | `copy` |
`seek`); `oldest` is required on every kind with an original message, so a replay dialog
cannot be constructed without its age. Staleness warns past one hour. A `craft` carries the
subject, version and id it was encoded against ([015](./015-craft-message.md)): crafting
resolves the subject's *latest*, and which version that turned out to be belongs in the
dialog rather than in the user's assumptions. A `copy` carries the source profile, the
source topic and one pre-rendered `schemas` line per field
([016](./016-cross-cluster-copy.md)) — data, like a seek's `moves`, so the dialog cannot
name a translation the write does not perform; its title says *re-encoded, not byte-exact*
in the headline rather than only in the warnings, and the confirm key is still derived from
the verb's first letter.

`PendingWrite` carries the profile **name** of the cluster it is aimed at. A copy's bytes
are encoded for the destination registry and mean something else anywhere else, so the
write resolves its client from that name and refuses when this session does not hold that
connection — the dialog names one cluster, and the produce reaches that one or none.

The dialog is absolutely positioned and centred, like `HelpPanel` — deliberately *not* a
bottom bar. Modal and out of the flow means no list has to reserve rows for it; an overlay
pushed off the bottom would leave a keystroke waiting on text nobody can read.
