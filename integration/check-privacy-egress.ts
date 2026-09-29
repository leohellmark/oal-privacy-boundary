import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const allowedConstructor = "src/server/managed-agents-egress.server.ts";
const problems: string[] = [];

async function inspect(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { await inspect(path); continue; }
    if (!/\.[cm]?[jt]sx?$/.test(entry.name)) continue;
    const name = relative(root, path);
    const source = await readFile(path, "utf8");
    if (name !== allowedConstructor && /new\s+Anthropic\s*\(/.test(source)) {
      problems.push(`${name}: direct Claude SDK client construction`);
    }
    if (/https:\/\/api\.anthropic\.com/.test(source) && name !== allowedConstructor) {
      problems.push(`${name}: direct Claude API destination`);
    }
  }
}

await inspect(join(root, "src/server"));
await inspect(join(root, "src/worker"));
await inspect(join(root, "src/routes"));
if (problems.length) {
  console.error("Provider calls must pass through the audited transport:\n" + problems.join("\n"));
  process.exit(1);
}
console.log("Claude SDK construction is confined to the audited transport.");
