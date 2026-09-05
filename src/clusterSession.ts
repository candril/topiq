import type { ClusterProfile } from "@/config/schema.ts"
import type { KafkaClient } from "@/kafka/types.ts"
import type { SchemaRegistry } from "@/schema/registry.ts"

// The runtime shape of "a cluster is selected": profile plus the two per-cluster
// services sharing its credentials (specs 002, 005). Types only — construction lives in
// index.tsx, the one place a transport is chosen (spec 003).

export interface ClusterSession {
  profile: ClusterProfile
  client: KafkaClient
  /** Both sides of the registry: by-id for decode (spec 005), by-subject for crafting
   *  against the latest schema (spec 015). */
  registry: SchemaRegistry
}

export type ConnectCluster = (profile: ClusterProfile) => Promise<ClusterSession>
