import avro from "avsc"
import { stringify } from "@/render/json.ts"
import { parseType, typeForSchemaId } from "./avroType.ts"
import type { SchemaFetcher, SubjectFetcher } from "./registry.ts"
import { frame } from "./wire.ts"

// The mirror of decode.ts: a JS value plus a schema id back to Confluent wire bytes.
// Both sides build their avsc type through avroType.ts, so what decode reads, encode
// writes — including the BigInt long (nfr/006 invariant 1).
//
// This path is only for *edited* messages (spec 014) and crafted ones (spec 015). An
// untouched message is re-produced from its raw bytes and never comes through here —
// re-encoding drifts from the original, which is exactly what spec 013 forbids.

export interface SchemaViolation {
  /** Dotted field path, `<root>` for a top-level primitive. */
  path: string
  value: unknown
  expected: string
  /** Replaces the default "expected X, got Y" phrasing where that does not fit — an
   *  unknown field has no expected type (spec 014). */
  message?: string
}

/** One violation as a sentence. Values render through render/json, never JSON.stringify:
 *  a BigInt that broke the schema must still print its digits (nfr/006). */
export function violationLabel(violation: SchemaViolation): string {
  const what =
    violation.message ?? `expected ${violation.expected}, got ${stringify(violation.value)}`
  return `${violation.path}: ${what}`
}

/** Status-line form: the first offending path in full, then a count. The line is one row,
 *  and a truncated list that did not say it was truncated would read as "one problem". */
export function violationSummary(violations: readonly SchemaViolation[]): string {
  const first = violations[0]
  if (first === undefined) {
    return "value does not match schema"
  }
  const rest = violations.length - 1
  return rest === 0
    ? violationLabel(first)
    : `${violationLabel(first)} (+${rest} more ${rest === 1 ? "problem" : "problems"})`
}

export class SchemaValidationError extends Error {
  readonly violations: readonly SchemaViolation[]

  constructor(violations: readonly SchemaViolation[]) {
    super(`value does not match schema: ${violations.map(violationLabel).join("; ")}`)
    this.name = "SchemaValidationError"
    this.violations = violations
  }
}

/** Every way the value fails its schema, with the offending path — spec 014 wants the
 *  path shown, and `toBuffer`'s own throw names only the innermost type. */
export function validate(type: avro.Type, value: unknown): SchemaViolation[] {
  const violations: SchemaViolation[] = []
  type.isValid(value, {
    errorHook: (path: string[], val: unknown, failed: avro.Type) => {
      violations.push({
        path: path.length > 0 ? path.join(".") : "<root>",
        value: val,
        expected: failed.typeName,
      })
    },
  })
  return violations
}

export function encodeWithType(type: avro.Type, schemaId: number, value: unknown): Buffer {
  const violations = validate(type, value)
  if (violations.length > 0) {
    throw new SchemaValidationError(violations)
  }
  return frame(schemaId, type.toBuffer(value))
}

/** Encode against schema text already in hand (the registry response, or the buffer the
 *  user was shown). */
export function encodeWithSchema(schema: string, schemaId: number, value: unknown): Buffer {
  return encodeWithType(parseType(schema), schemaId, value)
}

/** Encode against the schema the message was decoded with. Editing an old message must
 *  not silently upgrade it to the subject's latest (spec 014). */
export async function encodeBySchemaId(
  registry: SchemaFetcher,
  schemaId: number,
  value: unknown,
): Promise<Buffer> {
  return encodeWithType(await typeForSchemaId(registry, schemaId), schemaId, value)
}

export interface EncodedForSubject {
  bytes: Buffer
  schemaId: number
  version: number
}

/** Encode against the subject's latest schema — a message that did not exist before is
 *  current by definition (spec 015). */
export async function encodeLatestForSubject(
  registry: SchemaFetcher & SubjectFetcher,
  subject: string,
  value: unknown,
): Promise<EncodedForSubject> {
  const latest = await registry.getLatestSchema(subject)
  if (!latest) {
    throw new Error(`registry: no schema registered for subject ${subject}`)
  }
  // Through the id, not the response text, so the type is the one the cache already holds
  // for that id and encode/decode share a single instance.
  const type = await typeForSchemaId(registry, latest.id)
  return {
    bytes: encodeWithType(type, latest.id, value),
    schemaId: latest.id,
    version: latest.version,
  }
}
