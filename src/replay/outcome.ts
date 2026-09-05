import type { ConfirmPrompt, WriteAction } from "@/safety/gate.ts"
import type { SchemaViolation } from "@/schema/encode.ts"
import type { RawProduce } from "./produce.ts"

// What an $EDITOR-driven produce flow can end in (specs 014, 015). One union for both, so
// the view routes edit and craft through the same four cases — a flow that grew a fifth
// silent ending would not compile.

export type ProduceOutcome =
  /** Ready for the confirm dialog: the bytes are already decided (spec 019). */
  | { kind: "confirm"; prompt: ConfirmPrompt; action: WriteAction; produce: RawProduce }
  /** Nothing produced, nothing wrong — an unchanged or emptied buffer. */
  | { kind: "aborted"; reason: string }
  /** Nothing produced, and the user needs to know why. */
  | { kind: "refused"; reason: string }
  /** The buffer does not fit the schema; every offending path is named (specs 014, 015). */
  | { kind: "invalid"; violations: readonly SchemaViolation[] }

/** Re-path violations from a sub-document onto the envelope the user edited: a `<root>`
 *  complaint about the key has to read as `key`, or it names a path the buffer has not got
 *  (spec 015). */
export function underPath(
  violations: readonly SchemaViolation[],
  prefix: string,
): SchemaViolation[] {
  return violations.map((v) => ({
    ...v,
    path: v.path === "<root>" ? prefix : `${prefix}.${v.path}`,
  }))
}
