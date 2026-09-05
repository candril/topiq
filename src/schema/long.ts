import avro from "avsc"

// Invariant 1 (nfr/006): Avro long decodes to BigInt, never Number. avsc's default
// LongType silently loses precision above 2^53 — the bug this tool exists to not have.
export const longType = avro.types.LongType.__with({
  fromBuffer: (buf: Buffer) => buf.readBigInt64LE(),
  toBuffer: (n: bigint) => {
    const buf = Buffer.alloc(8)
    buf.writeBigInt64LE(n)
    return buf
  },
  fromJSON: BigInt,
  // Digits as a string, never Number(n): above 2^53 a Number rounds, which is the bug this
  // type exists to prevent. Throwing here is not an option — avsc copies a field's declared
  // default through `fromJSON(toJSON(v))`, so a throw makes every schema with a
  // `{"type":"long","default":…}` field unparseable, and the topic then fails to decode
  // entirely. UI serialisation still goes through src/render/json.ts, which writes bare
  // digits; this form only has to survive avsc's own round trip.
  toJSON: (n: bigint): string => n.toString(),
  isValid: (n: unknown) => typeof n === "bigint",
  compare: (a: bigint, b: bigint) => (a === b ? 0 : a < b ? -1 : 1),
})
