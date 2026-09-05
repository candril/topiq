import { useEffect, useRef, useState } from "react"
import type { FetchRange } from "@/kafka/range.ts"
import type { ConsumeHandle, KafkaClient } from "@/kafka/types.ts"
import type { Predicate } from "@/filter/types.ts"
import { decodeMessage } from "@/schema/decode.ts"
import type { SchemaFetcher } from "@/schema/registry.ts"
import {
  appendBounded,
  pushBounded,
  tailStarts,
  TAIL_CAP,
  TAIL_QUEUE_CAP,
  type TailStatus,
} from "@/table/tailBuffer.ts"
import type { DecodedMessage, PartitionMeta, RawMessage } from "@/types.ts"

// Follow mode (spec 012): a second consumer that resumes where the window ended and never
// stops at the high watermark. The consumer runs off the input path — arrivals queue in a
// plain array and flush into a single state update per frame tick, never one render per
// message (nfr/001).

const FLUSH_MS = 33

export interface FollowState {
  active: boolean
  paused: boolean
}

export interface FollowTail {
  /** The rows to display, or null while follow is off — the caller then shows the fetched
   *  window as it was. */
  rows: DecodedMessage[] | null
  /** Rows this session will never show: evicted at the cap or dropped under backpressure. */
  dropped: number
  status: TailStatus
  error: string | null
}

interface Buffer {
  rows: DecodedMessage[]
  dropped: number
}

const IDLE: FollowTail = { rows: null, dropped: 0, status: "off", error: null }

export function useFollowTail(
  client: KafkaClient,
  registry: SchemaFetcher,
  topic: string,
  range: FetchRange,
  /** The window as loaded: the buffer is seeded from it when follow starts. */
  seed: DecodedMessage[],
  partitions: readonly PartitionMeta[],
  follow: FollowState,
  /** Applied to every arrival before it is buffered, so a narrow filter can follow a busy
   *  topic (spec 012 P2) — a row that cannot match never costs a buffer slot. */
  predicate: Predicate,
): FollowTail {
  const [buffer, setBuffer] = useState<Buffer | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Seeded during render, not in an effect: an effect would paint one frame of an empty
  // table between pressing follow and the seed landing.
  if (follow.active && buffer === null) {
    setBuffer({ rows: [...seed], dropped: 0 })
    setError(null)
  }
  if (!follow.active && buffer !== null) {
    setBuffer(null)
  }

  // What the consumer needs at the moment it starts, and what the flush needs at the
  // moment it runs. Held in a ref so that neither a new predicate nor a later window row
  // restarts the consumer — a restart would re-seek and duplicate rows.
  const latest = useRef({ seed, partitions, predicate, paused: follow.paused })
  useEffect(() => {
    latest.current = { seed, partitions, predicate, paused: follow.paused }
  })

  useEffect(() => {
    if (!follow.active) {
      return
    }
    let cancelled = false
    let handle: ConsumeHandle | null = null
    const pending: RawMessage[] = []
    let queueDrops = 0
    // Decode is async: chaining flushes keeps batches landing in arrival order even when a
    // registry fetch makes one batch slower than the next.
    let decodeChain: Promise<void> = Promise.resolve()

    const flush = (): void => {
      // Drops are reported even while paused. Those rows are already gone, and a pause
      // that quietly truncates is exactly the silent loss nfr/004 forbids — the count has
      // to move while it happens, not on resume.
      if (queueDrops > 0) {
        const drops = queueDrops
        queueDrops = 0
        setBuffer((prev) => (prev === null ? prev : { ...prev, dropped: prev.dropped + drops }))
      }
      // Paused means "stop appending", not "stop consuming": the queue keeps filling to
      // its cap and lands in one batch on resume (spec 012).
      if (latest.current.paused || pending.length === 0) {
        return
      }
      const batch = pending.splice(0)
      decodeChain = decodeChain.then(async () => {
        const decoded = await Promise.all(batch.map((raw) => decodeMessage(raw, registry)))
        const matched = decoded.filter(latest.current.predicate)
        if (cancelled) {
          return
        }
        setBuffer((prev) => {
          if (prev === null) {
            return prev
          }
          const next = appendBounded(prev.rows, matched, TAIL_CAP)
          return { rows: next.rows, dropped: prev.dropped + next.dropped }
        })
      })
    }

    const run = async (): Promise<void> => {
      // Fresh watermarks: for a partition the window holds no rows from, tailStarts falls
      // back to its high watermark, and the window's copy is as old as the window. Using
      // it would skip everything produced to that partition since the load (nfr/004).
      const current = await client.describeTopic(topic).catch(() => null)
      const starts = tailStarts(
        latest.current.seed,
        current?.partitions ?? latest.current.partitions,
      )
      if (starts.length === 0) {
        // No partitions means no resume point, and a consumer with no seek reads from
        // wherever the ephemeral group lands — a tail that silently shows nothing forever
        // is worse than one that says why (nfr/004).
        throw new Error("the window has not resolved its partitions yet")
      }
      handle = await client.consume(
        topic,
        // Infinity, not the cap: the bounded buffer caps memory, and a tail that silently
        // stopped at a limit is indistinguishable from a quiet topic.
        { range, limit: Number.POSITIVE_INFINITY, startAt: starts, follow: true },
        (m) => {
          queueDrops += pushBounded(pending, m, TAIL_QUEUE_CAP)
        },
      )
      if (cancelled) {
        await handle.stop()
        return
      }
      // A tail never awaits `done` — it has no end — but the promise still rejects when
      // the consumer dies, and a follow that quietly stopped looks exactly like a quiet
      // topic (nfr/004).
      await handle.done
    }

    const timer = setInterval(flush, FLUSH_MS)
    run().catch((err: unknown) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : String(err))
      }
    })

    return () => {
      cancelled = true
      clearInterval(timer)
      // Leaving follow must stop the consumer: a leaked one holds a socket open and Bun
      // will not exit (spec 001).
      void handle?.stop()
    }
  }, [client, registry, topic, range, follow.active])

  if (!follow.active || buffer === null) {
    return IDLE
  }
  return {
    rows: buffer.rows,
    dropped: buffer.dropped,
    status: error !== null ? "error" : follow.paused ? "paused" : "following",
    error,
  }
}
