# Oal privacy boundary

This is the source of Oal's *application-side data minimisation* policy. It
constructs the user message Oal sends to Claude Managed Agents, scrubs
diagnostic values, and supplies the transport used by Oal's SDK clients. That
transport permits only `https://api.anthropic.com` and refuses credential-shaped
content in conversation events, including tool results. The build runs a source
check that rejects direct SDK client construction outside the transport factory.
The source is deliberately small enough to audit.

The module alone does **not** prove what code is deployed, what a connected
provider does with data, or what an agent reads through its own tools. Oal must
publish a reproducible build digest and a signed deployment attestation before
claiming that a production deployment runs an audited version. Repository
mounts and agent tool access are separate disclosures and controls. The source
check is a guard against known direct call patterns, not a proof that all
possible runtime paths or third-party packages have been inspected. A release
still needs network observation and deployment attestation.

Run `bun test packages/oal-privacy-boundary` from the repository root.

For a release, publish this directory and its source commit in a public read-only
repository. Sign the built worker with an Ed25519 release key kept outside this
repository:

```sh
bun packages/oal-privacy-boundary/attest.ts create path/to/worker.js path/to/attestation.json path/to/private.pem
bun packages/oal-privacy-boundary/attest.ts verify path/to/worker.js path/to/attestation.json path/to/trusted-public.pem
```

Researchers must obtain the public key through an independent trusted channel.
The manifest checks source and build bytes, but a real deployment also needs
an independently observed network trace and a signed association between this
build digest and the deployed Cloudflare worker version. No release is marked
verified until those checks and the connection-specific disclosures are done.
