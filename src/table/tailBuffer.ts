import type { PartitionStart } from "@/kafka/range.ts"
import type { DecodedMessage, PartitionMeta } from "@/types.ts"
import { WINDOW_CAP } from "./window.ts"

// The bounded buffer behind follow mode (spec 012). Kafka topics are unbounded and
// terminals are not, so the buffer is bounded by construction: past the cap the oldest row
// is evicted and counted. Every drop is countable precisely so the header can state it —
// a silently truncated tail is a lie about what the topic contained (nfr/004).

/** The follow buffer is the window: one cap, so switching to follow cannot widen memory
 *  beyond what a static window already costs. */
export const TAIL_CAP = WINDOW_CAP

/** The arrival queue is capped at the same number. It is pointless to hold more raw
 *  messages between frames than the buffer could ever display — and holding them is the
 *  one way a broker faster than the render loop turns into unbounded memory (spec 012 P2
 *  backpressure). */
export const TAIL_QUEUE_CAP = WINDOW_CAP

export interface Appended {
  rows: DecodedMessage[]
  /** Rows evicted by this append — cumulative counting is the caller's. */
  dropped: number
}

/**
 * Merge arrivals into the buffer, evicting oldest-first at the cap.
 *
 * The buffer is newest-first like the window it seeds from (`sortWindow`), so an arrival
 * goes to the **front** and the eviction comes off the **end**. A batch is
 * reversed rather than appended: within one flush the arrivals are still in broker order,
 * and the newest of them belongs at row 0.
 */
export function appendBounded(
  rows: readonly DecodedMessage[],
  incoming: readonly DecodedMessage[],
  cap: number,
): Appended {
  if (incoming.length === 0) {
    return { rows: [...rows], dropped: 0 }
  }
  const combined = [...[...incoming].reverse(), ...rows]
  if (combined.length <= cap) {
    return { rows: combined, dropped: 0 }
  }
  const dropped = combined.length - cap
  return { rows: combined.slice(0, cap), dropped }
}

/**
 * Queue an arrival for the next frame, dropping from the front at the cap.
 *
 * Mutates in place: this runs once per message on the consumer's callback, and copying a
 * thousand-element queue per message is exactly the cost the cap exists to avoid
 * (nfr/001). Returns how many rows were dropped so the caller can total them.
 *
 * The front is dropped rather than the arrival because in a tail the newest rows are the
 * point — the dropped ones would have been evicted by {@link appendBounded} on the next
 * flush anyway.
 */
export function pushBounded<T>(queue: T[], item: T, cap: number): number {
  queue.push(item)
  if (queue.length <= cap) {
    return 0
  }
  return queue.splice(0, queue.length - cap).length
}

/**
 * Where the tail resumes: one past the highest offset already on screen per partition,
 * falling back to the partition's high watermark when the window holds nothing from it.
 *
 * Resuming from the buffer rather than from a fresh watermark lookup is what makes the
 * seam between window and tail seamless — anything produced between loading the window and
 * pressing follow is read rather than skipped. All bigint (nfr/006).
 */
export function tailStarts(
  rows: readonly DecodedMessage[],
  partitions: readonly PartitionMeta[],
): PartitionStart[] {
  const seen = new Map<number, bigint>()
  for (const row of rows) {
    const max = seen.get(row.partition)
    if (max === undefined || row.offset > max) {
      seen.set(row.partition, row.offset)
    }
  }
  return partitions.map((p) => {
    const max = seen.get(p.id)
    return { partition: p.id, offset: max === undefined ? p.high : max + 1n }
  })
}

/** Header state for the tail: what the consumer is doing right now. */
export type TailStatus = "off" | "following" | "paused" | "error"

export function tailLabel(status: TailStatus): string | null {
  switch (status) {
    case "off":
      return null
    case "following":
      return "following"
    case "paused":
      return "paused"
    case "error":
      return "tail failed"
  }
}

/** Dropped rows are announced, never silent (nfr/004): eviction and backpressure are the
 *  same statement to the reader — rows existed that this window will never show. */
export function droppedLabel(dropped: number): string | null {
  return dropped === 0 ? null : `${dropped} dropped`
}
