# Oal privacy boundary: researcher guide

This release contains the small, public part of Oal's application-side data boundary. It is designed for code review and reproducible tests. It contains no customer data, credentials, provider vaults or deployment secrets, and not the private application.

## Start here

1. `bun install && bun run test` runs the boundary's tests (25 at this release, including real provider-SDK requests passing through the transport).
2. `bun verify.ts` recomputes the SHA-256 of every file against `source-manifest.json`. A pass means these are the exported bytes.
3. `bun transfers.ts` prints every declared transfer and every provider request path, generated from the source.
4. Read `src/index.ts` (about 370 lines). It has four parts: the declared transfers, the declared endpoint list, the credential shapes, and the transport.

## What the code enforces, and where it is tested

| Claim | Where it is enforced | Tested in `src/index.test.ts` |
| --- | --- | --- |
| Every provider request goes to the single declared API host (named in `auditedClaudeFetch`) and nowhere else; redirects are followed only for GET and HEAD, at most three, inside that origin | `auditedClaudeFetch` | "audited transport blocks off-destination calls" |
| A user message to the model provider is the text and an opaque run identifier, nothing else | `claudeUserMessage` | "Claude event contains only the intended message" |
| Credential-shaped text (nine families, listed by `bun transfers.ts`; each has a test sample) is refused in conversation events (`user.*` and `system.message`), including tool results and outcome rubrics | `containsCredential` in the transport | three tests on events, rosters and rubrics |
| The same is refused in agent, session and deployment configuration: system prompts, instructions, titles, names, descriptions, nested rosters and initial events (mount tokens and vault secrets travel in resource fields, which are not scanned) | `assertConfigurationPromptFields` | "agent prompts, session overrides and seeded events pass the same boundary" and two more |
| The same is refused in project-memory writes, and a memory deletion needs the content fingerprint that was observed | transport | "memory writes cannot bypass credential protection" |
| The same is refused in Messages API calls (the suggestions feature) | transport | "Messages API calls pass the credential gate too" |
| Every provider path the application calls is in the declared list, and the list matches the declared transfers | `CLAUDE_ENDPOINTS`, `classifyClaudeRequest` | "the declared endpoint list classifies what Oal calls" and "the declared transfers and endpoints agree" |
| With `strict` on, an undeclared path is refused | transport option | "strict mode refuses an undeclared Claude path" |
| Stored diagnostics carry no credential-shaped text and no value under a secret-looking key | `redactDiagnostics` | "diagnostics remove known credential fields and token shapes" and the per-shape test |
| Slack replies go only to a private DM, as plain text, with a length cap | `slackReplyPayload` | "Slack reply boundary allows only a private DM" |

Two checks run in the private application's build and are included for review in `integration/`:

- `check-privacy-egress.ts` fails the build if code outside the one audited factory constructs a provider client, names the provider's API host, or imports the SDK in code that can reach the browser. It now scans all of `src/` and `scripts/` (before 19 October 2026 it scanned only the server, worker and routes folders).
- `privacy-endpoint-inventory.test.ts` drives **every provider SDK method the source mentions** through the real SDK and this transport, with a recording fetch and no network, and fails if any resulting request is not in the declared list. A new call that nobody declared breaks the build.

## Comparing the code with a network trace

`inventory.json` lists host names found in string literals of the private source, and the provider SDK methods it calls, each with the files that name them. To test the claim from the outside, capture the outbound destinations of a deployment while using it, and look for a destination that is in neither the inventory nor `DATA_TRANSFERS`. A destination in the inventory that you never see is expected (not every feature runs in every test); a destination you see that is not in it would be a finding. Opaque identifiers, not message text, are enough to check the destination and category; you should not need to read user content.

## What this does not establish

- **What is deployed.** The manifest records bytes and the private commit they were copied from. A claim about a deployment needs a signed build attestation (`attest.ts`) tied to an observed deployment. None exists: `signed_production_build` is `false`.
- **What the provider does with data it receives.** The boundary governs what Oal sends, not provider-side processing.
- **What an agent reads through its own tools.** A repository mount, a connected app or a website an agent browses is a separate path with its own disclosure. A selected repository is copied into a Claude sandbox with a short-lived read token; the user sees a repository-specific disclosure before connecting it.
- **Content the shapes do not recognise.** The refusal is a guard against accidental credentials in common formats, not a secret scanner. A password in prose, a one-off token format or personal data in a message is not detected.
- **Bodies that are not inspected, by design.** A vault credential is a write-only secret that must reach the provider's vault, so its request body is deliberately not scanned; file uploads are bytes the owner chose to attach and are not scanned; session resource fields carry mount tokens.
- **Strict mode is off by default.** The endpoint list is enforced at build time by the inventory test, and at run time only when `OAL_STRICT_EGRESS=1`. It is off until it has been exercised on a test deployment, because a path missing from the list would otherwise stop a feature.
- **Other providers.** Google, Slack, GitHub, Supabase, Stripe and Vercel have their own transports. Only the Slack reply and the Google excerpt rules are in this package; the rest are named in `inventory.json` and not audited here.
- **The private call sites.** The build check is a guard against known direct-call patterns, not a proof that every runtime path or third-party package was inspected.

## What changed since the first export (29 September 2026)

- **Declared transfers grew from 5 to 24.** The first export named five: the Claude message, agent configuration, tool results, work preferences and the GitHub repository path. It did not name Google reads and writes, Slack replies and direct messages, discovery, tool confirmations, browser review images or project memory (all declared in the private source by 3 October and published now), and, new on 19 October: session management, the recent-messages record handed to a replacement session, file uploads, the credential vault, the sandbox environment, scheduled routines, the next-message suggestions, the optional lead-model classification, the developer judging tool, workload-identity authentication and the optional memory consolidation. Before the 19 October release the suggestions feature sent up to 12 recent messages to the Messages API without being declared and without the credential gate; it now sends the last 8, each clipped to 600 characters, once per reply, and describes that in its declaration.
- **Credential shapes grew from two to nine families.** The first export had one list of eight key prefixes and the bearer-token rule. There are now nine families covering 19 key prefixes (including Slack app and user tokens, Google OAuth tokens, GitLab and npm tokens) and eight other formats: Stripe keys, AWS key ids, Google API keys, JSON web tokens, private key blocks, Slack webhook URLs, URLs with embedded credentials and bearer tokens. One list drives both refusal and scrubbing.
- **The declared endpoint list, strict mode and the inventory test are new.**
- **The build check now covers all of `src/` and `scripts/`**, not three folders, and refuses the SDK in browser-reachable code.
- **The package declares no runtime dependencies**; tests need the provider SDK and `zod` (dev only).
- **`verify.ts`, `transfers.ts` and `inventory.json` are new.**
- **The policy version is `2026-10-19.4`.** It is part of the source and changes when a transfer or a rule changes.

## The opt-in work-preference path

`integration/principal-learning.*` and the preference migration are the application-owned, opt-in work-preference path. Agent suggestions must cite an actual user message and remain candidates until the user confirms them. The database stores a message reference, text span and digest rather than another copy of the cited words. The server functions show the authenticated review, export and deletion path. Only confirmed preferences from the selected mission are returned to Claude. These files import private modules and are for reading, not running.

## Reporting a problem

Open an issue in this repository. A finding that matters most: a request, destination or data category that the application makes and this package does not declare.
