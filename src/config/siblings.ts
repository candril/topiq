import { isProd, type ClusterProfile } from "./schema.ts"

// The sibling relation and topic-identity mapping (spec 023 P2): profiles sharing a `group`
// are environments of one logical cluster, and a topic in one env has a counterpart in the
// other modulo each profile's `topic_prefix`.
//
// Derived, never configured: a `sibling = …` key would be a second place for the same fact
// and would drift. Pure, so the copy path's destination defaulting is testable without a
// broker or a renderer.

/** Separators a `topic_prefix` is joined to the rest of the name with. The common convention is `-`
 *  (`test-orders` ↔ `orders`); the others are here because a prefix that already
 *  ends in one must not gain a second. */
const SEPARATORS = ["-", ".", "_"]

export function isSibling(profile: ClusterProfile, other: ClusterProfile): boolean {
  return (
    profile.group !== undefined &&
    profile.group === other.group &&
    profile.name !== other.name &&
    profile.env !== other.env
  )
}

/** The other environment of this profile's cluster family, or null when there is no single
 *  answer — no group, no sibling, or (a third env) more than one. */
export function siblingOf(
  profiles: readonly ClusterProfile[],
  profile: ClusterProfile,
): ClusterProfile | null {
  const siblings = profiles.filter((p) => isSibling(profile, p))
  return siblings.length === 1 ? siblings[0]! : null
}

/**
 * The same topic, named as the destination cluster names it.
 *
 * The prefix is a namespace, not necessarily a whole path segment — `topic_prefix = "test"`
 * matches `test-orders` — so the separator that joined them is carried across rather
 * than assumed: strip source prefix + separator, then re-join with the destination's. With
 * no separator to carry (a source that has no prefix), `-` is the common convention.
 *
 * Returns the topic unchanged when neither side has a prefix, which is also what a profile
 * pair outside the common convention gets: a guessed rename would be worse than an honest
 * identity, and the destination topic is editable in the bar (spec 016).
 */
export function mapTopicName(topic: string, from?: string, to?: string): string {
  let base = topic
  let separator = ""
  if (from !== undefined && topic.startsWith(from)) {
    const rest = topic.slice(from.length)
    separator = SEPARATORS.find((s) => rest.startsWith(s)) ?? ""
    base = rest.slice(separator.length)
  }
  if (to === undefined) {
    return base
  }
  const join = SEPARATORS.some((s) => to.endsWith(s)) ? "" : separator || "-"
  return `${to}${join}${base}`
}

/** The same topic on the destination profile (spec 016 / 023 P2). */
export function mappedTopic(topic: string, from: ClusterProfile, to: ClusterProfile): string {
  return mapTopicName(topic, from.topicPrefix, to.topicPrefix)
}

/**
 * Candidate destinations for a copy out of `source`, best first.
 *
 * Two orderings in one rank, and the second is a guardrail rather than a nicety
 * (spec 016 P1): the sibling env comes first because prod → test is the motivating case,
 * and **every prod profile sorts last** so a production cluster is never the row the bar
 * opens on. Reaching one takes a deliberate cursor move, and the confirm dialog then says
 * so twice over.
 */
export function copyDestinations(
  profiles: readonly ClusterProfile[],
  source: ClusterProfile,
): ClusterProfile[] {
  return profiles
    .filter((p) => p.name !== source.name)
    .map((profile) => ({
      profile,
      rank: (isProd(profile) ? 2 : 0) + (isSibling(source, profile) ? 0 : 1),
    }))
    .sort((a, b) => a.rank - b.rank || (a.profile.name < b.profile.name ? -1 : 1))
    .map((c) => c.profile)
}
