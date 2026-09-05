// Non-Confluent payloads are parsed here (spec 005). JSON.parse folds any integer past
// 2^53 into a rounded Number, which would violate invariant 1 before a value ever reaches
// the table or a filter — a plain-JSON topic carrying customer ids would answer wrong and
// look right (nfr/006). ES2025's reviver source access lets us see the literal text and
// keep the exact value.

const INTEGER = /^-?\d+$/

interface ReviverContext {
  source?: string
}

/** JSON.parse that promotes integer literals too large for a Number to BigInt. Smaller
 *  integers stay Numbers — they are exact, and promoting them would make ordinary values
 *  compare and render differently for no gain. */
export function parseJsonLossless(text: string): unknown {
  return JSON.parse(text, function (_key: string, value: unknown, context?: ReviverContext) {
    if (typeof value !== "number" || context?.source === undefined) {
      return value
    }
    const source = context.source
    if (!INTEGER.test(source)) {
      return value
    }
    const exact = BigInt(source)
    return exact > BigInt(Number.MAX_SAFE_INTEGER) || exact < BigInt(Number.MIN_SAFE_INTEGER)
      ? exact
      : value
  })
}
