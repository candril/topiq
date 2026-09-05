import type { ClusterProfile } from "@/config/schema.ts"
import { groupSeekRefusal } from "@/kafka/groups.ts"
import type { FetchRange } from "@/kafka/range.ts"
import type { KafkaClient } from "@/kafka/types.ts"
import {
  commitWrite,
  evaluateWrite,
  writeBlockedReason,
  type ConfirmPrompt,
  type WriteAction,
} from "@/safety/gate.ts"
import { seekAction, seekResult, seekRows, type SeekResult, type SeekRow } from "./model.ts"

// The two broker-touching halves of an offset seek (spec 018): building the preview, and
// running the write behind the gate. They talk to the seam only — no kafkajs above
// `src/kafka/client.ts` (spec 003).

/** What a confirmed seek will do. Resolved before the dialog opens, so confirming can only
 *  commit the target the dialog described. */
export interface SeekPlan {
  groupId: string
  topic: string
  range: FetchRange
  /** Per-partition before → after, straight from the broker. */
  rows: SeekRow[]
}

export interface PendingSeek {
  prompt: ConfirmPrompt
  /** The same action the prompt was built from, re-checked at the moment of the write. */
  action: WriteAction
  plan: SeekPlan
}

export type SeekPlanOutcome =
  | { kind: "confirm"; pending: PendingSeek }
  /** Nothing was attempted. The reason is shown as-is — the point of checking the group's
   *  state up front is that the user reads an explanation, not a broker error (spec 018). */
  | { kind: "refused"; reason: string }

export interface SeekPlanOptions {
  client: KafkaClient
  profile: ClusterProfile | null
  groupId: string
  topic: string
  range: FetchRange
  now: () => Date
}

/**
 * Resolve a seek target into a confirmable write.
 *
 * Order matters: the write gate and the group's state are checked *before* the target is
 * resolved, so a refusal costs no broker work — and, more importantly, a group that must
 * not be touched is never described as though it were about to be.
 */
export async function planSeek(opts: SeekPlanOptions): Promise<SeekPlanOutcome> {
  const blocked = writeBlockedReason(opts.profile)
  if (blocked !== null) {
    return { kind: "refused", reason: blocked }
  }
  const meta = await opts.client.describeGroup(opts.groupId, opts.topic)
  const refusal = groupSeekRefusal(opts.groupId, meta.state, meta.memberCount)
  if (refusal !== null) {
    return { kind: "refused", reason: refusal }
  }
  const rows = seekRows(meta.offsets, await opts.client.resolveOffsets(opts.topic, opts.range))
  const action = seekAction(opts.groupId, opts.topic, opts.range, rows)
  const gate = evaluateWrite(opts.profile, action, opts.now())
  if (!gate.allowed) {
    return { kind: "refused", reason: gate.reason }
  }
  return {
    kind: "confirm",
    pending: {
      prompt: gate.prompt,
      action,
      plan: { groupId: opts.groupId, topic: opts.topic, range: opts.range, rows },
    },
  }
}

/**
 * Commit a planned seek and report what the group actually committed.
 *
 * The emptiness re-check lives in the seam's `setGroupOffsets`, immediately before the
 * write — closer to it than anything here could be, and the same check for every caller.
 * `currentProfile` is a thunk so the gate's second look answers with the config as it
 * stands when the confirm key lands (spec 019).
 */
export async function commitSeek(
  client: KafkaClient,
  currentProfile: () => ClusterProfile | null,
  pending: PendingSeek,
): Promise<SeekResult> {
  return await commitWrite(currentProfile, pending.action, async () => {
    const { groupId, topic, range, rows } = pending.plan
    await client.setGroupOffsets(groupId, topic, range)
    const after = await client.describeGroup(groupId, topic)
    return seekResult(groupId, topic, rows, after.offsets)
  })
}
