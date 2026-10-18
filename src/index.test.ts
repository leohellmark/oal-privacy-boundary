import { expect, test } from "bun:test";
import { CLAUDE_ENDPOINTS, CREDENTIAL_SHAPES, DATA_TRANSFERS, PRIVACY_POLICY_VERSION, auditedClaudeFetch, classifyClaudeRequest, claudeUserMessage, containsCredential, redactDiagnostics } from "./index";
import { generateKeyPairSync } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { boundaryDigest, signManifest, verifyManifest, type PrivacyManifest } from "../attest";

test("Claude event contains only the intended message and opaque run ID", () => {
  const event = claudeUserMessage({ text: " Build my app ", runId: "18e87baa-9761-4cef-a330-3bd71b8e7c8d", email: "private@example.com" } as { text: string; runId: string });
  expect(event).toEqual({
    type: "user.message",
    content: [{ type: "text", text: "[OAL_RUN_ID:18e87baa-9761-4cef-a330-3bd71b8e7c8d]\nBuild my app" }],
  });
  expect(JSON.stringify(event)).not.toContain("private@example.com");
});

test("diagnostics remove known credential fields and token shapes", () => {
  expect(redactDiagnostics({ authorization: "Bearer topsecret", nested: { api_key: "test", output: "sk-ant-abcdefghijklmnopqrstuvwxyz" } })).toEqual({
    authorization: "[redacted]",
    nested: { api_key: "[redacted]", output: "[redacted]" },
  });
});

test("a pasted credential cannot become a Claude prompt", () => {
  expect(() => claudeUserMessage({ text: "Use ghp_abcdefghijklmnopqrstuvwxyz in my app", runId: "18e87baa-9761-4cef-a330-3bd71b8e7c8d" })).toThrow("Credentials must be connected securely");
});

test("credential-shaped work preference text is refused before storage", () => {
  expect(containsCredential("Prefer short progress updates.")).toBe(false);
  expect(containsCredential("Use ghp_abcdefghijklmnopqrstuvwxyz as the project token.")).toBe(true);
});

test("audited transport blocks off-destination calls and leaked tool credentials", async () => {
  const sent: Request[] = [];
  const transport = auditedClaudeFetch(async (input, init) => {
    sent.push(new Request(input, init));
    return new Response("{}", { status: 200 });
  });
  const endpoint = "https://api.anthropic.com/v1/sessions/sesn_test/events";
  await transport(endpoint, { method: "POST", body: JSON.stringify({ events: [
    claudeUserMessage({ text: "Plan the app", runId: "18e87baa-9761-4cef-a330-3bd71b8e7c8d" }),
  ] }) });
  expect(sent).toHaveLength(1);
  expect(sent[0].redirect).toBe("manual");
  await expect(transport(endpoint, { method: "POST", body: JSON.stringify({ events: [{ type: "user.custom_tool_result", content: [
    { type: "text", text: "ghs_abcdefghijklmnopqrstuvwxyz" },
  ] }] }) })).rejects.toThrow("Credentials must be connected securely");
  await expect(transport("https://example.com/v1/sessions/sesn_test/events", { method: "POST", body: "{}" })).rejects.toThrow("declared provider destination");
  expect(sent).toHaveLength(1);
});

test("an attestation binds source and build hashes to a trusted key", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const manifest: PrivacyManifest = {
    schema_version: 1, source_commit: "a".repeat(40), boundary_sha256: boundaryDigest(),
    build_sha256: "b".repeat(64), signed_at: "2026-09-28T00:00:00.000Z",
  };
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const signature = signManifest(manifest, privatePem);
  expect(verifyManifest(manifest, signature, publicPem)).toBe(true);
  expect(verifyManifest({ ...manifest, build_sha256: "c".repeat(64) }, signature, publicPem)).toBe(false);
});

test("Slack reply boundary allows only a private DM and excludes credentials and extra context", async () => {
  const { slackReplyPayload } = await import("./index");
  const input = { channelId: "DALICE", deliveryId: "18e87baa-9761-4cef-a330-3bd71b8e7c8d", text: "Reply", memory: "Private profile" };
  const result = slackReplyPayload(input);
  expect(JSON.stringify(result)).not.toContain("Private profile");
  expect(result.mrkdwn).toBe(false);
  expect(result.blocks[0].text.type).toBe("plain_text");
  expect(() => slackReplyPayload({ ...input, channelId: "CROOM" })).toThrow();
  expect(() => slackReplyPayload({ ...input, text: "Use xoxb-abcdefghijklmnopqrstuvwxyz" })).toThrow();
  expect(JSON.stringify(slackReplyPayload({ ...input, text: '\\'.repeat(8000) })).length).toBeLessThanOrEqual(4000);
  expect(slackReplyPayload({ ...input, text: "a".repeat(8000) }).text).toContain("full response");
});


test("specialist events and outcome rubrics cannot bypass the conversation credential gate", async () => {
  let sent = 0;
  const transport = auditedClaudeFetch(async () => { sent++; return new Response("{}"); });
  for (const endpoint of [
    "https://api.anthropic.com/v1/sessions/sesn_test/events",
    "https://api.anthropic.com/v1/sessions/sesn_test/threads/thread_test/events",
  ]) {
    await transport(endpoint, { method: "POST", body: JSON.stringify({ events: [{ type: "user.define_outcome", description: "A public brief", rubric: { content: "Source-grounded findings" } }] }) });
    const before = sent;
    for (const event of [
      { type: "user.define_outcome", rubric: { content: "ghp_abcdefghijklmnopqrstuvwxyz" } },
      { type: "system.message", content: [{ text: "ghs_abcdefghijklmnopqrstuvwxyz" }] },
      { type: "user.custom_tool_result", content: [{ text: "Bearer " + "x".repeat(30) }] },
    ]) await expect(transport(endpoint, { method: "POST", body: JSON.stringify({ events: [event] }) })).rejects.toThrow("conversation events");
    expect(sent).toBe(before);
  }
});


test("agent prompts, session overrides and seeded events pass the same boundary while mount credentials stay outside prompts", async () => {
  let calls = 0;
  const transport = auditedClaudeFetch(async () => { calls++; return new Response("{}"); });
  const token = "ghp_abcdefghijklmnopqrstuvwxyz";
  for (const [path, body] of [
    ["/v1/agents", { system: token }],
    ["/v1/agents/agent_test", { system: [{ text: token }] }],
    ["/v1/sessions", { agent: { type: "agent_with_overrides", system: token } }],
    ["/v1/sessions", { initial_events: [{ type: "user.message", content: [{ text: token }] }] }],
    ["/v1/sessions", { title: token }],
    ["/v1/deployments", { initial_events: [{ type: "system.message", content: token }] }],
  ] as const) await expect(transport("https://api.anthropic.com"+path, { method: "POST", body: JSON.stringify(body) })).rejects.toThrow("Credentials cannot be sent");
  expect(calls).toBe(0);
  await transport("https://api.anthropic.com/v1/sessions", { method: "POST", body: JSON.stringify({ agent: "agent_test", resources: [{ type: "github_repository", auth: { token } }], vault_ids: ["vault_test"] }) });
  expect(calls).toBe(1);
});

test("agent snapshots and both modern rosters cannot hide conversational credentials", async () => {
  let sends = 0;
  const transport = auditedClaudeFetch(async () => { sends++; return new Response("{}"); });
  const token = "ghp_abcdefghijklmnopqrstuvwxyz";
  for (const field of ["system", "prompt", "instructions", "description", "title", "name"]) {
    for (const body of [
      { agent: { [field]: token } },
      { multiagent: { type: "coordinator", agents: [{ type: "agent", [field]: token }] } },
      ...["subagents", "workflows"].map(kind => ({ agent: { multiagent: {
        type: "multiagent_20261001", [kind]: { type: "enabled", predefined_agents: [{ type: "agent", [field]: token }] },
      } } })),
      { agent: { multiagent: { type: "multiagent_20261001", workflows: { type: "enabled", predefined_agents: [
        { multiagent: { type: "coordinator", agents: [{ [field]: token }] } },
      ] } } } },
    ]) {
      await expect(transport("https://api.anthropic.com/v1/sessions/session_test", {
        method: "POST", body: JSON.stringify(body),
      })).rejects.toThrow("Credentials cannot be sent");
    }
  }
  expect(sends).toBe(0);
});

test("actual SDK create and update requests enforce modern inline-agent prompt checks", async () => {
  const requests: Request[] = [];
  const client = new Anthropic({ apiKey: "synthetic-provider-key", fetch: auditedClaudeFetch(async (input, init) => {
    requests.push(new Request(input, init));
    return new Response("{}", { headers: { "Content-Type": "application/json" } });
  }) });
  const token = "ghs_abcdefghijklmnopqrstuvwxyz";
  const member = { type: "agent", name: "Researcher", model: "claude-sonnet-4-6", system: token };
  for (const kind of ["subagents", "workflows"]) {
    const multiagent = { type: "multiagent_20261001", [kind]: {
      type: "enabled", inline_agents: { type: "disabled" }, predefined_agents: [member],
    } };
    await expect(Promise.resolve(client.beta.agents.create({ name: "Team", model: "claude-sonnet-4-6", multiagent } as any,
      { maxRetries: 0 }))).rejects.toThrow();
    await expect(Promise.resolve(client.beta.sessions.create({ environment_id: "env_test", agent: {
      type: "agent", name: "Team", model: "claude-sonnet-4-6", multiagent,
    } } as any, { maxRetries: 0 }))).rejects.toThrow();
    await expect(Promise.resolve(client.beta.sessions.update("session_test", { agent: {
      type: "agent", name: "Team", model: "claude-sonnet-4-6", multiagent,
    } } as any, { maxRetries: 0 }))).rejects.toThrow();
  }
  expect(requests).toHaveLength(0);
  await client.beta.sessions.create({ environment_id: "env_test", agent: {
    type: "agent", name: "Team", model: "claude-sonnet-4-6", system: "Use the selected repository",
    multiagent: { type: "multiagent_20261001", workflows: {
      type: "enabled", inline_agents: { type: "disabled" }, predefined_agents: [{ ...member, system: "Review the implementation" }],
    } },
    mcp_servers: [{ type: "url", name: "Private service", url: "https://service.example/mcp", authorization_token: token }],
  }, vault_ids: ["vault_test"], resources: [{ type: "github_repository", auth: { token } }] } as any);
  expect(requests).toHaveLength(1);
  const sent = await requests[0].json();
  expect(sent.resources[0].auth.token).toBe(token);
  expect(sent.agent.mcp_servers[0].authorization_token).toBe(token);
  expect(sent.vault_ids).toEqual(["vault_test"]);
});

test("modern prompt checks apply to inspectable resource updates without scanning vault authentication", async () => {
  const sent: Request[] = [];
  const transport = auditedClaudeFetch(async (input, init) => { sent.push(new Request(input, init)); return new Response("{}"); });
  const token = "sk-ant-syntheticcredential0123456789";
  await expect(transport("https://api.anthropic.com/v1/agents/agent_test", { method: "PATCH", body: JSON.stringify({
    multiagent: { type: "multiagent_20261001", subagents: { predefined_agents: [{ name: token }] } },
  }) })).rejects.toThrow("Credentials cannot be sent");
  await transport("https://api.anthropic.com/v1/vaults/vault_test/credentials", { method: "POST", body: JSON.stringify({
    name: token, value: token,
  }) });
  expect(sent).toHaveLength(1);
});

test("memory routes remove the incompatible SDK beta, but session resource mounts retain theirs", async () => {
  const requests: Request[] = [];
  const transport = auditedClaudeFetch(async input => { requests.push(new Request(input)); return new Response("{}"); });
  const headers = { "anthropic-beta": "agent-memory-2026-07-22,managed-agents-2026-04-01" };
  for (const method of ["GET", "POST", "DELETE"]) {
    await transport("https://api.anthropic.com/v1/memory_stores/memstore_test/memories/mem_test?beta=true" + (method === "DELETE" ? `&expected_content_sha256=${"a".repeat(64)}` : ""), {
      method, headers, ...(method === "POST" ? { body: JSON.stringify({ content: "Prefers concise updates", precondition: { type: "content_sha256", content_sha256: "a".repeat(64) } }) } : {}),
    });
    expect(requests.at(-1)?.headers.get("anthropic-beta")).toBe("agent-memory-2026-07-22");
  }
  await transport("https://api.anthropic.com/v1/sessions", { method: "POST", headers: { "anthropic-beta": "managed-agents-2026-04-01" }, body: JSON.stringify({ resources: [{ type: "memory_store", id: "memstore_test" }] }) });
  expect(requests.at(-1)?.headers.get("anthropic-beta")).toBe("managed-agents-2026-04-01");
});
test("memory writes cannot bypass credential protection", async () => {
  let sent = 0;
  const transport = auditedClaudeFetch(async () => { sent++; return new Response("{}"); });
  await expect(transport("https://api.anthropic.com/v1/memory_stores/memstore_test/memories/mem_test", {
    method: "POST", body: JSON.stringify({ content: "Use ghp_abcdefghijklmnopqrstuvwxyz" }),
  })).rejects.toThrow("project memory");
  expect(sent).toBe(0);
});
test("the public boundary refuses unconditional, malformed or ambiguous memory entry deletion", async () => {
  let sent = 0;
  const transport = auditedClaudeFetch(async () => { sent++; return new Response("{}"); });
  const path = "https://api.anthropic.com/v1/memory_stores/memstore_test/memories/mem_test";
  for (const query of ["", "?expected_content_sha256=short", `?expected_content_sha256=${"a".repeat(64)}&expected_content_sha256=${"b".repeat(64)}`])
    await expect(transport(path + query, { method: "DELETE" })).rejects.toThrow("fingerprint");
  expect(sent).toBe(0);
  await transport(path + `?expected_content_sha256=${"a".repeat(64)}`, { method: "DELETE" });
  expect(sent).toBe(1);
});

test("read redirects stay inside the provider and preserve cancellation", async () => {
  const requests: Request[] = [];
  const controller = new AbortController();
  const transport = auditedClaudeFetch(async input => {
    const request = new Request(input); requests.push(request);
    return requests.length === 1 ? new Response(null, { status: 302, headers: { location: "/v1/files/file_test/content?part=1" } }) : new Response("file bytes");
  });
  expect(await (await transport("https://api.anthropic.com/v1/files/file_test/content", { signal: controller.signal, headers: { "x-api-key": "test-only" } })).text()).toBe("file bytes");
  expect(requests).toHaveLength(2);
  expect(requests[1].headers.get("x-api-key")).toBe("test-only");
  expect(requests[1].redirect).toBe("manual");
  controller.abort(); expect(requests[1].signal.aborted).toBe(true);
});

test("a redirect cannot leak provider credentials or replay a write", async () => {
  for (const [method, destination] of [["GET", "https://example.com/collect"], ["GET", "http://api.anthropic.com/plain"], ["POST", "/v1/memory_stores/store_test"]]) {
    let calls = 0;
    const transport = auditedClaudeFetch(async () => { calls++; return new Response(null, { status: 307, headers: { location: destination } }); });
    await expect(transport("https://api.anthropic.com/v1/files/file_test", { method, headers: { "x-api-key": "test-only" } })).rejects.toThrow(/redirect/);
    expect(calls).toBe(1);
  }
});

test("provider read redirect loops stop after a bounded number of requests", async () => {
  let calls = 0;
  const transport = auditedClaudeFetch(async () => { calls++; return new Response(null, { status: 302, headers: { location: "/v1/files/file_test" } }); });
  await expect(transport("https://api.anthropic.com/v1/files/file_test")).rejects.toThrow("cannot be replayed safely");
  expect(calls).toBe(4);
});
test("Linear connection keys are excluded from conversation and diagnostics", () => {
  const key = "lin_api_syntheticcredential0123456789";
  expect(containsCredential(key)).toBe(true);
  expect(JSON.stringify(redactDiagnostics({ error: key }))).not.toContain(key);
});

// The samples are assembled at run time so that no complete token-shaped string sits in this file for secret scanners to flag.
const join = (...parts: string[]) => parts.join("");
const SAMPLES: Record<string, string> = {
  "provider and platform key prefixes": join("gh", "p_", "abcdefghijklmnopqrstuvwxyz"),
  "Stripe keys": join("sk", "_live_", "abcdefghijklmnopqrstuvwx"),
  "AWS access key id": join("AK", "IA", "ABCDEFGHIJKLMNOP"),
  "Google API key": join("AI", "za", "abcdefghijklmnopqrstuvwxyz012345678"),
  "JSON web token": join("ey", "Jhbgcioijiuzi1nij9", ".", "ey", "Jzdwiioixmjm0nta2nzg5in0", ".", "abcdefghijklmnop"),
  "private key block": join("-----BEGIN ", "RSA PRIVATE KEY", "-----"),
  "Slack webhook URL": join("https://hooks.slack.com/services/", "T01234567", "/", "B01234567", "/", "abcdefghijklmnopqrstuvwx"),
  "URL with embedded credentials": join("https://alice:", "hunter2hunter2", "@example.com/path"),
  "bearer token": join("Bearer ", "x".repeat(30)),
};

test("every credential shape is refused and scrubbed, and each is covered by a sample", () => {
  expect(Object.keys(SAMPLES).sort()).toEqual(CREDENTIAL_SHAPES.map(shape => shape.name).sort());
  for (const shape of CREDENTIAL_SHAPES) {
    const sample = SAMPLES[shape.name]!;
    expect({ name: shape.name, refused: containsCredential(`Please use ${sample} for this`) }).toEqual({ name: shape.name, refused: true });
    expect(JSON.stringify(redactDiagnostics({ output: `used ${sample} here` }))).not.toContain(sample);
    expect(() => claudeUserMessage({ text: `Use ${sample}`, runId: "18e87baa-9761-4cef-a330-3bd71b8e7c8d" })).toThrow("Credentials must be connected securely");
  }
});

test("ordinary prose, keywords and look-alikes are not refused", () => {
  for (const text of [
    "My password manager is set up and the API key rotation is on Friday.",
    "Visit https://example.com/docs and https://user@example.com for details.",
    "Use a bearer token in the Authorization header (do not paste it here).",
    "The sk- prefix is short, and AKIA alone is not a key.",
    "Send 50 000 SEK to account 1234-5678 before Friday.",
  ]) expect({ text, refused: containsCredential(text) }).toEqual({ text, refused: false });
});

test("the declared endpoint list classifies what Oal calls and nothing it does not", () => {
  for (const [method, path] of [
    ["POST", "/v1/sessions"], ["GET", "/v1/sessions/sesn_1"], ["POST", "/v1/sessions/sesn_1/events"], ["GET", "/v1/sessions/sesn_1/events/stream"],
    ["POST", "/v1/sessions/sesn_1/threads/thr_1/events"], ["GET", "/v1/sessions/sesn_1/threads"], ["POST", "/v1/sessions/sesn_1/archive"],
    ["POST", "/v1/sessions/sesn_1/resources"], ["POST", "/v1/agents"], ["POST", "/v1/agents/agt_1"], ["POST", "/v1/agents/agt_1/archive"],
    ["POST", "/v1/environments"], ["POST", "/v1/vaults"], ["POST", "/v1/vaults/vlt_1/credentials"], ["POST", "/v1/vaults/vlt_1/credentials/cred_1/archive"],
    ["POST", "/v1/memory_stores"], ["DELETE", "/v1/memory_stores/ms_1/memories/mem_1"], ["POST", "/v1/files"], ["GET", "/v1/files/file_1/content"],
    ["DELETE", "/v1/files/file_1"], ["POST", "/v1/deployments"], ["GET", "/v1/deployment_runs"], ["POST", "/v1/messages"], ["POST", "/v1/oauth/token"], ["GET", "/v1/models/claude-haiku-5-5"],
  ] as const) expect({ method, path, declared: classifyClaudeRequest(method, path) !== null }).toEqual({ method, path, declared: true });
  for (const [method, path] of [
    ["GET", "/v1/organizations/members"], ["POST", "/v1/admin/api_keys"], ["POST", "/v1/sessions/sesn_1/unknown"], ["DELETE", "/v1/messages"],
    ["POST", "/v1/complete"], ["GET", "/v1/workspaces"], ["POST", "/v1/files/file_1"], ["GET", "/v1/sessions/sesn_1/events/stream/extra"],
  ] as const) expect({ method, path, declared: classifyClaudeRequest(method, path) !== null }).toEqual({ method, path, declared: false });
});

test("the declared transfers and endpoints agree: no unknown transfer, no declared Anthropic transfer that nothing can carry", () => {
  const known = new Set(Object.keys(DATA_TRANSFERS));
  for (const endpoint of CLAUDE_ENDPOINTS) for (const transfer of endpoint.transfers) expect({ endpoint: endpoint.id, transfer, known: known.has(transfer) }).toEqual({ endpoint: endpoint.id, transfer, known: true });
  const carried = new Set(CLAUDE_ENDPOINTS.flatMap(endpoint => endpoint.transfers));
  for (const [id, transfer] of Object.entries(DATA_TRANSFERS)) {
    if (!/Anthropic/.test(transfer.destination)) continue;
    expect({ id, carried: carried.has(id as never) }).toEqual({ id, carried: true });
  }
  expect(PRIVACY_POLICY_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
});

test("strict mode refuses an undeclared Claude path; the default mode leaves classification to the inventory test", async () => {
  let sent = 0;
  const upstream: typeof fetch = async () => { sent++; return new Response("{}"); };
  const strict = auditedClaudeFetch(upstream, { strict: true });
  await strict("https://api.anthropic.com/v1/sessions", { method: "POST", body: JSON.stringify({ agent: "agent_test" }) });
  await expect(strict("https://api.anthropic.com/v1/organizations/members")).rejects.toThrow("declared endpoint list");
  expect(sent).toBe(1);
  await auditedClaudeFetch(upstream)("https://api.anthropic.com/v1/organizations/members");
  expect(sent).toBe(2);
});

test("Messages API calls pass the credential gate too", async () => {
  let sent = 0;
  const transport = auditedClaudeFetch(async () => { sent++; return new Response("{}"); });
  const body = (text: string, system = "You write suggestions.") => JSON.stringify({ model: "claude-haiku-5-5", system, messages: [{ role: "user", content: text }] });
  await transport("https://api.anthropic.com/v1/messages", { method: "POST", body: body("Person: Plan the offsite") });
  expect(sent).toBe(1);
  await expect(transport("https://api.anthropic.com/v1/messages", { method: "POST", body: body(`Person: use ${SAMPLES["provider and platform key prefixes"]}`) })).rejects.toThrow("conversation text");
  await expect(transport("https://api.anthropic.com/v1/messages", { method: "POST", body: body("hello", `key ${SAMPLES["AWS access key id"]}`) })).rejects.toThrow("conversation text");
  await expect(transport("https://api.anthropic.com/v1/messages", { method: "POST", body: "not json" })).rejects.toThrow("inspectable JSON");
  expect(sent).toBe(1);
});

