/* eslint-disable no-console -- CLI entry point: usage/version output and fatal errors */
import { readFileSync } from "node:fs"
import { createCliRenderer } from "@opentui/core"
import { createRoot } from "@opentui/react"
import { App } from "@/App.tsx"
import type { ClusterSession } from "@/clusterSession.ts"
import { loadConfig } from "@/config/load.ts"
import type { ClusterProfile } from "@/config/schema.ts"
import { fetchSecret } from "@/config/secret.ts"
import { createKafkaClient } from "@/kafka/client.ts"
import type { KafkaClient } from "@/kafka/types.ts"
import { createRegistry } from "@/schema/registry.ts"
import type { StatusMessage } from "@/state.ts"
import { version } from "@/version.ts"

const USAGE = `topiq — peek, filter, replay. Kafka without leaving the terminal.

Usage: topiq [cluster] [topic]

  cluster   profile name from ~/.config/topiq/config.toml
  topic     topic to open on start

Options:
  -h, --help     show this help
  -v, --version  print the version`

const args = process.argv.slice(2)
if (args.includes("--version") || args.includes("-v")) {
  console.log(version)
  process.exit(0)
}
if (args.includes("--help") || args.includes("-h")) {
  console.log(USAGE)
  process.exit(0)
}
const flags = args.filter((a) => a.startsWith("-"))
if (flags.length > 0) {
  console.error(`topiq: unknown option ${flags[0]}\n\n${USAGE}`)
  process.exit(1)
}
const [clusterArg, topicArg] = args

// The one place a transport is chosen (spec 003): below here everything sees only the
// KafkaClient seam. Constructing it opens no connection yet. password_cmd runs exactly
// once per selection — client and registry share the secret (nfr/001).
//
// A set, not one client: a cross-cluster copy opens a second connection to its destination
// (spec 016), and shutdown has to close both — tracking only "the latest" would leave the
// source socket open and hang the exit.
const openClients = new Set<KafkaClient>()

async function connectCluster(profile: ClusterProfile): Promise<ClusterSession> {
  const password = await fetchSecret(profile.passwordCmd)
  const client = createKafkaClient(profile, password)
  const registry = createRegistry({
    host: profile.registry,
    username: profile.sasl.username,
    password,
    ca: profile.caCert ? readFileSync(profile.caCert, "utf8") : undefined,
  })
  openClients.add(client)
  return { profile, client, registry }
}

interface Startup {
  profiles: ClusterProfile[]
  /** Connected *after* the first paint, not before: password_cmd shells out to a vault
   *  and takes seconds, and a terminal that stays blank that long reads as a hang
   *  (nfr/001). */
  autoConnect: ClusterProfile | null
  topic: string | null
  /** Boot-time diagnostic for the status line, e.g. an unreadable config. */
  status?: StatusMessage
}

async function startup(): Promise<Startup> {
  let profiles: ClusterProfile[]
  try {
    profiles = await loadConfig()
  } catch (err) {
    // A broken config must not stop the shell from booting (nfr/004): come up with no
    // cluster and put the reason on the status line.
    const message = err instanceof Error ? err.message : String(err)
    return { profiles: [], autoConnect: null, topic: null, status: { message, kind: "error" } }
  }
  if (!clusterArg) {
    return { profiles, autoConnect: null, topic: null }
  }
  const profile = profiles.find((p) => p.name === clusterArg)
  if (!profile) {
    const known = profiles.map((p) => p.name).join(", ") || "(none)"
    console.error(`topiq: unknown cluster "${clusterArg}" — configured: ${known}`)
    process.exit(1)
  }
  return { profiles, autoConnect: profile, topic: topicArg ?? null }
}

const { profiles, autoConnect, topic, status } = await startup()

const renderer = await createCliRenderer({ exitOnCtrlC: false })

let exiting = false
async function shutdown(code: number): Promise<void> {
  if (exiting) {
    return
  }
  exiting = true
  // Disconnect before teardown, or Bun hangs on an open socket (spec 001). Every connection
  // this session opened, and a dead one must never block quitting — hence allSettled rather
  // than a loop that stops at the first throw.
  await Promise.allSettled([...openClients].map((client) => client.disconnect()))
  renderer.destroy()
  process.exit(code)
}

// Raw mode turns Ctrl+C into a key event (handled in App), but an external kill still
// needs a clean disconnect + terminal restore.
process.on("SIGINT", () => void shutdown(0))
process.on("SIGTERM", () => void shutdown(0))

// Restore the terminal before the stack trace prints, or it lands on the wiped
// alternate screen and the shell is left mangled (spec 001 P1).
function die(err: unknown): void {
  try {
    renderer.destroy()
  } catch {
    // already torn down — printing the error still matters
  }
  console.error(err)
  process.exit(1)
}
process.on("uncaughtException", die)
process.on("unhandledRejection", die)

createRoot(renderer).render(
  <App
    profiles={profiles}
    autoConnect={autoConnect}
    initialTopic={topic}
    connect={connectCluster}
    initialStatus={status}
    onExit={() => void shutdown(0)}
  />,
)
