import type { DecodedMessage } from "@/types.ts"

// Both filter tiers compile to this one shape (specs 010, 011), so the table, the live
// stream and replay selection all consume a single predicate type.

export type Predicate = (msg: DecodedMessage) => boolean

export const MATCH_ALL: Predicate = () => true

export interface CompileResult {
  predicate: Predicate
  /** Set when the expression is malformed: the view shows this inline and keeps the
   *  previous result set (nfr/004). */
  error: string | null
}
