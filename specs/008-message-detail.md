# Message `$EDITOR` View

**Status**: Done — `Enter` opens the message in `$EDITOR`; there is no detail pane

## Description

`Enter` on a table row opens the whole message in `$EDITOR`, read-only: metadata as
comments (topic, partition, offset, timestamp with relative age, schema ids, sizes), then
one lossless JSON body — key, value, headers. The editor *is* the detail view; an
in-app pane would be a worse JSON viewer than the user's own editor, so none exists.

History: this spec first described an in-app detail pane with per-node collapse, then a
tree-sitter code preview + `e` for the editor, then the pane was dropped entirely — each
step recorded in jj history. The editor document is the surviving artifact.

## Capabilities

### P1 — Must Have (built)

- `Enter` on a row: renderer suspends, `$EDITOR` opens the document, renderer resumes on
  exit (monq's pattern, `src/editor/view.ts`). Errors land on the status line.
- Metadata comments include the **relative age** prominently — replaying an old snapshot
  re-applies stale state ([019](./019-write-safety.md) reuses `relativeAge`).
- The body is lossless: BigInts as full digits ([nfr/006](./nfr/006-data-fidelity.md)),
  tombstone as `"value": null`, headers UTF-8-or-hex.
- An undecodable message opens with `decodeError` plus offset/hex/ascii dumps of the raw
  key and value bytes — never a half-decoded body.
- The temp file is `0600` and unlinked when the editor exits
  ([nfr/003](./nfr/003-security-and-credentials.md)).

### P2 — Should Have

- Copy helpers (whole value, key) without entering the editor.
- Diff against the previously viewed message.

## Out of Scope

- Editing and re-producing — [014](./014-edit-and-replay.md), which reuses
  `src/editor/view.ts` but goes through the write gate ([019](./019-write-safety.md)).
- Any in-app JSON tree/preview pane. Deliberately deleted; the table's inferred columns
  ([007](./007-message-table.md)) are the at-a-glance view, the editor is the full view.

## Technical Notes

- `src/views/messageDoc.ts` builds the document (pure, tested): comment head +
  `stringifyPretty` body. `.jsonc` filename so editors highlight it despite comments.
- The table (and its consume hook) stays mounted while the editor is open — returning
  lands on an unchanged window, no re-fetch.

## Key Files

| File | Role |
|------|------|
| `src/views/messageDoc.ts` | Document builder: metadata head, lossless body, hex fallback |
| `src/editor/view.ts` | suspend → spawn `$EDITOR` → resume, 0600 temp file |
