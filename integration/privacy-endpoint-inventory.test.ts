/**
 * Every Claude API call the application can make must be in the declared endpoint list of the privacy boundary
 * (packages/oal-privacy-boundary, CLAUDE_ENDPOINTS). This drives each provider SDK method that the source mentions through the
 * real SDK with a recording transport and checks the resulting HTTP requests against that list, so a new call that nobody declared
 * fails here. No network is used and nothing is sent anywhere.
 */
import Anthropic from "@anthropic-ai/sdk";
import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { auditedClaudeFetch, classifyClaudeRequest } from "../packages/oal-privacy-boundary/src/index";

const files = (path: string): string[] => statSync(path).isFile() ? [path] : readdirSync(path).flatMap(entry => files(join(path, entry)));
const sources = [...files("src"), ...files("scripts")].filter(file => /\.[tj]sx?$/.test(file) && !/\.test\.[tj]sx?$/.test(file) && !file.includes("scratch"));

const used = new Map<string, Set<string>>();
for (const file of sources) {
  const text = readFileSync(file, "utf8");
  for (const match of text.matchAll(/\.beta\.((?:[A-Za-z]+\.)*[A-Za-z]+)\(/g)) used.set(match[1]!, (used.get(match[1]!) ?? new Set()).add(file));
}
// The raw paths written out in the source (the scheduled-deployment helper builds some by hand).
const rawPaths = new Set<string>();
for (const file of sources) for (const match of readFileSync(file, "utf8").matchAll(/["'`](\/v1\/[^"'`\s]+)/g)) {
  const path = match[1]!.replace(/\$\{[^}]*\}/g, "id_1").split("?")[0]!.replace(/\/+$/, "");
  if (/^\/v1\/(?:agents|sessions|environments|vaults|memory_stores|files|deployments|deployment_runs|messages|models|oauth|dreams)\b/.test(path)) rawPaths.add(path);
}

type Seen = { method: string; path: string; sdk?: string };
let currentSdkMethod = "";
async function exercise(): Promise<{ seen: Seen[]; silent: string[] }> {
  const seen: Seen[] = [];
  const audited = auditedClaudeFetch(async () => new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
  const client = new Anthropic({
    apiKey: "synthetic-test-key", maxRetries: 0,
    fetch: async (input, init) => {
      const request = new Request(input as never, init);
      // Only requests to a provider host count; the SDK also reads local files and blobs through the same fetch.
      if (new URL(request.url).protocol === "https:") seen.push({ method: request.method, path: new URL(request.url).pathname, sdk: currentSdkMethod });
      try { return await audited(input, init); } catch { return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }); }
    },
  });
  const silent: string[] = [];
  for (const name of [...used.keys()].sort()) {
    const parts = name.split(".");
    let target: any = (client as any).beta;
    for (const part of parts.slice(0, -1)) target = target?.[part];
    const method = target?.[parts[parts.length - 1]!];
    if (typeof method !== "function") { silent.push(name); continue; }
    // Local helpers that make no request (signature checking) are not provider calls.
    if (/^webhooks\./.test(name)) continue;
    const before = seen.length;
    currentSdkMethod = name;
    try {
      // A stand-in for every path parameter the SDK may require, so a call is not stopped before it makes its request.
      const params = { session_id: "id_3", thread_id: "id_4", vault_id: "id_5", memory_store_id: "id_6", memory_id: "id_7", credential_id: "id_8", file_id: "id_9", events: [] };
      const result = name === "files.upload" ? method.call(target, { file: new File(["x"], "x.txt", { type: "text/plain" }) }) : method.call(target, "id_1", params);
      if (result && typeof result.then === "function") await Promise.race([result.catch(() => undefined), new Promise(resolve => setTimeout(resolve, 400))]);
    } catch { /* the call shape is a stand-in; only the request it makes matters */ }
    if (seen.length === before) silent.push(name);
  }
  // Messages API (not under .beta).
  await Promise.resolve((client as any).messages.create({ model: "m", max_tokens: 1, messages: [] })).catch(() => undefined);
  return { seen, silent };
}

test("every provider SDK method the source mentions makes only declared requests", async () => {
  const { seen } = await exercise();
  expect(seen.length).toBeGreaterThan(20);
  const undeclared = seen.filter(request => !classifyClaudeRequest(request.method, request.path));
  expect(undeclared).toEqual([]);
});

test("the inventory really exercised the methods (a method that makes no request is named, and the list is short)", async () => {
  const { silent } = await exercise();
  // Methods that return a property or a helper rather than making a request on their own (for example `.beta.sessions.threads(...)` used as a namespace).
  expect(silent.filter(name => !/^sessions\.threads$/.test(name))).toEqual([]);
});

test("raw /v1 paths written in the source are declared, and Messages API calls are among the exercised requests", async () => {
  const undeclared = [...rawPaths].filter(path => !classifyClaudeRequest("GET", path) && !classifyClaudeRequest("POST", path));
  expect(undeclared).toEqual([]);
  const { seen } = await exercise();
  expect(seen.some(request => request.method === "POST" && request.path === "/v1/messages")).toBe(true);
});
