import { isProd, type ClusterProfile } from "@/config/schema.ts"
import type { NormalizedKey } from "@/keys.ts"
import { relativeAge } from "@/time.ts"

// The one gate every mutating path goes through (spec 019): produce (013, 014, 015, 016)
// and offset seek (018). A write path that checks `allowWrite` itself, or builds its own
// confirmation text, is a review failure — there would then be two definitions of "safe".
//
// Pure apart from the clock and the profile thunk commitWrite is handed, so the whole
// decision is testable without a renderer or a broker.

export type WriteKind = "replay" | "edit-replay" | "craft" | "copy" | "seek"

/** What a caller is about to do. `count` is messages for the produce kinds, partitions
 *  for a seek. `oldest` is the timestamp of the *oldest* message in the batch — the one
 *  whose staleness decides the warning. */
export type WriteAction =
  | { kind: "replay"; topic: string; count: number; oldest: Date }
  | { kind: "edit-replay"; topic: string; count: number; oldest: Date }
  | {
      kind: "craft"
      topic: string
      count: number
      /** Subject, version and id the payload was encoded against (spec 015). Crafting uses
       *  the subject's *latest*, so which version that turned out to be is part of the
       *  decision — not something the user has to trust. */
      schema: string
    }
  | {
      kind: "copy"
      /** The topic on the **destination** — prefix-mapped, so rarely the source's name. */
      topic: string
      count: number
      oldest: Date
      from: ClusterProfile
      fromTopic: string
      /** Per-field `source subject vN (id X) → destination subject vM (id Y)`, rendered by
       *  the copy plan (spec 016). Data, not prose, for the same reason a seek's `moves`
       *  are: the dialog cannot then name a translation the write does not perform. */
      schemas: readonly string[]
    }
  | {
      kind: "seek"
      group: string
      topic: string
      count: number
      to: string
      /** Per-partition `before → after`, already rendered by the seek model (spec 018).
       *  Data, not prose: this file still decides how the dialog is framed, but the offsets
       *  themselves come from the plan the write will execute, so the dialog cannot show a
       *  move the write does not make. */
      moves: readonly string[]
    }

export interface ConfirmLine {
  label: string
  value: string
  tone: "normal" | "warn"
}

export interface ConfirmPrompt {
  kind: WriteKind
  /** Imperative headline. Its first letter is the confirm key, so the two cannot drift. */
  title: string
  lines: ConfirmLine[]
  /** Consequences, in the warning colour. Never phrased as reversible — Kafka has no undo
   *  and the UI must not imply one (spec 019, Out of Scope). */
  warnings: string[]
  /** Uppercase letter that commits: always shift+<letter>, never enter and never `y`. */
  confirmKey: string
  hint: string
  /** Target cluster is declared prod (spec 023) — never inferred from a hostname. */
  prod: boolean
  /**
   * Text the operator must retype before the confirm key does anything, or null when a
   * keystroke is enough. Set to the destination cluster's name for a production target:
   * spec 016 P1 wants a prod destination *refused* unless it is the explicit target, and
   * typing its name is what "explicit" means — ordering it last in a picker is not a
   * refusal, it is a hope. Also delivers spec 019's P2 typed confirmation.
   */
  typeToConfirm: string | null
}

export type WriteGate =
  | { allowed: true; prompt: ConfirmPrompt }
  | { allowed: false; reason: string }

/** Thrown when the moment-of-write recheck refuses. Carries the same reason the dialog
 *  would have shown, so the status line reads identically either way. */
export class WriteBlockedError extends Error {}

// Below an hour a replayed message is plausibly still current. Past it, re-producing a
// snapshot-style record re-applies state that has since moved on — the realistic way this
// tool causes damage (spec 013, Technical Notes).
const STALE_AFTER_MS = 60 * 60 * 1000

const NO_CLUSTER = "no cluster is connected"

/**
 * Why writes are unavailable, or null when they are available. Views call this at render
 * time so a write command is drawn **disabled with its reason** rather than being absent
 * (spec 019 P1) — an absent command reads as "topiq can't do this", which is wrong.
 */
export function writeBlockedReason(profile: ClusterProfile | null): string | null {
  if (profile === null) {
    return NO_CLUSTER
  }
  if (!profile.allowWrite) {
    return `writes are disabled on ${profile.name} — allow_write is false in the config`
  }
  return null
}

/**
 * Decide whether `action` may proceed against `profile`, and with what confirmation.
 *
 * For a cross-cluster copy this is the **destination** profile: the destination is what
 * gets written, so the destination's `allow_write` is what gates (spec 016).
 */
export function evaluateWrite(
  profile: ClusterProfile | null,
  action: WriteAction,
  now: Date,
): WriteGate {
  if (profile === null) {
    return { allowed: false, reason: NO_CLUSTER }
  }
  const reason = refusal(profile, action)
  if (reason !== null) {
    return { allowed: false, reason }
  }
  return { allowed: true, prompt: buildPrompt(profile, action, now) }
}

/**
 * Run a write behind a fresh gate check. `currentProfile` is a thunk, not a value, because
 * the point of the second check is to catch a config reload between the dialog opening and
 * the keystroke landing — a captured profile would re-answer with the stale config
 * (spec 019, Technical Notes).
 */
export async function commitWrite<T>(
  currentProfile: () => ClusterProfile | null,
  action: WriteAction,
  write: () => Promise<T>,
): Promise<T> {
  const profile = currentProfile()
  const reason = profile === null ? NO_CLUSTER : refusal(profile, action)
  if (reason !== null) {
    throw new WriteBlockedError(reason)
  }
  return await write()
}

/**
 * Map a keypress onto the dialog's answer. Confirmation is shift+<letter>, deliberate by
 * construction: enter and a bare `y` are not answers here, so the reflex that dismisses
 * every other prompt in the app does nothing to this one (spec 019 P1). Any other key is
 * ignored rather than treated as cancel — a stray keystroke should not close a dialog the
 * user is still reading.
 */
/** Does the typed text satisfy the prompt? Trimmed but case-sensitive: a cluster name is
 *  an identifier, and accepting a near-miss would defeat the point of retyping it. */
export function typedConfirmSatisfied(prompt: ConfirmPrompt, typed: string): boolean {
  return prompt.typeToConfirm === null || typed.trim() === prompt.typeToConfirm
}

export function confirmResponse(
  prompt: ConfirmPrompt,
  key: NormalizedKey,
): "confirm" | "cancel" | null {
  if (key.ctrl || key.meta) {
    return null
  }
  if (key.name === "escape") {
    return "cancel"
  }
  if (key.shift && key.name === prompt.confirmKey.toLowerCase()) {
    return "confirm"
  }
  return null
}

function refusal(profile: ClusterProfile, action: WriteAction): string | null {
  const blocked = writeBlockedReason(profile)
  if (blocked !== null) {
    return blocked
  }
  if (action.count <= 0) {
    return `nothing to ${verb(action).toLowerCase()} — no ${unit(action, 2)} selected`
  }
  return null
}

function verb(action: WriteAction): string {
  switch (action.kind) {
    case "replay":
    case "edit-replay":
      return "Replay"
    case "craft":
      return "Produce"
    case "copy":
      return "Copy"
    case "seek":
      return "Seek"
  }
}

function unit(action: WriteAction, count: number): string {
  const singular = action.kind === "seek" ? "partition" : "message"
  return count === 1 ? singular : `${singular}s`
}

function countLabel(action: WriteAction): string {
  return `${action.count} ${unit(action, action.count)}`
}

function title(action: WriteAction): string {
  switch (action.kind) {
    case "replay":
      return `Replay ${countLabel(action)}`
    case "edit-replay":
      return `Replay ${action.count} edited ${unit(action, action.count)}`
    case "craft":
      return `Produce ${action.count} crafted ${unit(action, action.count)}`
    case "copy":
      // "re-encoded" is in the headline, not only in the warnings: the word "copy" is the
      // one this action must not be read as on its own (spec 016). The verb still starts
      // with C, which is what the confirm key is derived from (spec 019).
      return `Copy ${countLabel(action)} across clusters — re-encoded, not byte-exact`
    case "seek":
      return `Seek ${action.group} to ${action.to}`
  }
}

function envLabel(profile: ClusterProfile): string {
  return profile.env ?? (isProd(profile) ? "prod" : "not declared")
}

function buildPrompt(profile: ClusterProfile, action: WriteAction, now: Date): ConfirmPrompt {
  const prod = isProd(profile)
  const head = title(action)
  // Derived, never a second table to keep in sync with the titles.
  const confirmKey = head.charAt(0).toUpperCase()
  return {
    kind: action.kind,
    title: head,
    lines: promptLines(profile, action, now, prod),
    warnings: promptWarnings(profile, action, now, prod),
    confirmKey,
    hint: prod
      ? `type ${profile.name}, then shift+${confirmKey} · esc to cancel`
      : `shift+${confirmKey} to ${verb(action).toLowerCase()} · esc to cancel`,
    prod,
    // Every prod target, not only a copy's: the reversed prod/test copy is the motivating
    // accident (spec 016), but nothing about a prod replay or offset seek makes it safer.
    typeToConfirm: prod ? profile.name : null,
  }
}

function promptLines(
  profile: ClusterProfile,
  action: WriteAction,
  now: Date,
  prod: boolean,
): ConfirmLine[] {
  const lines: ConfirmLine[] = [
    { label: "cluster", value: profile.name, tone: prod ? "warn" : "normal" },
    { label: "env", value: envLabel(profile), tone: prod ? "warn" : "normal" },
  ]
  if (action.kind === "seek") {
    lines.push({ label: "group", value: action.group, tone: "normal" })
  }
  if (action.kind === "copy") {
    // from/to rather than one "topic" line: both ends are named, and which cluster each
    // topic lives on is the thing a reversed copy gets wrong (spec 016).
    lines.push({
      label: "from",
      value: `${action.from.name} (${envLabel(action.from)}) · ${action.fromTopic}`,
      tone: isProd(action.from) ? "warn" : "normal",
    })
    lines.push({ label: "to", value: `${profile.name} · ${action.topic}`, tone: "normal" })
    // Which schema each field leaves as and arrives as. The ids differ between the two
    // registries even when the schema text is identical, and that difference is the whole
    // reason this is not a copy — so it is in the dialog, not in a footnote (spec 016).
    action.schemas.forEach((schema, i) =>
      lines.push({ label: i === 0 ? "schemas" : "", value: schema, tone: "normal" }),
    )
  } else {
    lines.push({ label: "topic", value: action.topic, tone: "normal" })
  }
  if (action.kind === "craft") {
    lines.push({ label: "schema", value: action.schema, tone: "normal" })
  }
  if (action.kind === "seek") {
    lines.push({ label: "to", value: action.to, tone: "normal" })
  }
  lines.push({
    label: action.kind === "seek" ? "partitions" : "messages",
    value: countLabel(action),
    tone: "normal",
  })
  if (action.kind === "seek") {
    // The offsets are the whole decision, so they are in the dialog rather than a line
    // above it: "seek to beginning" tells you nothing about how far back that is.
    action.moves.forEach((move, i) =>
      lines.push({ label: i === 0 ? "offsets" : "", value: move, tone: "normal" }),
    )
  }
  if ("oldest" in action) {
    const age = relativeAge(action.oldest, now)
    lines.push({ label: "age", value: age, tone: isStale(action.oldest, now) ? "warn" : "normal" })
  }
  return lines
}

function promptWarnings(
  profile: ClusterProfile,
  action: WriteAction,
  now: Date,
  prod: boolean,
): string[] {
  const warnings: string[] = []
  if (prod) {
    warnings.push(`${profile.name} is declared prod`)
  }
  if ("oldest" in action && isStale(action.oldest, now)) {
    warnings.push(
      `this snapshot is ${relativeAge(action.oldest, now)} — re-producing it re-applies state that has since moved on`,
    )
  }
  switch (action.kind) {
    case "replay":
      // Spec 013: the bytes are identical, the coordinates are not. Saying "replay" without
      // this invites the reading that the original message is restored in place.
      warnings.push("the replay gets a new offset and timestamp; the original stays where it is")
      break
    case "edit-replay":
    case "craft":
      warnings.push("the payload is encoded fresh, so its bytes differ from any original")
      break
    case "copy":
      // Never the word "copy" on its own (spec 016, nfr/006 invariant 3): what lands on the
      // destination is a re-encoded message, and a user who reads "copied" and assumes the
      // bytes match has been misled by this dialog.
      warnings.push(
        `this is not a byte copy: schema ids are registry-local, so the payload is decoded against ${action.from.name}'s registry and re-encoded against ${profile.name}'s — the bytes on ${action.topic} will differ from the original`,
      )
      if (prod && !isProd(action.from)) {
        // The reversed direction. prod → test is the motivating case; test → prod is how
        // fabricated data reaches customers, so it is named rather than merely coloured.
        warnings.push(
          `this copies ${envLabel(action.from)} data into prod — the reverse of the usual direction`,
        )
      }
      break
    case "seek":
      warnings.push("the group's current offsets are not recorded anywhere — note them first")
      // Spec 018, Out of Scope: topiq replaces the console step of the scale-down dance,
      // not the deployment step. Saying so here is the difference between "the seek is
      // done" and "the consumer is back up".
      warnings.push("scaling the consumer back up stays manual — this moves offsets, nothing else")
      break
  }
  if (action.kind !== "seek") {
    warnings.push("Kafka has no undo: a produced message cannot be unproduced")
  }
  return warnings
}

function isStale(oldest: Date, now: Date): boolean {
  return now.getTime() - oldest.getTime() >= STALE_AFTER_MS
}
