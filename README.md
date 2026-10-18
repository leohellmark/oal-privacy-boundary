# Oal privacy boundary

The code that decides what Oal sends to its AI model provider, published so that anyone can read it, run its tests and check our claims against the real source instead of a description.

What Oal promises, and what this code enforces:

- **Only what is declared goes out.** Every transfer is written down in `src/index.ts` (`DATA_TRANSFERS`): where it goes, why, and which kinds of data it carries. Every provider request path the application may call is listed too (`CLAUDE_ENDPOINTS`).
- **Credentials never go into prompts.** Credential-shaped text (API keys, access tokens, private keys, webhook URLs and links with a password in them) is refused in messages, agent instructions, session configuration, memory writes and suggestion requests. It recognises common formats; it is a guard against accidents, not a promise to catch every secret. A secret you save for a site goes into a write-only vault, never into a conversation.
- **One audited door.** Every request leaves through one transport that allows a single destination (the model provider's API host, named in the code), follows no redirect elsewhere, and checks the content above. A build check fails if any other code tries to build its own provider client.
- **Diagnostics are scrubbed.** Anything Oal stores for debugging has credential-shaped text removed.

What this does **not** prove: what is deployed right now, what the provider does with data after it arrives, or what an agent reads through a tool you connected. Those are separate disclosures. `RESEARCHER_GUIDE.md` lists exactly what is checked, how, and what is left.

## Run it

```sh
bun install
bun test           # credential rules, transport rules, the endpoint list, strict mode
bun verify.ts      # checks every file here against source-manifest.json (SHA-256)
bun transfers.ts   # prints the declared transfers and request paths, generated from the source
```

## What is here

| Path | What it is |
| --- | --- |
| `src/index.ts` | The boundary itself |
| `src/index.test.ts` | Executable examples of what is accepted and refused |
| `verify.ts`, `transfers.ts`, `attest.ts` | Manifest check, documentation generator, build attestation format |
| `source-manifest.json` | SHA-256 of every file, the policy version, and the private commit the files were copied from |
| `inventory.json` | Outside host names and provider SDK methods that Oal's source mentions, for comparing with a network trace. It names what the code mentions; it does not prove what runs |
| `integration/` | Files copied from Oal's application for review: the one place a provider client is built, the build check, the test that every provider call is declared, and the opt-in work-preference path. They import private modules, so they are for reading rather than running |

## Status

This is a source publication. No build of Oal has been signed and tied to a deployment yet, so production has not been verified by this repository alone; the accurate statement is that the boundary's source is open for inspection. See the guide for what a full verification would need.

MIT licensed. If you find a request, destination or kind of data that Oal sends and this code does not declare, please open an issue.
