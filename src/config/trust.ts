import { rootCertificates } from "node:tls"

// What `ca_cert` means for TLS (spec 002, nfr/003).
//
// Node and Bun treat a supplied `ca` as the *whole* trust store, not an addition to it: the
// moment one PEM is handed over, the bundled public roots are gone. `ca_cert` is documented
// as what a cluster needs when its chain roots in a private CA, applied to brokers and
// registry alike — it was never a promise to distrust everything else, and reading it that
// way breaks the ordinary deployment where the broker presents a private project CA and the
// registry sits behind a publicly-rooted certificate (or a corporate proxy's root, which is
// the same shape). That failure surfaces as `unable to get local issuer certificate` on
// every schema fetch, which the table then renders as a decode failure on every row.

/**
 * The default roots plus the private CA, in that order — never the private CA alone.
 *
 * Build this once per connection rather than per request: it is 100+ PEMs, and the TLS
 * layer parses the list each time it is handed one.
 */
export function trustAnchors(pem: string): string[] {
  return [...rootCertificates, pem]
}
