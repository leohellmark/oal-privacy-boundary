import { expect, test } from "bun:test";
import { auditedClaudeFetch, claudeUserMessage, redactDiagnostics } from "./index";
import { generateKeyPairSync } from "node:crypto";
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
