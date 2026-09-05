// Live smoke test (just smoke): the milestone-1 spike re-run through the extracted seam.
// Consumes N messages from a real topic; asserts BigInt keys (nfr/006).
//
// Cluster and topic come from the local config (spec 002), never from this file — a real
// broker host, service account and vault name are not ours to publish.
//
//   just smoke <profile> <topic> [n]
import { loadConfig } from "@/config/load.ts"
import { fetchSecret } from "@/config/secret.ts"
import { createKafkaClient } from "@/kafka/client.ts"
import { decodeMessage } from "@/schema/decode.ts"
import { createRegistry } from "@/schema/registry.ts"
import type { DecodedMessage } from "@/types.ts"

const [profileName, TOPIC, nArg] = Bun.argv.slice(2)
if (!profileName || !TOPIC) {
  console.error("usage: just smoke <profile> <topic> [n]")
  process.exit(2)
}
const N = Number(nArg ?? 10)

const profiles = await loadConfig()
const profile = profiles.find((p) => p.name === profileName)
if (!profile) {
  const known = profiles.map((p) => p.name).join(", ")
  console.error(`no profile "${profileName}" in the config — have: ${known}`)
  process.exit(2)
}

const password = await fetchSecret(profile.passwordCmd)
const client = createKafkaClient(profile, password)
const registry = createRegistry({
  host: profile.registry,
  username: profile.sasl.username,
  password,
  ca: profile.caCert ? await Bun.file(profile.caCert).text() : undefined,
})

const meta = await client.describeTopic(TOPIC)
console.log("watermarks:", meta.partitions.map((p) => `p${p.id}: ${p.low}..${p.high}`).join("  "))

const decoded: DecodedMessage[] = []
const handle = await client.consume(TOPIC, { range: { kind: "latestN", n: N }, limit: N }, (m) => {
  void decodeMessage(m, registry).then((d) => decoded.push(d))
})
await Promise.race([handle.done, new Promise((r) => setTimeout(r, 30_000))])
await handle.stop()
await client.disconnect()

for (const [i, d] of decoded.entries()) {
  const key = typeof d.decodedKey === "bigint" ? `${d.decodedKey}n` : JSON.stringify(d.decodedKey)
  const value = JSON.stringify(d.decodedValue, (_, v: unknown) =>
    typeof v === "bigint" ? `${v}n` : v,
  )
  console.log(
    `#${i + 1} p${d.partition}@${d.offset} schema=${d.valueSchemaId}`,
    `key=${key} (${typeof d.decodedKey})`,
    value?.slice(0, 120),
  )
}
const keyTypes = new Set(
  decoded.filter((d) => d.decodedKey !== null).map((d) => typeof d.decodedKey),
)
const ok = decoded.length >= N && keyTypes.size === 1 && keyTypes.has("bigint")
console.log(
  ok
    ? `\nSMOKE PASSED: ${decoded.length} messages, bigint keys`
    : `\nFAILED: ${decoded.length} msgs, keyTypes=${[...keyTypes]}`,
)
process.exit(ok ? 0 : 1)
