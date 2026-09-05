import type { Dispatch } from "react"
import type { ClusterSession } from "@/clusterSession.ts"
import type { ClusterProfile } from "@/config/schema.ts"
import type { Suspendable } from "@/editor/view.ts"
import type { KafkaClient } from "@/kafka/types.ts"
import { craftMessage } from "@/replay/craft.ts"
import { editAndReplay } from "@/replay/edit.ts"
import type { ProduceOutcome } from "@/replay/outcome.ts"
import {
  commitProduce,
  produceNoun,
  producedLabel,
  producedVerb,
  replayAction,
  replayProduce,
} from "@/replay/produce.ts"
import { evaluateWrite } from "@/safety/gate.ts"
import { violationSummary } from "@/schema/encode.ts"
import type { SchemaRegistry } from "@/schema/registry.ts"
import type { AppAction } from "@/state.ts"
import type { PendingWrite } from "@/state/types.ts"
import type { DecodedMessage } from "@/types.ts"

// The $EDITOR-driven write paths as the table sees them (specs 014, 015), plus the one
// place a confirmed write is sent (specs 013–016). Each flow decides the bytes, then hands
// the same confirm dialog every other write uses (spec 019); nothing is produced until that
// dialog is answered.
//
// Kept out of MessageTable.tsx because none of it is rendering: it is a round trip through
// an external process, a gate and a reducer, and it is the part that writes to Kafka.

export interface ProduceFlowDeps {
  renderer: Suspendable
  client: KafkaClient
  registry: SchemaRegistry
  profile: ClusterProfile
  topic: string
  /** The second cluster a cross-cluster copy connected to, when one is open (spec 016).
   *  A confirmed write is sent through whichever of the two the dialog named. */
  destination: ClusterSession | null
  dispatch: Dispatch<AppAction>
  now: () => Date
}

export interface ProduceFlows {
  /** Send a confirmed write. The gate re-checks at the moment of the keystroke. */
  runPending(pending: PendingWrite): void
  /** Spec 013: re-produce this message's raw bytes, unchanged. */
  startReplay(row: DecodedMessage): void
  /** Spec 014: edit this message's value, then replay it re-encoded. */
  startEdit(row: DecodedMessage): void
  /** Spec 015: a new message from the subject's latest schema. */
  startCraft(): void
}

/** Status-line failure, in one wording for every write path. */
export function failStatus(dispatch: Dispatch<AppAction>, noun: string, failure: unknown): void {
  dispatch({
    type: "SHOW_STATUS",
    message: `${noun} failed — ${failure instanceof Error ? failure.message : String(failure)}`,
    kind: "error",
  })
}

/**
 * Turn a flow's outcome into either the confirm dialog or a status line. Shared by every
 * produce path (specs 014, 015, 016) so a fifth silent ending cannot be added to one of
 * them: the union has four cases and this is the only place they are routed.
 *
 * `cluster` is the profile the bytes are aimed at — for a copy that is the destination, not
 * the connected cluster (spec 016).
 */
export function routeProduceOutcome(
  dispatch: Dispatch<AppAction>,
  noun: string,
  cluster: string,
  outcome: ProduceOutcome,
): void {
  switch (outcome.kind) {
    case "confirm":
      return dispatch({
        type: "MSGS_CONFIRM_OPEN",
        pending: {
          prompt: outcome.prompt,
          action: outcome.action,
          produce: outcome.produce,
          cluster,
        },
      })
    case "aborted":
      return dispatch({ type: "SHOW_STATUS", message: `${noun}: ${outcome.reason}` })
    case "refused":
      return dispatch({
        type: "SHOW_STATUS",
        message: `${noun}: ${outcome.reason}`,
        kind: "error",
      })
    case "invalid":
      // The offending path, not just "invalid": spec 014 P1 exists because a rejected
      // buffer you cannot locate is a buffer you retype from scratch.
      return dispatch({
        type: "SHOW_STATUS",
        message: `${noun} rejected, nothing produced — ${violationSummary(outcome.violations)}`,
        kind: "error",
      })
  }
}

/** The connection a confirmed write goes through, or null when this session does not hold
 *  it. Resolved by the profile name the dialog was built with: a copy's bytes are encoded
 *  for the destination registry and are meaningless anywhere else, so producing them to
 *  whichever client happens to be at hand would be the worst possible failure (spec 016). */
export function writeTarget(
  pending: PendingWrite,
  source: { client: KafkaClient; profile: ClusterProfile },
  destination: ClusterSession | null,
): { client: KafkaClient; profile: ClusterProfile } | null {
  if (pending.cluster === source.profile.name) {
    return source
  }
  if (destination !== null && destination.profile.name === pending.cluster) {
    return { client: destination.client, profile: destination.profile }
  }
  return null
}

export function produceFlows(deps: ProduceFlowDeps): ProduceFlows {
  const { renderer, client, registry, profile, topic, destination, dispatch, now } = deps

  return {
    runPending(pending: PendingWrite): void {
      const noun = produceNoun(pending.action.kind)
      const target = writeTarget(pending, { client, profile }, destination)
      if (target === null) {
        return dispatch({
          type: "SHOW_STATUS",
          message: `${noun}: not connected to ${pending.cluster} — nothing was sent`,
          kind: "error",
        })
      }
      // The profile thunk reads the value this factory was built with, and the table rebuilds
      // it every render: the gate's second check answers with the config as it stands now,
      // not as the dialog was built from (spec 019).
      void commitProduce(target.client, () => target.profile, pending.action, pending.produce).then(
        (acks) =>
          dispatch({
            type: "SHOW_STATUS",
            message: producedLabel(
              pending.produce.topic,
              acks,
              producedVerb(pending.action.kind),
              // Named only when it is not the connected cluster: a copy's whole point is
              // that it landed somewhere else (spec 016).
              pending.cluster === profile.name ? undefined : pending.cluster,
            ),
            kind: "success",
          }),
        (failure: unknown) => failStatus(dispatch, noun, failure),
      )
    },

    startReplay(row: DecodedMessage): void {
      const action = replayAction(row)
      const gate = evaluateWrite(profile, action, now())
      if (!gate.allowed) {
        return dispatch({ type: "SHOW_STATUS", message: `replay: ${gate.reason}`, kind: "error" })
      }
      dispatch({
        type: "MSGS_CONFIRM_OPEN",
        // The bytes are chosen here, from the raw message, before anything is confirmed —
        // and aimed at the cluster they came from, the only one where they mean anything.
        pending: {
          prompt: gate.prompt,
          action,
          produce: replayProduce(row),
          cluster: profile.name,
        },
      })
    },

    startEdit(row: DecodedMessage): void {
      void editAndReplay({ renderer, registry, profile, row, now }).then(
        (outcome) => routeProduceOutcome(dispatch, "edit", profile.name, outcome),
        (failure: unknown) => failStatus(dispatch, "edit", failure),
      )
    },

    startCraft(): void {
      void craftMessage({ renderer, registry, profile, topic, now }).then(
        (outcome) => routeProduceOutcome(dispatch, "craft", profile.name, outcome),
        (failure: unknown) => failStatus(dispatch, "craft", failure),
      )
    },
  }
}
