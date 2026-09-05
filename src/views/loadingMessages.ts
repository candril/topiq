/** Flavour text for the full-screen loader (spec 025).
 *
 *  Split by context so the line never claims to be doing something it isn't: the connect
 *  pool talks about credentials, TLS and brokers, the topic pool about metadata and
 *  watermarks. Rotated every few seconds so a long wait reads as alive, not looped. */

const CONNECT_MESSAGES = [
  // password_cmd / key vault
  "Asking the key vault nicely for a password…",
  "Shelling out to Azure and hoping for the best…",
  "Checking whether that az login has expired…",
  "Negotiating with the credential daemon…",
  "Reading a secret we promise not to write down…",
  "Waiting for the vault to finish its coffee…",
  "Convincing the service principal that it still exists…",

  // TLS / Aiven
  "Explaining the self-signed project CA to Node…",
  "Presenting a certificate chain nobody trusts by default…",
  "Talking TLS to a broker in another timezone…",
  "Verifying that the CA has not quietly expired…",

  // SASL / brokers
  "Salting, challenging, responding…",
  "Proving we know a password without saying it…",
  "Knocking on port 24748…",
  "Asking the bootstrap broker who else is out there…",
  "Waiting for the controller to admit it is the controller…",
  "Trying to remember whether the VPN is on…",
  "Discovering brokers, one gossip at a time…",

  // Registry
  "Introducing ourselves to the schema registry…",
  "Basic-authing into a registry that shares the broker's password…",

  // Terminal humour
  "Pretending this is faster than kafkacat…",
  "Rehearsing an excuse in case this times out…",
  "Considering whether the cluster is up (it usually is)…",
]

const TOPIC_MESSAGES = [
  // Metadata
  "Asking every broker what it is leading…",
  "Collecting partition leaders from five machines at once…",
  "Counting partitions on our fingers…",
  "Reading metadata that was true a moment ago…",
  "Sorting topics nobody has consumed since 2019…",
  "Discovering a topic named test-test-final-v2…",

  // Watermarks
  "Fetching watermarks, one topic at a time…",
  "Subtracting low from high about two thousand times…",
  "Approximating message counts (compaction says hello)…",
  "Asking partitions where they begin and end…",
  "Adding up offsets that retention already ate…",

  // Observations
  "Noticing a topic with 64 partitions and 3 messages…",
  "Finding a v1 topic that outlived its v2…",
  "Wondering who owns dg-…-internal…",
  "Judging a topic name with four version suffixes…",
  "Spotting a schema subject with no topic behind it…",

  // Waiting
  "This cluster has a lot of topics. It shows…",
  "Still going — big clusters take a moment…",
  "Filtering the ones your prefix will hide anyway…",
]

function pick(pool: readonly string[]): string {
  return pool[Math.floor(Math.random() * pool.length)]!
}

/** Shown while `password_cmd` runs and the client connects. */
export function randomConnectMessage(): string {
  return pick(CONNECT_MESSAGES)
}

/** Shown while `listTopics` resolves — no credential or TLS references. */
export function randomTopicMessage(): string {
  return pick(TOPIC_MESSAGES)
}
