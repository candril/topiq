import type { PartitionMeta } from "@/types.ts"

// Fetch-range descriptors (spec 009). Kafka only reads forward, so "latest N" is
// watermark arithmetic — all of it bigint, no Number coercion (nfr/006).

export type FetchRange =
  | { kind: "beginning" }
  /** The high watermark: no history, everything from here on. Kafka's own LATEST — the
   *  offset-seek targets need it (spec 018), and `latestN` cannot express it (n ≥ 1). */
  | { kind: "end" }
  | { kind: "offset"; offset: bigint }
  | { kind: "latestN"; n: number }
  | { kind: "timestamp"; timestamp: Date }

export interface PartitionStart {
  partition: number
  /** null: this partition contributes nothing (e.g. nothing at/after the timestamp) */
  offset: bigint | null
}

function clamp(offset: bigint, p: PartitionMeta): bigint {
  if (offset < p.low) {
    return p.low
  }
  if (offset > p.high) {
    return p.high
  }
  return offset
}

/** Resolve a range to per-partition start offsets. Timestamp ranges are resolved by the
 *  client (broker lookup) before this — they never reach here. */
export function resolveStarts(range: FetchRange, partitions: PartitionMeta[]): PartitionStart[] {
  switch (range.kind) {
    case "beginning":
      return partitions.map((p) => ({ partition: p.id, offset: p.low }))
    case "end":
      return partitions.map((p) => ({ partition: p.id, offset: p.high }))
    case "offset":
      return partitions.map((p) => ({ partition: p.id, offset: clamp(range.offset, p) }))
    case "latestN": {
      // Partitions fill unevenly: over-fetch per partition and let the caller trim.
      const perPartition = BigInt(Math.ceil(range.n / Math.max(partitions.length, 1)))
      return partitions.map((p) => ({
        partition: p.id,
        offset: clamp(p.high - perPartition, p),
      }))
    }
    case "timestamp":
      throw new Error("timestamp ranges are resolved by the client before resolveStarts")
  }
}

export function messageCount(partitions: PartitionMeta[]): bigint {
  return partitions.reduce((sum, p) => sum + (p.high - p.low), 0n)
}
