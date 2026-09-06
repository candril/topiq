import type { ConsumerGroupMeta, GroupOverview, PartitionOffset } from "@/types.ts"

// Group metadata + lag math (spec 017). Pure: no client, no kafkajs — the view and the
// seam are both renderers of this, and it runs under `bun test` without either.
//
// The rule the whole file exists to protect: a partition the group never committed has
// *undefined* lag, not zero (nfr/006). `null` carries that all the way to the "—" the row
// prints; nothing here ever coerces it to 0n.

/** Prefix of the ephemeral groups topiq's own reads join (spec 009). kafkajs cannot read
 *  without a group, so every window leaves one behind — our litter, not the user's
 *  consumers, so the list hides them unless asked. `identity.ts` builds ids from this
 *  constant so the filter cannot drift from the generator. */
export const EPHEMERAL_GROUP_PREFIX = "topiq-read-"

export function isEphemeralGroup(groupId: string): boolean {
  return groupId.startsWith(EPHEMERAL_GROUP_PREFIX)
}

export interface TotalLag {
  /** Σ of the partitions that do have a committed offset; null when none of them does. */
  total: bigint | null
  /** Partitions with no committed offset. Their lag is unknown, so a non-zero count makes
   *  `total` a floor rather than the answer — the row says so with a `+?`. */
  unknown: number
}

/**
 * Total lag over a group's partitions, in `bigint` throughout (invariant 1).
 *
 * Uncommitted partitions are counted, never summed as zero: a group that has committed on
 * one partition of thirty is not "up to date", and a total that quietly said so would be
 * wrong in the direction that gets acted on.
 */
export function totalLag(offsets: readonly PartitionOffset[]): TotalLag {
  let total: bigint | null = null
  let unknown = 0
  for (const o of offsets) {
    if (o.lag === null) {
      unknown++
    } else {
      total = (total ?? 0n) + o.lag
    }
  }
  return { total, unknown }
}

/** Digit grouping for a bigint count: "1,234,567". Kept here because everything that
 *  counts messages counts them as bigint. */
export function groupDigits(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",")
}

/** Per-partition lag as a cell. `—` is the whole point: it is not zero (spec 017). */
export function formatLag(lag: bigint | null): string {
  return lag === null ? "—" : groupDigits(lag)
}

/** Total lag as a cell. `+?` marks a floor: some partition's lag is unknown, so the real
 *  total is at least this. */
export function formatTotalLag(t: TotalLag): string {
  if (t.total === null) {
    return "—"
  }
  return t.unknown === 0 ? groupDigits(t.total) : `${groupDigits(t.total)}+?`
}

/**
 * Does this group consume the topic?
 *
 * Either it has committed somewhere on the topic, or a live member holds one of its
 * partitions. Membership alone does not count: a member of a multi-topic group can be
 * assigned nothing here, and listing it under "consumes this topic" would be a guess.
 */
export function consumesTopic(meta: ConsumerGroupMeta): boolean {
  return (
    meta.offsets.some((o) => o.committed !== null) ||
    meta.members.some((m) => m.partitions.length > 0)
  )
}

/** The only group state an offset seek is allowed against: a live member would keep
 *  committing over whatever we wrote, and the broker rejects the write anyway. */
export const SEEKABLE_STATE = "Empty"

/**
 * Why this group's offsets cannot be moved, or null when they can (spec 018 P1).
 *
 * One wording, two callers: the preview shows it *instead of* attempting the write, and
 * the seam re-checks with it immediately before the write, because a group can rejoin
 * between the confirm dialog opening and its keystroke landing.
 *
 * The scaling sentence is deliberate — topiq replaces the web-console step of the
 * documented dance, not the deployment step ([000](../../specs/000-vision.md) Non-Goals).
 */
export function groupSeekRefusal(
  groupId: string,
  state: string,
  memberCount: number,
): string | null {
  if (state === SEEKABLE_STATE) {
    return null
  }
  const members = memberCount === 1 ? "1 member" : `${memberCount} members`
  return `${groupId} is ${state} with ${members} — an offset seek needs it ${SEEKABLE_STATE}; scale the consumer to zero first, which stays manual`
}

export type GroupSort = "name" | "lag" | "state"

export const GROUP_SORT_CYCLE: GroupSort[] = ["name", "lag", "state"]

export interface GroupRow extends GroupOverview {
  ephemeral: boolean
  /** null while the per-group offset fetch is still in flight, or after it failed. The row
   *  then prints "…"/"?" — never a lag of zero it has not measured. */
  detail: ConsumerGroupMeta | null
  lag: TotalLag | null
}

export function toGroupRow(overview: GroupOverview, detail: ConsumerGroupMeta | null): GroupRow {
  return {
    // The detail's own state/memberCount win: they were read later than the listing's.
    ...overview,
    ...(detail === null ? {} : { state: detail.state, memberCount: detail.memberCount }),
    ephemeral: isEphemeralGroup(overview.groupId),
    detail,
    lag: detail === null ? null : totalLag(detail.offsets),
  }
}

export interface GroupVisibleOptions {
  filter: string
  /** Show topiq's own `topiq-read-*` groups. Off by default — see the prefix above. */
  showEphemeral: boolean
  /** Restrict to groups that consume the described topic (spec 017 P2). */
  onlyTopic: boolean
  sort: GroupSort
}

/** Unknown lag sorts last: a group whose lag has not been read yet is not the least
 *  lagging one, and putting it on top of a lag sort would say exactly that. */
function compareLag(a: GroupRow, b: GroupRow): number {
  const at = a.lag?.total ?? null
  const bt = b.lag?.total ?? null
  if (at === null || bt === null) {
    return at === bt ? 0 : at === null ? 1 : -1
  }
  return at === bt ? 0 : at > bt ? -1 : 1
}

function compare(sort: GroupSort, a: GroupRow, b: GroupRow): number {
  switch (sort) {
    case "name":
      return 0
    case "lag":
      return compareLag(a, b)
    case "state":
      return a.state < b.state ? -1 : a.state > b.state ? 1 : 0
  }
}

export function visibleGroupRows(rows: readonly GroupRow[], opts: GroupVisibleOptions): GroupRow[] {
  const needle = opts.filter.toLowerCase()
  const filtered = rows.filter((r) => {
    if (r.ephemeral && !opts.showEphemeral) {
      return false
    }
    // A row whose detail has not landed stays visible: "not measured yet" is not "does not
    // consume this topic", and hiding it would claim the second.
    if (opts.onlyTopic && r.detail !== null && !consumesTopic(r.detail)) {
      return false
    }
    return r.groupId.toLowerCase().includes(needle)
  })
  return filtered.sort(
    (a, b) =>
      compare(opts.sort, a, b) || (a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0),
  )
}
