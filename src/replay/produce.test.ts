import { describe, expect, test } from "bun:test"
import type { ClusterProfile } from "@/config/schema.ts"
import type { KafkaClient, ProduceRecord } from "@/kafka/types.ts"
import { WriteBlockedError } from "@/safety/gate.ts"
import type { DecodedMessage, RawMessage } from "@/types.ts"
import {
  commitProduce,
  producedLabel,
  replayAction,
  replayProduce,
  replayRecord,
  type ProducedAt,
} from "./produce.ts"

// Never a real client: these tests must not be able to reach a broker even by accident.
interface FakeProducer {
  client: KafkaClient
  sent: { topic: string; records: ProduceRecord[] }[]
}

function fakeClient(acks: ProducedAt[] = [{ partition: 3, offset: 4711n }]): FakeProducer {
  const sent: FakeProducer["sent"] = []
  const client = {
    async produce(topic: string, records: ProduceRecord[]) {
      sent.push({ topic, records })
      return acks.map((a) => ({ partition: a.partition, offset: a.offset ?? -1n }))
    },
  } as unknown as KafkaClient
  return { client, sent }
}

function profile(over: Partial<ClusterProfile> = {}): ClusterProfile {
  return {
    name: "orders-test",
    brokers: ["broker:9092"],
    registry: "https://registry:443",
    sasl: { mechanism: "scram-sha-256", username: "u" },
    passwordCmd: "echo hunter2",
    env: "test",
    allowWrite: true,
    ...over,
  }
}

// Confluent framing: magic byte 0, then the big-endian schema id, then the Avro body. The
// id is registry-local, so surviving as *these bytes* is the whole point of spec 013.
const FRAMED = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x2a, 0x02, 0x06, 0x66, 0x6f, 0x6f])

function message(over: Partial<RawMessage> = {}): RawMessage {
  return {
    topic: "dg-orders",
    partition: 2,
    offset: 981n,
    timestamp: new Date("2026-08-28T11:59:00Z"),
    key: Buffer.from([0x00, 0x00, 0x00, 0x00, 0x09, 0x0a]),
    value: FRAMED,
    headers: { traceparent: Buffer.from("00-abc-def-01"), bin: Buffer.from([0xff, 0x00, 0xfe]) },
    ...over,
  }
}

describe("replayRecord", () => {
  test("carries the very same buffers — no copy, no re-encode", () => {
    const m = message()
    const record = replayRecord(m)
    // Reference identity: a decode/re-encode round trip could not produce the same object,
    // so this asserts the absence of the round trip, not merely an equal result.
    expect(record.value).toBe(m.value)
    expect(record.key).toBe(m.key)
    expect(record.headers).toBe(m.headers)
  })

  test("the schema id bytes survive intact", () => {
    const record = replayRecord(message())
    expect(Buffer.compare(record.value as Buffer, FRAMED)).toBe(0)
    expect(record.value?.readUInt8(0)).toBe(0)
    expect(record.value?.readUInt32BE(1)).toBe(42)
  })

  test("ignores the decoded form entirely", async () => {
    // A decoded value deliberately inconsistent with the bytes: anything that re-encoded
    // would emit this instead, and the raw compare below would fail.
    const decoded: DecodedMessage = {
      ...message(),
      decodedKey: { id: 9 },
      decodedValue: { name: "REWRITTEN", extra: 1n },
    }
    const { client, sent } = fakeClient()
    await commitProduce(client, () => profile(), replayAction(decoded), replayProduce(decoded))
    expect(Buffer.compare(sent[0]!.records[0]!.value as Buffer, FRAMED)).toBe(0)
  })

  test("a tombstone replays as a tombstone", () => {
    const key = Buffer.from([0x01, 0x02])
    const record = replayRecord(message({ key, value: null }))
    expect(record.value).toBeNull()
    expect(record.key).toBe(key)
  })

  test("an empty value is not confused with a tombstone", () => {
    const record = replayRecord(message({ value: Buffer.alloc(0) }))
    expect(record.value).not.toBeNull()
    expect(record.value?.length).toBe(0)
  })

  test("no partition is chosen — the key's partitioner routes", () => {
    expect(replayRecord(message()).partition).toBeUndefined()
  })
})

describe("replayProduce", () => {
  test("targets the topic the message came from", () => {
    const produce = replayProduce(message({ topic: "dg-stock" }))
    expect(produce.topic).toBe("dg-stock")
    expect(produce.records).toHaveLength(1)
  })
})

describe("replayAction", () => {
  test("ages the dialog by the message's own timestamp", () => {
    const m = message()
    expect(replayAction(m)).toEqual({
      kind: "replay",
      topic: "dg-orders",
      count: 1,
      oldest: m.timestamp,
    })
  })
})

describe("commitProduce", () => {
  test("sends the raw record and reports partition + offset", async () => {
    const m = message()
    const { client, sent } = fakeClient([{ partition: 3, offset: 4711n }])
    const acks = await commitProduce(client, () => profile(), replayAction(m), replayProduce(m))

    expect(sent).toEqual([{ topic: "dg-orders", records: [replayRecord(m)] }])
    expect(acks).toEqual([{ partition: 3, offset: 4711n }])
  })

  test("a broker offset of -1 is reported as unknown, not as an offset", async () => {
    const m = message()
    const { client } = fakeClient([{ partition: 0, offset: null }])
    const acks = await commitProduce(client, () => profile(), replayAction(m), replayProduce(m))
    expect(acks).toEqual([{ partition: 0, offset: null }])
  })

  test("allow_write flipped off between dialog and keystroke blocks the send", async () => {
    const m = message()
    const { client, sent } = fakeClient()
    let current = profile()
    const action = replayAction(m)
    const produce = replayProduce(m)
    current = profile({ allowWrite: false })

    await expect(commitProduce(client, () => current, action, produce)).rejects.toBeInstanceOf(
      WriteBlockedError,
    )
    expect(sent).toEqual([])
  })

  test("no cluster blocks the send", async () => {
    const m = message()
    const { client, sent } = fakeClient()
    await expect(
      commitProduce(client, () => null, replayAction(m), replayProduce(m)),
    ).rejects.toBeInstanceOf(WriteBlockedError)
    expect(sent).toEqual([])
  })
})

describe("producedLabel", () => {
  test("names the topic, partition and new offset", () => {
    expect(producedLabel("dg-orders", [{ partition: 3, offset: 4711n }])).toBe(
      "replayed to dg-orders p3 @ 4711",
    )
  })

  test("says so when the broker reported no offset", () => {
    expect(producedLabel("dg-orders", [{ partition: 3, offset: null }])).toContain(
      "no offset reported",
    )
  })

  test("says so when the broker reported nothing at all", () => {
    expect(producedLabel("dg-orders", [])).toContain("without a partition or offset")
  })
})
