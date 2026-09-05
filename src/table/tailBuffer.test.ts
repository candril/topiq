import { describe, expect, test } from "bun:test"
import {
  appendBounded,
  droppedLabel,
  pushBounded,
  tailLabel,
  tailStarts,
  TAIL_CAP,
  TAIL_QUEUE_CAP,
} from "@/table/tailBuffer.ts"
import { WINDOW_CAP } from "@/table/window.ts"
import type { DecodedMessage, PartitionMeta } from "@/types.ts"

function msg(partition: number, offset: bigint): DecodedMessage {
  return {
    topic: "t",
    partition,
    offset,
    timestamp: new Date(0),
    key: null,
    value: null,
    headers: {},
    decodedKey: null,
    decodedValue: null,
  }
}

function part(id: number, high: bigint): PartitionMeta {
  return { id, low: 0n, high }
}

describe("appendBounded", () => {
  test("arrivals land at the front, newest of the batch first", () => {
    const result = appendBounded([msg(0, 1n)], [msg(0, 2n), msg(0, 3n)], 10)
    expect(result.rows.map((m) => m.offset)).toEqual([3n, 2n, 1n])
    expect(result.dropped).toBe(0)
  })

  test("evicts oldest-first at the cap and reports how many", () => {
    const result = appendBounded([msg(0, 2n), msg(0, 1n)], [msg(0, 3n), msg(0, 4n)], 3)
    expect(result.rows.map((m) => m.offset)).toEqual([4n, 3n, 2n])
    expect(result.dropped).toBe(1)
  })

  test("a batch larger than the cap keeps the newest rows", () => {
    const incoming = [msg(0, 1n), msg(0, 2n), msg(0, 3n), msg(0, 4n)]
    const result = appendBounded([msg(0, 0n)], incoming, 2)
    expect(result.rows.map((m) => m.offset)).toEqual([4n, 3n])
    expect(result.dropped).toBe(3)
  })

  test("an empty batch neither drops nor aliases the previous rows", () => {
    const rows = [msg(0, 1n)]
    const result = appendBounded(rows, [], 1)
    expect(result.dropped).toBe(0)
    expect(result.rows).not.toBe(rows)
    expect(result.rows).toEqual(rows)
  })
})

describe("pushBounded", () => {
  test("drops the front once the queue is full", () => {
    const queue: number[] = []
    for (const n of [1, 2, 3]) {
      expect(pushBounded(queue, n, 3)).toBe(0)
    }
    expect(pushBounded(queue, 4, 3)).toBe(1)
    expect(queue).toEqual([2, 3, 4])
  })

  test("the queue never grows past the cap, however fast the broker is", () => {
    const queue: number[] = []
    let dropped = 0
    for (let i = 0; i < 10_000; i++) {
      dropped += pushBounded(queue, i, 100)
    }
    expect(queue.length).toBe(100)
    expect(dropped).toBe(9900)
    expect(queue[99]).toBe(9999)
  })
})

describe("tailStarts", () => {
  test("resumes one past the newest offset already on screen", () => {
    const starts = tailStarts([msg(0, 40n), msg(0, 41n), msg(1, 7n)], [part(0, 99n), part(1, 99n)])
    expect(starts).toEqual([
      { partition: 0, offset: 42n },
      { partition: 1, offset: 8n },
    ])
  })

  test("falls back to the high watermark for a partition with nothing on screen", () => {
    expect(tailStarts([], [part(3, 512n)])).toEqual([{ partition: 3, offset: 512n }])
  })

  test("offsets past 2^53 stay exact — no Number ever touches them (nfr/006)", () => {
    const big = 9007199254740993n
    const starts = tailStarts([msg(0, big)], [part(0, big)])
    expect(starts[0]?.offset).toBe(big + 1n)
  })

  test("rows arriving out of order still resume from the maximum", () => {
    const starts = tailStarts([msg(0, 9n), msg(0, 3n)], [part(0, 20n)])
    expect(starts[0]?.offset).toBe(10n)
  })
})

describe("labels", () => {
  test("the tail states what it is doing, and nothing while it is off", () => {
    expect(tailLabel("off")).toBeNull()
    expect(tailLabel("following")).toBe("following")
    expect(tailLabel("paused")).toBe("paused")
    expect(tailLabel("error")).toBe("tail failed")
  })

  test("dropped rows are announced, never silent (nfr/004)", () => {
    expect(droppedLabel(0)).toBeNull()
    expect(droppedLabel(17)).toBe("17 dropped")
  })

  test("the tail is bounded by the same cap as a fetched window", () => {
    expect(TAIL_CAP).toBe(WINDOW_CAP)
    expect(TAIL_QUEUE_CAP).toBe(WINDOW_CAP)
  })
})
