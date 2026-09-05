/** Bounded-concurrency map, results in input order.
 *
 *  kafkajs funnels every admin request through one per-cluster "updating target topics"
 *  lock, so a wide fan-out queues rather than parallelises: 1893 concurrent watermark
 *  fetches outlive the lock timeout and the whole call dies with `KafkaJSLockTimeout`
 *  instead of returning (spec 003). A small window keeps the broker busy without building
 *  that queue. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index]!)
    }
  })
  await Promise.all(workers)
  return results
}
