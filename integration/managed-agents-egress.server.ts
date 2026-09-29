import Anthropic from "@anthropic-ai/sdk";
import { auditedClaudeFetch } from "../../packages/oal-privacy-boundary/src/index";

/** Single construction point for Oal's Managed Agents SDK transport. */
export function managedAgentsClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY missing");
  return new Anthropic({ apiKey, fetch: auditedClaudeFetch(fetch) });
}

export function managedAgentsWebhookClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const webhookKey = process.env.ANTHROPIC_WEBHOOK_SIGNING_KEY;
  if (!apiKey || !webhookKey) throw new Error("Anthropic webhook is not configured");
  return new Anthropic({ apiKey, webhookKey, fetch: auditedClaudeFetch(fetch) });
}
