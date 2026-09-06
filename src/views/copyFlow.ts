import type { Dispatch } from "react"
import type { ClusterSession, ConnectCluster } from "@/clusterSession.ts"
import type { ClusterProfile } from "@/config/schema.ts"
import { copyBlockedReason, planCopy } from "@/replay/copy.ts"
import type { AppAction, CopyState } from "@/state.ts"
import type { DecodedMessage } from "@/types.ts"
import { failStatus, routeProduceOutcome } from "./produceFlows.ts"

// The cross-cluster copy as the table drives it (spec 016): open the bar on a message,
// connect the chosen destination, plan the copy against **two** registries, then hand the
// same confirm dialog every other write uses (spec 019).
//
// The second connection is what makes this different from every other flow, and it is the
// reason this file exists rather than another branch in produceFlows.ts: it runs
// `password_cmd`, builds a second client and a second registry — a second schema cache, the
// whole point (spec 016) — and it must be kept, because paying a vault round trip per copied
// message would make the feature unusable.

export interface CopyFlowDeps {
  /** The connected cluster: where the message was read and whose registry decoded it. */
  source: ClusterSession
  connect: ConnectCluster
  /** The destination this session already holds, if any. Owned by the view so it survives
   *  re-renders; replaced only when another destination is chosen. */
  destination: ClusterSession | null
  onDestination: (session: ClusterSession | null) => void
  dispatch: Dispatch<AppAction>
  now: () => Date
}

export interface CopyFlows {
  /** Open the destination bar on this message, or say why it cannot be copied. */
  open(row: DecodedMessage, destinations: readonly ClusterProfile[]): void
  /** Accept the highlighted destination and move on to naming its topic — or refuse, before
   *  a topic has been typed into a prompt that was never going to be honoured. */
  choose(destination: ClusterProfile, row: DecodedMessage, destTopic: string): void
  /** Connect the chosen destination, plan, and open the confirm dialog. */
  run(copy: CopyState, destination: ClusterProfile, destTopic: string): void
}

const NOUN = "copy"

export function copyFlows(deps: CopyFlowDeps): CopyFlows {
  const { source, connect, destination, onDestination, dispatch, now } = deps

  /** The destination session, reusing the open one when it is the same profile. A different
   *  destination replaces it: two live second connections would be two more sockets and two
   *  more schema caches for no gain. */
  async function session(profile: ClusterProfile): Promise<ClusterSession> {
    if (destination !== null && destination.profile.name === profile.name) {
      return destination
    }
    const next = await connect(profile)
    onDestination(next)
    void destination?.client.disconnect().catch(() => {})
    return next
  }

  return {
    open(row: DecodedMessage, destinations: readonly ClusterProfile[]): void {
      if (destinations.length === 0) {
        return dispatch({
          type: "SHOW_STATUS",
          message: `${NOUN}: no other cluster is configured — add a second [clusters.<name>] profile`,
          kind: "error",
        })
      }
      if (row.decodeError) {
        // Checked before the bar opens rather than after a destination is chosen: this
        // message can never be copied, and finding that out after two prompts wastes them.
        return dispatch({
          type: "SHOW_STATUS",
          message: `${NOUN}: this message did not decode — a copy has to re-encode it against the destination registry`,
          kind: "error",
        })
      }
      dispatch({ type: "MSGS_COPY_OPEN", row })
    },

    choose(profile: ClusterProfile, row: DecodedMessage, destTopic: string): void {
      const blocked = copyBlockedReason(source.profile, profile, row)
      if (blocked !== null) {
        // The bar stays open on the list: the refusal is about this destination, and the
        // next one along may well be writable.
        return dispatch({ type: "SHOW_STATUS", message: `${NOUN}: ${blocked}`, kind: "error" })
      }
      dispatch({ type: "MSGS_COPY_TOPIC", topic: destTopic })
    },

    run(copy: CopyState, profile: ClusterProfile, destTopic: string): void {
      // Re-checked here too: `connect` runs password_cmd against a vault, and a config that
      // reloaded `allow_write` to false while the topic was being typed must not cost one.
      const blocked = copyBlockedReason(source.profile, profile, copy.row)
      if (blocked !== null) {
        dispatch({ type: "MSGS_COPY_CLOSE" })
        return dispatch({ type: "SHOW_STATUS", message: `${NOUN}: ${blocked}`, kind: "error" })
      }
      if (destTopic.trim() === "") {
        return dispatch({
          type: "SHOW_STATUS",
          message: `${NOUN}: name the topic on ${profile.name}`,
          kind: "error",
        })
      }
      dispatch({ type: "MSGS_COPY_PLANNING" })
      void session(profile)
        .then(async (target) => {
          // The producer will not create a topic (spec 029), but the failure it would give
          // for a missing one arrives after the confirm dialog — checked here, so a typo in
          // the topic prompt is a refusal naming what was typed, before anything is planned.
          const exists = await target.client.describeTopic(destTopic.trim()).then(
            () => true,
            () => false,
          )
          if (!exists) {
            return {
              kind: "refused" as const,
              reason: `no topic "${destTopic.trim()}" on ${profile.name} — topiq does not create topics`,
            }
          }
          return planCopy({
            source: { profile: source.profile, registry: source.registry },
            // A second registry object, so a second schema cache: ids are registry-local,
            // and one cache across both is the bug this spec exists to prevent (spec 016).
            destination: { profile: target.profile, registry: target.registry },
            row: copy.row,
            destTopic: destTopic.trim(),
            now,
          })
        })
        .then(
          (outcome) => {
            // MSGS_CONFIRM_OPEN closes the bar; every other outcome has to close it itself,
            // or a refusal would leave the keyboard captured by a bar with nothing to do.
            if (outcome.kind !== "confirm") {
              dispatch({ type: "MSGS_COPY_CLOSE" })
            }
            routeProduceOutcome(dispatch, NOUN, profile.name, outcome)
          },
          (failure: unknown) => {
            dispatch({ type: "MSGS_COPY_CLOSE" })
            failStatus(dispatch, NOUN, failure)
          },
        )
    },
  }
}
