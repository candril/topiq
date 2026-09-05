/** `kafkajs-snappy` ships no types. It exports the shape kafkajs's codec registry expects:
 *  a factory the library calls per batch (spec 003). */
declare module "kafkajs-snappy" {
  const snappyCodec: () => {
    compress(encoder: { buffer: Buffer }): Promise<Buffer>
    decompress(buffer: Buffer): Promise<Buffer>
  }
  export default snappyCodec
}
