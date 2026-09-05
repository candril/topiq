import type { ClusterProfile } from "@/config/schema.ts"
import type { KafkaClient, ProduceRecord } from "@/kafka/types.ts"
import { commitWrite, type WriteAction, type WriteKind } from "@/safety/gate.ts"
import type { RawMessage } from "@/types.ts"

// Byte-exact replay (spec 013): the focused message's raw key, value and header buffers go
// back to the same topic on the same cluster, unchanged.
//
// Everything here takes `RawMessage`, never `DecodedMessage`. That is the enforcement, not
// a convention: a decode/re-encode round trip cannot happen in a function that has no
// access to the decoded form, and the embedded schema id therefore stays a byte of the
// payload rather than something re-derived against a registry (nfr/006, invariant 2).
// A path that produces from `decodedValue` is a bug even when the output happens to match.

/** Where a produced record landed. `offset` is null when the broker acknowledged without
 *  reporting one — reporting a placeholder as an offset would be a lie (nfr/004). */
export interface ProducedAt {
  partition: number
  offset: bigint | null
}

/** The exact bytes to send, decided before the confirm dialog opens. Holding this rather
 *  than the message means a confirmed write can no longer pick up anything decoded. */
export interface RawProduce {
  topic: string
  records: ProduceRecord[]
}

/**
 * The message as a produce record: the same `Buffer` instances, not copies and not a
 * re-serialisation.
 *
 * No `partition`: the key's partitioner picks, so key-based routing stays consistent with
 * every other producer on the topic (spec 013 P2). A tombstone stays a tombstone — a null
 * value is a deletion marker, so it is passed through as null rather than normalised to an
 * empty buffer, which would mean the opposite downstream.
 */
export function replayRecord(message: RawMessage): ProduceRecord {
  return {
    key: message.key,
    value: message.value,
    headers: message.headers,
  }
}

/** The single-message replay, aimed at the topic the message came from — the only target
 *  where byte-exactness holds, since schema ids are registry-local (spec 016). */
export function replayProduce(message: RawMessage): RawProduce {
  return { topic: message.topic, records: [replayRecord(message)] }
}

/** The gate's description of this replay (spec 019). Built here so the dialog's age line
 *  can only ever come from the message being replayed. */
export function replayAction(message: RawMessage): WriteAction {
  return { kind: "replay", topic: message.topic, count: 1, oldest: message.timestamp }
}

/**
 * Run a produce behind the gate's moment-of-write recheck (spec 019). `currentProfile` is a
 * thunk on purpose: it has to answer with the config as it stands when the confirm key
 * lands, not as it stood when the dialog was built.
 */
export async function commitProduce(
  client: KafkaClient,
  currentProfile: () => ClusterProfile | null,
  action: WriteAction,
  produce: RawProduce,
): Promise<ProducedAt[]> {
  return await commitWrite(currentProfile, action, async () => {
    const acks = await client.produce(produce.topic, produce.records)
    return acks.map((ack) => ({
      partition: ack.partition,
      offset: ack.offset < 0n ? null : ack.offset,
    }))
  })
}

/** Status-line result. Says where the copy landed and nothing about the original: the
 *  replay is a new record with a new offset and a broker-assigned timestamp (spec 013).
 *  `verb` distinguishes the paths — an edited replay is re-encoded, and a line that read
 *  the same as a byte-exact one would imply a guarantee it does not have (spec 014). */
export type ProduceKind = Exclude<WriteKind, "seek">

/** How each produce path is named in the status line. Separate words per kind on purpose:
 *  only spec 013's path is byte-exact, and a line reading the same for a re-encoded payload
 *  would imply a guarantee it does not have (specs 014, 015). */
const PRODUCE_VERBS: Record<ProduceKind, string> = {
  replay: "replayed",
  "edit-replay": "re-encoded and replayed",
  craft: "produced",
  copy: "copied",
}

const PRODUCE_NOUNS: Record<ProduceKind, string> = {
  replay: "replay",
  "edit-replay": "replay",
  craft: "produce",
  copy: "copy",
}

export function producedVerb(kind: WriteAction["kind"]): string {
  return kind === "seek" ? "written" : PRODUCE_VERBS[kind]
}

/** The word for the act itself, for "… cancelled" and "… failed". */
export function produceNoun(kind: WriteAction["kind"]): string {
  return kind === "seek" ? "write" : PRODUCE_NOUNS[kind]
}

/** `cluster` is named only when the write did not land on the connected one — a copy's
 *  whole point is that it went somewhere else, and a line that read like every other
 *  produce would leave that to be assumed (spec 016). */
export function producedLabel(
  topic: string,
  acks: ProducedAt[],
  verb = "replayed",
  cluster?: string,
): string {
  const where = cluster === undefined ? topic : `${cluster} · ${topic}`
  if (acks.length === 0) {
    return `produced to ${where} — the broker acknowledged without a partition or offset`
  }
  const at = acks
    .map((a) =>
      a.offset === null ? `p${a.partition} (no offset reported)` : `p${a.partition} @ ${a.offset}`,
    )
    .join(", ")
  return `${verb} to ${where} ${at}`
}
