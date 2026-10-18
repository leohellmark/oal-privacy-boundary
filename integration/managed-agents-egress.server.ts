import { deadlineAwareFetch, hasProviderDeadline } from "./provider-request-deadline";
import Anthropic from "@anthropic-ai/sdk";
import { auditedClaudeFetch } from "../../packages/oal-privacy-boundary/src/index";
import { traceContextFetch } from "./trace-context";
import { federationCredentials, federationKey, providerApiKey, webhookSigningKey } from "./anthropic-identity.server";

export { managedAgentsAuthenticationConfigured } from "./anthropic-identity.server";

const PROVIDER_BASE_URL = "https://api.anthropic.com";

// SDK clients cache and refresh access tokens, coalescing concurrent exchanges.
// Separate deadline clients preserve bounded recovery retries. No user data is cached.
let federated: { key: string; normal?: Anthropic; bounded?: Anthropic } | undefined;

/** Single construction point for Oal's Managed Agents SDK transport. */
export function managedAgentsClient() {
  // OAL_STRICT_EGRESS=1 also refuses any Claude API path that is not in the boundary's declared endpoint list.
  const transport = deadlineAwareFetch(auditedClaudeFetch(traceContextFetch(fetch), { strict: process.env.OAL_STRICT_EGRESS === "1" }));
  const key = federationKey();
  const bounded = hasProviderDeadline();
  if (key) {
    if (federated?.key !== key) federated = { key };
    const slot = bounded ? "bounded" : "normal";
    if (!federated[slot]) {
      federated[slot] = new Anthropic({
        apiKey: null, authToken: null, credentials: federationCredentials(transport, PROVIDER_BASE_URL), fetch: transport,
        baseURL: PROVIDER_BASE_URL, ...(bounded ? { maxRetries: 0 } : {}),
      });
    }
    return federated[slot]!;
  }
  return new Anthropic({ apiKey: providerApiKey(), fetch: transport, ...(bounded ? { maxRetries: 0 } : {}) });
}

export function managedAgentsWebhookClient() {
  // Signature verification is local and needs no API key or token exchange.
  return new Anthropic({ apiKey: null, authToken: null, webhookKey: webhookSigningKey(),
    fetch: auditedClaudeFetch(traceContextFetch(fetch), { strict: process.env.OAL_STRICT_EGRESS === "1" }) });
}
