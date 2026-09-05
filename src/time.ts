// Time rendering shared by the message document and the write gate. It lives here rather
// than in views/ because src/safety/ needs it: a safety module that imports a view cannot
// be used outside the UI, and the dependency points the wrong way.

/** Coarse two-unit age, because "2h 14m" answers "is this snapshot stale?" while
 *  "8054321ms" does not. Replay's confirm dialog reuses this (spec 019). */
export function relativeAge(timestamp: Date, now: Date): string {
  const ms = now.getTime() - timestamp.getTime()
  if (ms < 0) {
    // Broker clocks can run ahead of ours; lying "0s ago" would hide that.
    return "in the future"
  }
  const s = Math.floor(ms / 1000)
  if (s < 60) {
    return `${s}s ago`
  }
  const m = Math.floor(s / 60)
  if (m < 60) {
    return `${m}m ${s % 60}s ago`
  }
  const h = Math.floor(m / 60)
  if (h < 24) {
    return `${h}h ${m % 60}m ago`
  }
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h ago`
}
