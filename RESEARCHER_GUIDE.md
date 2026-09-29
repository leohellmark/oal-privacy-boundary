# Oal privacy boundary: researcher guide

This release contains the small, public part of Oal's application-side data
boundary. It is designed for code review and reproducible tests. It does not
contain Oal's private application, customer data, credentials, provider vaults,
or deployment secrets.

## What to inspect

- `src/index.ts`: declared transfer categories, Claude message construction,
  credential-shaped content checks, destination enforcement and diagnostic
  redaction.
- `src/index.test.ts`: executable examples of accepted and rejected transfers.
- `attest.ts`: source and build digest plus Ed25519 attestation format.
- `integration/managed-agents-egress.server.ts`: the SDK construction point
  copied from the same source commit as this package.
- `integration/check-privacy-egress.ts`: the private build's direct-client
  source check. It is provided for review, but needs the full private tree to
  run against every call site.

Run `bun test src/index.test.ts` in this directory. Verify each file hash in
`source-manifest.json` against the exact bytes. The manifest's `source_commit`
identifies the private app commit from which the allowlisted files were copied.
`private_boundary_sha256` is the digest of the original package directory;
running `boundaryDigest()` in this exported layout produces a different digest
because the bundle also contains integration files and its own manifest.

## What this does and does not establish

The boundary rejects direct SDK requests to destinations other than
`api.anthropic.com`, and rejects credential-shaped values in user messages and
custom tool results. It does not prove that all sensitive data is absent from
agent configuration, repository content, third-party tools, or the provider's
own processing. The public source check cannot independently inspect every
private app call site.

No production privacy verification should be claimed from this source release
alone. A complete claim needs a signed build attestation tied to an observed
deployment, review of the deployed network configuration, and a traffic test
that records outbound destinations and data categories without exposing user
content. The release should state the tested deployment version, auditor,
date, and exceptions. Until those steps occur, the UI should say only that
the source boundary is published for inspection.

Repository mounts are a separate data path. A selected repository is copied
into a Claude sandbox with a short-lived read token. The app stores the token
encrypted so it can be revoked, but Oal cannot prove how Claude internally
handles data through this package. The user must see the repository-specific
disclosure before connecting it.
