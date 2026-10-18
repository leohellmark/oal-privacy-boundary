/**
 * Print what Oal declares it sends, and which Claude API paths it may call, as Markdown generated from the code itself, so the
 * documentation cannot drift from the source.
 *
 *   bun transfers.ts
 */
import { CLAUDE_ENDPOINTS, CREDENTIAL_SHAPES, DATA_TRANSFERS, PRIVACY_POLICY_VERSION } from "./src/index";

const cell = (text: string) => text.replaceAll("|", "\\|");
console.log(`# Declared transfers (policy version ${PRIVACY_POLICY_VERSION})\n`);
console.log("| Transfer | Destination | Purpose | Categories |\n| --- | --- | --- | --- |");
for (const [id, transfer] of Object.entries(DATA_TRANSFERS)) console.log(`| \`${id}\` | ${cell(transfer.destination)} | ${cell(transfer.purpose)} | ${cell(transfer.categories.join("; "))} |`);
console.log("\n# Claude API paths Oal may call\n");
console.log("| Request | Direction | Can carry |\n| --- | --- | --- |");
for (const endpoint of CLAUDE_ENDPOINTS) console.log(`| ${cell(endpoint.id)}: ${endpoint.methods.join(", ")} ${cell(endpoint.shown.split(", ").map(path => `\`${path}\``).join(", "))} | ${endpoint.direction} | ${endpoint.transfers.length ? endpoint.transfers.map(id => `\`${id}\``).join(", ") : "nothing the owner wrote"} |`);
console.log("\n# Credential shapes refused in conversation text and scrubbed from diagnostics\n");
for (const shape of CREDENTIAL_SHAPES) console.log(`- ${shape.name}`);
