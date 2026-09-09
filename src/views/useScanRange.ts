import { useEffect, useRef, useState } from "react"
import type { ConsumeHandle, KafkaClient } from "@/kafka/types.ts"
import { decodeMessage } from "@/schema/decode.ts"
import type { SchemaFetcher } from "@/schema/registry.ts"
import type { MessageScanState } from "@/state/types.ts"
import {
  measureRate,
  SCAN_CAP,
  SCAN_QUEUE_CAP,
  type RateSample,
  type ScanStatus,
} from "@/table/scan.ts"
import { plannedCount } from "@/table/window.ts"
import type { DecodedMessage, RawMessage } from "@/types.ts"
import { compileFilter } from "./filterBarModel.ts"

// Scan mode (spec 030): a third consumer beside the window and the tail. It reads a whole
// range with no limit, tests every message against the predicate the scan started with,
// and keeps only the hits — so memory is bounded by matches, not by messages read. Like
// the other two it runs off the input path: arrivals queue and flush once per frame tick,
// never one render per message (nfr/001).

const FLUSH_MS = 33

export interface ScanResult {
  /** The hits so far, or null while scan mode is off — the caller then shows the window. */
  rows: DecodedMessage[] | null
  /** Raw messages delivered so far — counted before decode, so it leads the hits. */
  scanned: number
  /** Messages the range held when the scan started; null while unresolved or unknowable. */
  planned: bigint | null
  status: ScanStatus
  error: string | null
  /** Messages per second over the last second, once one has elapsed (spec 030 P2). */
  rate: number | null
}

interface Progress {
  rows: DecodedMessage[]
  scanned: number
  planned: bigint | null
  status: ScanStatus
  error: string | null
  rate: number | null
}

const IDLE: ScanResult = {
  rows: null,
  scanned: 0,
  planned: null,
  status: "end",
  error: null,
  rate: null,
}

const FRESH: Progress = {
  rows: [],
  scanned: 0,
  planned: null,
  status: "scanning",
  error: null,
  rate: null,
}

/** What a stop from outside the effect can reach: the consumer, and the waiters a stopped
 *  fetch must not be left hanging on — kafkajs's disconnect waits for the batch in flight. */
interface Controller {
  stop(): void
}

export function useScanRange(
  client: KafkaClient,
  registry: SchemaFetcher,
  topic: string,
  scan: MessageScanState | null,
): ScanResult {
  const run = scan?.run ?? null
  const range = scan?.range
  const query = scan?.query
  const stopped = scan?.stopped ?? false

  // Reset during render, not in the effect: hits from the previous run must never paint
  // under the new run's header, and a setState in an effect cascades a render for nothing.
  const [current, setCurrent] = useState<{ run: number | null; progress: Progress }>({
    run,
    progress: FRESH,
  })
  if (current.run !== run) {
    setCurrent({ run, progress: FRESH })
  }

  const controller = useRef<Controller | null>(null)

  useEffect(() => {
    if (run === null || range === undefined || query === undefined) {
      return
    }
    const active = run
    const patch = (update: (progress: Progress) => Partial<Progress>): void => {
      setCurrent((prev) =>
        // A late batch from a superseded run must not land in the new one.
        prev.run === active
          ? { run: prev.run, progress: { ...prev.progress, ...update(prev.progress) } }
          : prev,
      )
    }

    // Compiled here, from the scan's own query, not taken from the bar: the bar can change
    // while the scan runs, and rows already discarded cannot be recovered by widening it.
    const compiled = compileFilter(query)
    if (compiled.error !== null) {
      const error = compiled.error
      patch(() => ({ status: "error", error }))
      return
    }
    const predicate = compiled.predicate

    let cancelled = false
    // Set once the read is over for any reason: arrivals after it are a batch kafkajs was
    // already delivering, and counting them would move a finished number.
    let finished = false
    let capped = false
    let stoppedByHand = false
    let handle: ConsumeHandle | null = null
    let timer: ReturnType<typeof setInterval> | null = null
    const pending: RawMessage[] = []
    let waiters: (() => void)[] = []
    let scanned = 0
    let published = 0
    let hits = 0
    let sample: RateSample = { at: Date.now(), count: 0 }
    let rate: number | null = null
    // Decode is async: chaining flushes keeps hits landing in scan order even when a
    // registry fetch makes one batch slower than the next.
    let decodeChain: Promise<void> = Promise.resolve()

    const release = (): void => {
      const waiting = waiters
      waiters = []
      for (const resolve of waiting) {
        resolve()
      }
    }

    const flush = (): void => {
      const reading = measureRate(sample, { at: Date.now(), count: scanned }, rate)
      sample = reading.sample
      rate = reading.rate
      const batch = pending.splice(0)
      // The queue is drained, so a fetch waiting on it may go on.
      release()
      // The count is published from here, never from the decode chain: a chain link that
      // finishes after a later flush would otherwise move the number backwards. Only when
      // it moved — a stalled fetch must not cost a render per tick.
      if (scanned !== published) {
        published = scanned
        patch(() => ({ scanned, rate }))
      }
      if (batch.length === 0) {
        return
      }
      decodeChain = decodeChain.then(async () => {
        const decoded = await Promise.all(batch.map((raw) => decodeMessage(raw, registry)))
        if (cancelled) {
          return
        }
        let matched = decoded.filter(predicate)
        if (hits + matched.length >= SCAN_CAP) {
          // Nothing is evicted: the first hits are what a scan promised, so the cap ends
          // the read rather than rolling it (spec 030).
          matched = matched.slice(0, SCAN_CAP - hits)
          capped = true
        }
        hits += matched.length
        if (matched.length > 0) {
          patch((p) => ({ rows: [...p.rows, ...matched] }))
        }
        if (capped && !finished) {
          finished = true
          release()
          void handle?.stop()
        }
      })
    }

    const onMessage = (m: RawMessage): Promise<void> | undefined => {
      if (finished) {
        return undefined
      }
      pending.push(m)
      scanned++
      if (pending.length < SCAN_QUEUE_CAP) {
        return undefined
      }
      // Backpressure, never a drop: a scan that skipped a message is a wrong answer. The
      // fetch waits here until the next flush drains the queue (spec 030).
      return new Promise<void>((resolve) => waiters.push(resolve))
    }

    controller.current = {
      stop() {
        stoppedByHand = true
        finished = true
        release()
        void handle?.stop()
      },
    }

    const execute = async (): Promise<void> => {
      // A watermark snapshot for the header's denominator. Unknowable is shown as such
      // rather than failing the scan — the read itself resolves the range again.
      const planned = await Promise.all([
        client.resolveOffsets(topic, range),
        client.describeTopic(topic),
      ])
        .then(([starts, meta]) => plannedCount(starts, meta.partitions))
        .catch(() => null)
      if (cancelled) {
        return
      }
      patch(() => ({ planned }))
      // Infinity, not the cap: the cap bounds hits, and the hook stops the consumer itself
      // when they reach it. A limit on messages read would end the scan early and silently.
      handle = await client.consume(topic, { range, limit: Number.POSITIVE_INFINITY }, onMessage)
      if (cancelled) {
        release()
        await handle.stop()
        return
      }
      if (finished) {
        // Stopped before the consumer came up: there are no hits, but the status still has
        // to say "stopped" rather than spin, so fall through to the finalisation below.
        release()
        void handle.stop()
      }
      timer = setInterval(flush, FLUSH_MS)
      await handle.done
      // The read is over: the ticker has nothing left to do, and leaving it armed is an
      // idle 30Hz timer per finished scan.
      clearInterval(timer)
      timer = null
      finished = true
      flush()
      release()
      await decodeChain
      if (cancelled) {
        return
      }
      patch(() => ({
        status: capped ? "capped" : stoppedByHand ? "stopped" : "end",
        scanned,
        rate,
      }))
    }

    execute().catch((err: unknown) => {
      if (!cancelled) {
        patch(() => ({ status: "error", error: err instanceof Error ? err.message : String(err) }))
      }
    })

    return () => {
      cancelled = true
      finished = true
      controller.current = null
      if (timer !== null) {
        clearInterval(timer)
      }
      // Waiters first: kafkajs's disconnect waits for the batch in flight, and a batch
      // parked on backpressure would hold the socket open past the unmount (spec 001).
      release()
      void handle?.stop()
    }
  }, [client, registry, topic, range, query, run])

  useEffect(() => {
    if (stopped) {
      controller.current?.stop()
    }
  }, [stopped])

  if (run === null) {
    return IDLE
  }
  return current.progress
}
