import { useEffect, useState } from "react"
import { toGroupRow, type GroupRow } from "@/kafka/groups.ts"
import type { KafkaClient } from "@/kafka/types.ts"

// Loading the group list (spec 017). Two phases on purpose: the listing is one round-trip
// and paints immediately, while lag costs a committed-offset fetch *per group* and only
// fills in after. A single combined await would leave the view blank for as long as the
// slowest group takes, and lag is the column people came for — it has to arrive visibly,
// not silently.

export type GroupsPhase = "listing" | "lag" | "ready" | "error"

export interface GroupsData {
  /** null until the listing lands. */
  rows: GroupRow[] | null
  phase: GroupsPhase
  error: string | null
  /** Groups whose detail fetch failed. Their rows stay, with unknown lag — dropping them
   *  would under-report which groups exist. */
  undescribed: number
}

// Enough to hide the round-trip latency of a few dozen groups without opening a socket
// storm against a shared broker.
const DESCRIBE_CONCURRENCY = 8

const EMPTY: GroupsData = { rows: null, phase: "listing", error: null, undescribed: 0 }

interface Request {
  client: KafkaClient
  topic: string
  reload: number
}

function sameRequest(a: Request, b: Request): boolean {
  return a.client === b.client && a.topic === b.topic && a.reload === b.reload
}

export function useGroups(client: KafkaClient, topic: string, reload: number): GroupsData {
  const request: Request = { client, topic, reload }
  // Reset during render, not in the effect: another topic's lag must never paint against
  // the new request, and setState inside an effect cascades a second render for nothing.
  const [current, setCurrent] = useState<{ request: Request; data: GroupsData }>({
    request,
    data: EMPTY,
  })
  if (!sameRequest(current.request, request)) {
    setCurrent({ request, data: EMPTY })
  }

  useEffect(() => {
    // Rebuilt from the dep values so the effect depends on exactly what it reads.
    const active: Request = { client, topic, reload }
    let cancelled = false
    const put = (data: GroupsData): void => {
      // A response for a superseded request must not leak into the new list.
      setCurrent((prev) =>
        sameRequest(prev.request, active) ? { request: prev.request, data } : prev,
      )
    }

    const run = async (): Promise<void> => {
      const overviews = await client.listGroups()
      if (cancelled) {
        return
      }
      put({
        rows: overviews.map((o) => toGroupRow(o, null)),
        phase: "lag",
        error: null,
        undescribed: 0,
      })

      const details = await mapConcurrent(overviews, DESCRIBE_CONCURRENCY, async (o) => {
        try {
          return await client.describeGroup(o.groupId, topic)
        } catch {
          return null
        }
      })
      if (cancelled) {
        return
      }
      put({
        rows: overviews.map((o, i) => toGroupRow(o, details[i] ?? null)),
        phase: "ready",
        error: null,
        undescribed: details.filter((d) => d === null).length,
      })
    }

    run().catch((err: unknown) => {
      if (!cancelled) {
        put({
          rows: null,
          phase: "error",
          error: err instanceof Error ? err.message : String(err),
          undescribed: 0,
        })
      }
    })

    return () => {
      cancelled = true
    }
  }, [client, topic, reload])

  return current.data
}

/** `Promise.all` with a ceiling on how many run at once. Results keep input order. */
async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await run(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
