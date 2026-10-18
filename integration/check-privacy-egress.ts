/**
 * Build-time check that provider calls go through the audited transport, and (with --inventory) a sorted JSON inventory of what
 * the source mentions: external host names found in string literals and the provider SDK methods it calls. The inventory is
 * what a researcher compares with a network trace; it lists what the code names, it does not prove what runs.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const allowedConstructor = "src/server/managed-agents-egress.server.ts";
const problems: string[] = [];
const inventory = process.argv.includes("--inventory");
const destinations = new Map<string, Set<string>>();
const sdkMethods = new Map<string, Set<string>>();
/** Files that only carry documentation links, generated data or assets: their URLs are not destinations the application calls. */
const DATA_ONLY = /agent-(?:skills|templates)\.server\.ts$|\.asset\.json$|\/procedures\/|\.md$|\.css$|routeTree\.gen\.ts$|integrations\/supabase\/types\.ts$/;
const isTest = (name: string) => /\.test\.[cm]?[jt]sx?$/.test(name) || name.startsWith("scripts/fixtures/");

async function inspect(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { await inspect(path); continue; }
    if (!/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
    const name = relative(root, path);
    const source = await readFile(path, "utf8");
    // The Slack and Google write rules are about application code; test fixtures under scripts/ may name the hosts.
    const application = !name.startsWith("scripts/");
    if (application && /https:\/\/slack\.com\/api\//.test(source)
      && !["src/server/slack-api.server.ts", "src/server/slack-oauth.server.ts"].includes(name)) {
      problems.push(`${name}: direct Slack destination outside the fixed connector transport`);
    }
    if (application && /slackApi\(\s*["']chat\.postMessage["']/.test(source) && name !== "src/server/slack-replies.server.ts") {
      problems.push(`${name}: Slack write outside the reply boundary and action gateway`);
    }
    if (application && /https:\/\/(?:gmail\.googleapis\.com|oauth2\.googleapis\.com|openidconnect\.googleapis\.com|www\.googleapis\.com\/(?:calendar|drive))/.test(source)
      && !["src/server/google-api.server.ts", "src/server/google-api.server.test.ts"].includes(name)) {
      problems.push(`${name}: direct Google destination outside the fixed connector transport`);
    }
    if (application && /googleApi\(\s*\{[^}]*\bbody\s*:/s.test(source) && name !== "src/server/google-operations.server.ts" && !name.endsWith(".test.ts")) {
      problems.push(`${name}: Google mutation outside the persisted action gateway`);
    }
    if (name !== allowedConstructor && !isTest(name) && /new\s+Anthropic\s*\(/.test(source)) {
      problems.push(`${name}: direct Claude SDK client construction`);
    }
    if (/https:\/\/api\.anthropic\.com/.test(source) && name !== allowedConstructor && !isTest(name)) {
      problems.push(`${name}: direct Claude API destination`);
    }
    // Code that ships to the browser must never hold a provider client.
    if (/^src\/(?:components|hooks|lib)\//.test(name) && !isTest(name) && /^\s*import\s+(?!type\b)[^;]*from\s+["']@anthropic-ai\/sdk/m.test(source)) {
      problems.push(`${name}: provider SDK imported in code that can reach the browser`);
    }
    if (inventory && !isTest(name) && !DATA_ONLY.test(name)) {
      for (const match of source.matchAll(/https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,})(?::\d+)?/gi)) {
        const host = match[1]!.toLowerCase();
        // Reserved example names, test hosts and namespace URLs are not destinations anyone calls.
        if (/\.(?:example|test|invalid|localhost)$|^attacker\.|^(?:www\.w3\.org|schema\.org|www\.sitemaps\.org)$/.test(host)) continue;
        // Oal's own sites, its hosting and its asset storage are not places user data is sent to.
        if (/\.(?:vercel\.app|lovable\.app|r2\.dev)$|^lovable\.dev$|^oal\./.test(host)) continue;
        destinations.set(host, (destinations.get(host) ?? new Set()).add(name));
      }
      for (const match of source.matchAll(/\.beta\.((?:[A-Za-z]+\.)*[A-Za-z]+)\(|\bmessages\.create\(/g)) {
        const method = match[1] ? `beta.${match[1]}` : "messages.create";
        sdkMethods.set(method, (sdkMethods.get(method) ?? new Set()).add(name));
      }
    }
  }
}

for (const directory of ["src", "scripts"]) await inspect(join(root, directory)).catch(error => { if ((error as { code?: string }).code !== "ENOENT") throw error; });
if (inventory) {
  // Counts, not file names: the private tree's layout is not published, and a count is enough to see what is named and how widely.
  const sorted = (map: Map<string, Set<string>>, key: string) => [...map].sort(([a], [b]) => a.localeCompare(b)).map(([name, files]) => ({ [key]: name, mentioned_in_files: files.size }));
  process.stdout.write(JSON.stringify({ destinations: sorted(destinations, "host"), provider_sdk_methods: sorted(sdkMethods, "method") }, null, 2) + "\n");
  process.exit(problems.length ? 1 : 0);
}
if (problems.length) {
  console.error("Provider calls must pass through the audited transport:\n" + problems.join("\n"));
  process.exit(1);
}
console.log("Claude SDK construction and known Slack/Google write paths are confined to their audited boundaries.");
