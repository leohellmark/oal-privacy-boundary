/** Release attestation for the separately published privacy boundary.
 * Usage: bun attest.ts create <built-worker-file> <manifest-file> <private-key-pem>
 *        bun attest.ts verify <built-worker-file> <manifest-file> <trusted-public-key-pem>
 * The trusted public key must be distributed independently of the manifest.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const boundaryRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(boundaryRoot, "../..");

function digest(bytes: Buffer | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() ? [path] : [];
  }).sort();
}

export function boundaryDigest() {
  const hash = createHash("sha256");
  for (const file of sourceFiles(boundaryRoot)) {
    hash.update(relative(boundaryRoot, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export type PrivacyManifest = {
  schema_version: 1;
  source_commit: string;
  boundary_sha256: string;
  build_sha256: string;
  signed_at: string;
};

export function signManifest(manifest: PrivacyManifest, privateKeyPem: string) {
  const bytes = Buffer.from(JSON.stringify(manifest));
  return sign(null, bytes, createPrivateKey(privateKeyPem)).toString("base64");
}

export function verifyManifest(manifest: PrivacyManifest, signature: string, publicKeyPem: string) {
  return verify(null, Buffer.from(JSON.stringify(manifest)), createPublicKey(publicKeyPem), Buffer.from(signature, "base64"));
}

if (import.meta.main) {
  const [mode, buildPath, manifestPath, keyPath] = process.argv.slice(2);
  if (!mode || !buildPath || !manifestPath || !keyPath || !["create", "verify"].includes(mode)) {
    throw new Error("Expected create|verify, build path, manifest path, and PEM key path.");
  }
  const buildSha = digest(readFileSync(resolve(buildPath)));
  if (mode === "create") {
    const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot, encoding: "utf8" }).trim();
    const manifest: PrivacyManifest = {
      schema_version: 1, source_commit: sourceCommit, boundary_sha256: boundaryDigest(),
      build_sha256: buildSha, signed_at: new Date().toISOString(),
    };
    const signature = signManifest(manifest, readFileSync(resolve(keyPath), "utf8"));
    writeFileSync(resolve(manifestPath), JSON.stringify({ manifest, signature }, null, 2) + "\n", { flag: "wx" });
    process.stdout.write(`${manifest.boundary_sha256}\n`);
  } else {
    const envelope = JSON.parse(readFileSync(resolve(manifestPath), "utf8")) as { manifest: PrivacyManifest; signature: string };
    if (envelope.manifest.boundary_sha256 !== boundaryDigest() || envelope.manifest.build_sha256 !== buildSha
      || !verifyManifest(envelope.manifest, envelope.signature, readFileSync(resolve(keyPath), "utf8"))) {
      throw new Error("Privacy attestation does not match the trusted key, boundary source, or deployed build.");
    }
    process.stdout.write(`Verified source ${envelope.manifest.source_commit}\n`);
  }
}
