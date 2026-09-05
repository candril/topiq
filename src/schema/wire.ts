// Confluent wire format: magic byte 0x00 + 4-byte schema id (BE) + Avro payload.
// Decode and encode share these so a framing change cannot land on one side only —
// an off-by-one here is invariant 2 (nfr/006) quietly broken.

export const MAGIC = 0
export const HEADER = 5

export function hasWireHeader(buf: Buffer): boolean {
  return buf.length >= HEADER && buf[0] === MAGIC
}

export function readSchemaId(buf: Buffer): number {
  return buf.readUInt32BE(1)
}

export function body(buf: Buffer): Buffer {
  return buf.subarray(HEADER)
}

export function frame(schemaId: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(HEADER)
  header[0] = MAGIC
  header.writeUInt32BE(schemaId, 1)
  return Buffer.concat([header, payload])
}
