import type { FetchRange } from "@/kafka/range.ts"
import { WINDOW_CAP } from "./window.ts"

// The pure half of scan mode (spec 030): which range a scan reads, where it stops, and
// what the header says about it. A scan streams a whole range through the filter and keeps
// only the hits, so the cap here bounds matches, not messages read.

/** Hits stop at the window cap. Nothing is evicted: the first hits are what a scan
 *  promised, so past the cap the consumer stops and the header says so. */
export const SCAN_CAP = WINDOW_CAP

/** Raw messages allowed to wait for a flush before the consumer is asked to wait too.
 *  The same number as the display cap for the same reason as the tail's queue: holding
 *  more between frames than one flush can decode is the one way a fast broker turns into
 *  unbounded memory. Unlike the tail, nothing past this is dropped — the fetch waits. */
export const SCAN_QUEUE_CAP = WINDOW_CAP

/** A scan of "the latest 50" is the window it replaces, so latest-N scans the whole topic.
 *  Every other range means what it says: `t` then a scan is "everything since". */
export function scanRange(range: FetchRange): FetchRange {
  return range.kind === "latestN" ? { kind: "beginning" } : range
}

export type ScanStatus = "scanning" | "end" | "stopped" | "capped" | "error"

const GROUPED = new Intl.NumberFormat("en-US")

/** Millions of messages are unreadable without grouping; the rest of the header counts
 *  windows of at most 10k and gets away with bare digits. */
export function formatCount(n: number | bigint): string {
  return GROUPED.format(n)
}

/** "1,234,567 / ≈4,800,000" while the plan is known, else just what has been read. The
 *  plan is a watermark snapshot, hence ≈: a topic being produced to scans slightly past it. */
export function scanProgressLabel(scanned: number, planned: bigint | null): string {
  return planned === null
    ? `${formatCount(scanned)} scanned`
    : `${formatCount(scanned)} / ≈${formatCount(planned)}`
}

export function scanStatusLabel(status: ScanStatus): string {
  switch (status) {
    case "scanning":
      return "scanning"
    case "end":
      return "end"
    case "stopped":
      return "stopped"
    case "capped":
      return `capped at ${formatCount(SCAN_CAP)} hits`
    case "error":
      return "scan failed"
  }
}

export function rateLabel(rate: number | null): string | null {
  return rate === null ? null : `${formatCount(Math.round(rate))} msg/s`
}

export interface RateSample {
  /** Milliseconds, any monotonic clock. */
  at: number
  count: number
}

export interface RateReading {
  /** Messages per second over the last window, or the previous reading while the window
   *  is still open. */
  rate: number | null
  /** The sample the next reading measures from. */
  sample: RateSample
}

/**
 * Throughput over a sliding one-second window (spec 030 P2). Read at every flush; only a
 * full window updates the number, so a 30Hz caller sees a figure that changes once a
 * second rather than one that jitters with batch sizes.
 */
export function measureRate(
  previous: RateSample,
  current: RateSample,
  lastRate: number | null,
  windowMs = 1000,
): RateReading {
  const elapsed = current.at - previous.at
  if (elapsed < windowMs) {
    return { rate: lastRate, sample: previous }
  }
  return { rate: ((current.count - previous.count) * 1000) / elapsed, sample: current }
}
