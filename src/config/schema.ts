// Cluster profile shape and validation (specs 002, 023). The type stays authoritative;
// load.ts feeds raw TOML tables through parseConfig.

export interface ClusterProfile {
  name: string
  brokers: string[]
  registry: string
  sasl: { mechanism: SaslMechanism; username: string }
  /** Shell command whose stdout is the password. The only way a secret enters (nfr/003). */
  passwordCmd: string
  /** PEM path. Required for Aiven: self-signed project CA (spike finding, spec 003). */
  caCert?: string
  topicPrefix?: string
  /** Logical cluster family + environment (spec 023) */
  group?: string
  env?: string
  /** Declared prod-ness — never guessed from hostnames (spec 023). Read via isProd. */
  prod?: boolean
  allowWrite: boolean
}

/** Central prod check so `prod = true` and `env = "prod"` stay interchangeable (spec 023). */
export function isProd(profile: ClusterProfile): boolean {
  return profile.prod ?? profile.env === "prod"
}

/** Config problems carry a user-facing message (file + key), never a stack trace (nfr/004). */
export class ConfigError extends Error {}

const PROFILE_KEYS = [
  "brokers",
  "registry",
  "sasl",
  "password_cmd",
  "ca_cert",
  "topic_prefix",
  "group",
  "env",
  "prod",
  "allow_write",
] as const

const SASL_MECHANISMS = ["scram-sha-256", "scram-sha-512"] as const

export type SaslMechanism = (typeof SASL_MECHANISMS)[number]

type Table = Record<string, unknown>

function isTable(value: unknown): value is Table {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Users coming from the camelCase type write `allowWrite` — point them at the TOML spelling. */
function unknownKeyHint(key: string): string {
  const snake = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
  return (PROFILE_KEYS as readonly string[]).includes(snake) ? ` — did you mean "${snake}"?` : ""
}

function optString(value: unknown, path: string, errors: string[]): string | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== "string" || value === "") {
    errors.push(`${path}: expected a non-empty string`)
    return undefined
  }
  return value
}

function reqString(value: unknown, path: string, errors: string[]): string | undefined {
  if (value === undefined) {
    errors.push(`${path}: missing (required)`)
    return undefined
  }
  return optString(value, path, errors)
}

function optBool(value: unknown, path: string, errors: string[]): boolean | undefined {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== "boolean") {
    errors.push(`${path}: expected true or false`)
    return undefined
  }
  return value
}

function parseBrokers(value: unknown, path: string, errors: string[]): string[] | undefined {
  if (value === undefined) {
    errors.push(`${path}: missing (required) — e.g. brokers = ["host:9092"]`)
    return undefined
  }
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${path}: expected a non-empty array of "host:port" strings`)
    return undefined
  }
  let ok = true
  for (const [i, broker] of value.entries()) {
    if (typeof broker !== "string" || !/^[^\s:]+:\d+$/.test(broker)) {
      errors.push(`${path}[${i}]: ${JSON.stringify(broker)} is not "host:port"`)
      ok = false
    }
  }
  return ok ? (value as string[]) : undefined
}

function parseRegistry(value: unknown, path: string, errors: string[]): string | undefined {
  const url = reqString(value, path, errors)
  if (url === undefined) {
    return undefined
  }
  const parsed = URL.parse(url)
  if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
    errors.push(`${path}: "${url}" is not an http(s) URL`)
    return undefined
  }
  return url
}

function parseSasl(
  value: unknown,
  path: string,
  errors: string[],
): ClusterProfile["sasl"] | undefined {
  if (value === undefined) {
    errors.push(
      `${path}: missing (required) — sasl = { mechanism = "scram-sha-256", username = "…" }`,
    )
    return undefined
  }
  if (!isTable(value)) {
    errors.push(`${path}: expected an inline table with mechanism and username`)
    return undefined
  }
  for (const key of Object.keys(value)) {
    if (key !== "mechanism" && key !== "username") {
      errors.push(`${path}.${key}: unknown key`)
    }
  }
  const mechanism = reqString(value["mechanism"], `${path}.mechanism`, errors)
  const username = reqString(value["username"], `${path}.username`, errors)
  if (mechanism !== undefined && !(SASL_MECHANISMS as readonly string[]).includes(mechanism)) {
    errors.push(`${path}.mechanism: "${mechanism}" unsupported — use ${SASL_MECHANISMS.join(", ")}`)
    return undefined
  }
  if (mechanism === undefined || username === undefined) {
    return undefined
  }
  return { mechanism: mechanism as SaslMechanism, username }
}

function parseProfile(name: string, raw: unknown, errors: string[]): ClusterProfile | undefined {
  const path = `clusters.${name}`
  if (!isTable(raw)) {
    errors.push(`${path}: expected a table — [${path}]`)
    return undefined
  }
  for (const key of Object.keys(raw)) {
    if (!(PROFILE_KEYS as readonly string[]).includes(key)) {
      errors.push(`${path}.${key}: unknown key${unknownKeyHint(key)}`)
    }
  }
  const brokers = parseBrokers(raw["brokers"], `${path}.brokers`, errors)
  const registry = parseRegistry(raw["registry"], `${path}.registry`, errors)
  const sasl = parseSasl(raw["sasl"], `${path}.sasl`, errors)
  const passwordCmd = reqString(raw["password_cmd"], `${path}.password_cmd`, errors)
  const caCert = optString(raw["ca_cert"], `${path}.ca_cert`, errors)
  const topicPrefix = optString(raw["topic_prefix"], `${path}.topic_prefix`, errors)
  const group = optString(raw["group"], `${path}.group`, errors)
  const env = optString(raw["env"], `${path}.env`, errors)
  if ((raw["group"] === undefined) !== (raw["env"] === undefined)) {
    errors.push(`${path}: group and env come as a pair — set both or neither (spec 023)`)
  }
  const prod = optBool(raw["prod"], `${path}.prod`, errors)
  const allowWrite = optBool(raw["allow_write"], `${path}.allow_write`, errors) ?? false
  if (!brokers || !registry || !sasl || !passwordCmd) {
    return undefined
  }
  return {
    name,
    brokers,
    registry,
    sasl,
    passwordCmd,
    caCert,
    topicPrefix,
    group,
    env,
    prod,
    allowWrite,
  }
}

/** Validate a parsed TOML document into profiles. `file` names the source in every error. */
export function parseConfig(raw: unknown, file: string): ClusterProfile[] {
  const errors: string[] = []
  if (!isTable(raw)) {
    throw new ConfigError(`${file}: expected TOML tables at the top level`)
  }
  for (const key of Object.keys(raw)) {
    if (key !== "clusters") {
      errors.push(`${key}: unknown key — only [clusters.<name>] tables`)
    }
  }
  const clusters = raw["clusters"]
  if (clusters === undefined || !isTable(clusters) || Object.keys(clusters).length === 0) {
    errors.push(`no clusters defined — add a [clusters.<name>] table`)
    throw new ConfigError(formatErrors(file, errors))
  }
  const profiles: ClusterProfile[] = []
  for (const [name, table] of Object.entries(clusters)) {
    const profile = parseProfile(name, table, errors)
    if (profile) {
      profiles.push(profile)
    }
  }
  if (errors.length > 0) {
    throw new ConfigError(formatErrors(file, errors))
  }
  return profiles
}

function formatErrors(file: string, errors: string[]): string {
  return `${file}:\n  ${errors.join("\n  ")}`
}
