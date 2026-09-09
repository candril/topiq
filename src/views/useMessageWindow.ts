import { useEffect, useState } from "react"
import type { FetchRange, PartitionStart } from "@/kafka/range.ts"
import { resolveStarts } from "@/kafka/range.ts"
import type { KafkaClient } from "@/kafka/types.ts"
import { decodeMessage } from "@/schema/decode.ts"
import type { SchemaFetcher } from "@/schema/registry.ts"
import { WINDOW_CAP } from "@/table/window.ts"
import type { DecodedMessage, PartitionMeta, RawMessage } from "@/types.ts"

// Consume one window through the seam and decode it (specs 007/009). The consumer runs
// off the input path: arriving messages queue in a plain array and flush into a single
// state update per frame tick — never one render per message (nfr/001).

const FLUSH_MS = 33

export type WindowPhase = "loading" | "done" | "error"

export interface ResolvedWindow {
  partitions: PartitionMeta[]
  /** null for timestamp ranges — the broker resolves those inside the client (spec 009). */
  starts: PartitionStart[] | null
}

export interface MessageWindow {
  rows: DecodedMessage[]
  phase: WindowPhase
  error: string | null
  resolved: ResolvedWindow | null
}

interface Request {
  client: KafkaClient
  registry: SchemaFetcher
  topic: string
  range: FetchRange
  reload: number
}

const EMPTY: MessageWindow = { rows: [], phase: "loading", error: null, resolved: null }

function sameRequest(a: Request, b: Request): boolean {
  return (
    a.client === b.client &&
    a.registry === b.registry &&
    a.topic === b.topic &&
    a.range === b.range &&
    a.reload === b.reload
  )
}

export function useMessageWindow(
  client: KafkaClient,
  registry: SchemaFetcher,
  topic: string,
  range: FetchRange,
  reload: number,
): MessageWindow {
  const request: Request = { client, registry, topic, range, reload }
  // Reset during render, not in the effect: the stale window must never paint against the
  // new request, and setState inside an effect cascades a second render for nothing.
  const [current, setCurrent] = useState<{ request: Request; window: MessageWindow }>({
    request,
    window: EMPTY,
  })
  if (!sameRequest(current.request, request)) {
    setCurrent({ request, window: EMPTY })
  }

  useEffect(() => {
    // Rebuilt from the dep values so the effect depends on exactly what it reads —
    // field-wise equal to the render's request by construction.
    const active: Request = { client, registry, topic, range, reload }
    let cancelled = false
    let flushTimer: ReturnType<typeof setInterval> | null = null
    let handle: Awaited<ReturnType<KafkaClient["consume"]>> | null = null
    const pending: RawMessage[] = []
    // Decode is async: chaining flushes keeps batches landing in arrival order even when
    // a registry fetch makes one batch slower than the next.
    let decodeChain: Promise<void> = Promise.resolve()

    const patch = (update: (window: MessageWindow) => Partial<MessageWindow>): void => {
      setCurrent((prev) =>
        // A response for a superseded request must not leak into the new window.
        sameRequest(prev.request, active)
          ? { request: prev.request, window: { ...prev.window, ...update(prev.window) } }
          : prev,
      )
    }

    const flush = (): void => {
      if (pending.length === 0) {
        return
      }
      const batch = pending.splice(0)
      decodeChain = decodeChain.then(async () => {
        const decoded = await Promise.all(batch.map((raw) => decodeMessage(raw, registry)))
        if (!cancelled) {
          patch((window) => ({ rows: [...window.rows, ...decoded] }))
        }
      })
    }

    const run = async (): Promise<void> => {
      const meta = await client.describeTopic(topic)
      if (cancelled) {
        return
      }
      patch(() => ({
        resolved: {
          partitions: meta.partitions,
          starts: range.kind === "timestamp" ? null : resolveStarts(range, meta.partitions),
        },
      }))
      handle = await client.consume(topic, { range, limit: WINDOW_CAP }, (m) => {
        pending.push(m)
      })
      if (cancelled) {
        await handle.stop()
        return
      }
      flushTimer = setInterval(flush, FLUSH_MS)
      await handle.done
      // The window is finite: once the range is exhausted the ticker has nothing left to
      // do, and leaving it armed is an idle 30Hz timer per open topic.
      clearInterval(flushTimer)
      flushTimer = null
      flush()
      await decodeChain
      if (!cancelled) {
        patch(() => ({ phase: "done" }))
      }
    }

    run().catch((err: unknown) => {
      if (!cancelled) {
        patch(() => ({
          phase: "error",
          error: err instanceof Error ? err.message : String(err),
        }))
      }
    })

    return () => {
      cancelled = true
      if (flushTimer) {
        clearInterval(flushTimer)
      }
      void handle?.stop()
    }
  }, [client, registry, topic, range, reload])

  return current.window
}
