/**
 * Check this directory against its manifest. Needs only Bun (or Node 22 with --experimental-strip-types); no dependencies.
 *
 *   bun verify.ts [directory]
 *
 * It recomputes the SHA-256 of every file listed in source-manifest.json and reports a file that is missing, changed or not
 * listed. A pass means these bytes are the bytes that were exported, nothing more: it does not say that a deployment runs this
 * code (that needs a signed build attestation, see README.md and attest.ts) and it does not run the tests.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const manifestPath = join(root, "source-manifest.json");
if (!existsSync(manifestPath)) { console.error(`No source-manifest.json in ${root}`); process.exit(2); }
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { source_commit?: string; policy_version?: string; exported_at?: string; signed_production_build?: boolean; files: Record<string, string> };

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const IGNORED = new Set(["node_modules", ".git", ".gitignore", "bun.lock", "bun.lockb", "package-lock.json", "source-manifest.json", ".DS_Store"]);
const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
  IGNORED.has(entry.name) ? [] : entry.isDirectory() ? walk(join(directory, entry.name)) : [relative(root, join(directory, entry.name)).replaceAll("\\", "/")]);

const problems: string[] = [];
for (const [file, expected] of Object.entries(manifest.files)) {
  const path = join(root, file);
  if (!existsSync(path)) { problems.push(`MISSING   ${file}`); continue; }
  if (sha256(path) !== expected) problems.push(`CHANGED   ${file}`);
}
for (const file of walk(root)) if (!(file in manifest.files)) problems.push(`NOT LISTED ${file}`);

console.log(`Policy version:           ${manifest.policy_version ?? "not recorded"}`);
console.log(`Exported from commit:     ${manifest.source_commit ?? "unknown"} (a commit of the private application)`);
console.log(`Exported at:              ${manifest.exported_at ?? "unknown"}`);
console.log(`Signed production build:  ${manifest.signed_production_build ? "yes" : "no"}`);
console.log(`Files checked:            ${Object.keys(manifest.files).length}`);
if (problems.length) { console.error(`\n${problems.length} problem(s):\n${problems.join("\n")}`); process.exit(1); }
console.log("\nEvery listed file matches its recorded SHA-256 and nothing unlisted is present.");
