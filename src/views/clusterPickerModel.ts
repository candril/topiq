import { isProd, type ClusterProfile } from "@/config/schema.ts"

// Pure row shaping for the cluster picker (spec 023): profiles grouped by `group` with
// env rows underneath, ungrouped profiles as flat rows after. Kept out of the component
// so it runs under `bun test` without a renderer.

export type PickerRow =
  | { kind: "header"; label: string }
  | {
      kind: "profile"
      profile: ClusterProfile
      /** env for grouped profiles, profile name for ungrouped — what the row leads with. */
      label: string
      /** Position among selectable rows — the cursor counts profiles, not headers. */
      index: number
    }

export type ProfileRow = Extract<PickerRow, { kind: "profile" }>

// Envs order test → prod within a group: prod last mirrors the "does prod look like
// test?" reading direction, and keeps the dangerous row from being the default landing.
function envRank(profile: ClusterProfile): number {
  return isProd(profile) ? 1 : 0
}

function byName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

export function pickerRows(profiles: ClusterProfile[]): PickerRow[] {
  const grouped = new Map<string, ClusterProfile[]>()
  const flat: ClusterProfile[] = []
  for (const profile of profiles) {
    if (profile.group) {
      const family = grouped.get(profile.group) ?? []
      family.push(profile)
      grouped.set(profile.group, family)
    } else {
      flat.push(profile)
    }
  }
  const rows: PickerRow[] = []
  let index = 0
  for (const family of [...grouped.keys()].sort(byName)) {
    rows.push({ kind: "header", label: family })
    const members = grouped
      .get(family)!
      .sort((a, b) => envRank(a) - envRank(b) || byName(a.env ?? "", b.env ?? ""))
    for (const profile of members) {
      rows.push({ kind: "profile", profile, label: profile.env ?? profile.name, index: index++ })
    }
  }
  for (const profile of flat.sort((a, b) => byName(a.name, b.name))) {
    rows.push({ kind: "profile", profile, label: profile.name, index: index++ })
  }
  return rows
}

export function profileRows(rows: PickerRow[]): ProfileRow[] {
  return rows.filter((row) => row.kind === "profile")
}

/** The profile under the cursor, cursor clamped like every list view (spec 020). */
export function profileAt(rows: PickerRow[], cursor: number): ClusterProfile | null {
  const selectable = profileRows(rows)
  if (selectable.length === 0) {
    return null
  }
  return selectable[Math.min(cursor, selectable.length - 1)]!.profile
}
