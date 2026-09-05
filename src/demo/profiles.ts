import type { ClusterProfile } from "@/config/schema.ts"

// The two demo profiles (spec 027). One group, two environments: that is the minimum
// that makes grouping, env switch, cross-cluster copy and the prod guardrail visible.
// Only `demo-test` writes — a demo where prod also writes would hide the safety story.
//
// The connection fields are placeholders the demo client never reads: `password_cmd`
// is `true` so that even if something did shell it out, nothing would be fetched.

export const DEMO_TEST = "demo-test"
export const DEMO_PROD = "demo-prod"

function profile(name: string, env: "test" | "prod", allowWrite: boolean): ClusterProfile {
  return {
    name,
    brokers: ["demo:0"],
    registry: "http://demo",
    sasl: { mechanism: "scram-sha-256", username: "demo" },
    passwordCmd: "true",
    group: "demo",
    env,
    allowWrite,
    demo: true,
  }
}

export const DEMO_PROFILES: ClusterProfile[] = [
  profile(DEMO_TEST, "test", true),
  profile(DEMO_PROD, "prod", false),
]

/** Prod carries more history than test — the same generator at a larger scale — so the
 *  two are told apart by their watermarks, not only by their names. */
export function demoScale(profile: ClusterProfile): number {
  return profile.name === DEMO_PROD ? 3 : 1
}
