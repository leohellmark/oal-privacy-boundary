/**
 * Public, dependency-free boundary for data Oal itself sends to providers.
 * This does not describe data a provider obtains through a user-authorised
 * repository mount or an agent's own tools. Those surfaces need separate
 * disclosure and network controls.
 */
export const PRIVACY_POLICY_VERSION = "2026-09-29.3";

export const DATA_TRANSFERS = {
  claude_message: {
    destination: "Anthropic Managed Agents",
    purpose: "Work on the user's selected goal",
    categories: ["message text", "opaque run identifier"],
  },
  claude_agent_configuration: {
    destination: "Anthropic Managed Agents",
    purpose: "Configure the coordinator and task-specific specialists",
    categories: ["goal description", "agent instructions", "selected tools", "opaque workspace references", "session budget"],
  },
  claude_tool_result: {
    destination: "Anthropic Managed Agents",
    purpose: "Return the observed result of an approved tool call",
    categories: ["tool output", "opaque tool call identifier"],
  },
  principal_work_preference: {
    destination: "Anthropic Managed Agents",
    purpose: "Advise the Secretary on a work choice in the same selected mission, only when the user enables personal learning",
    categories: ["user-confirmed work preference", "preference category", "opaque preference identifier"],
  },
  github_repository: {
    destination: "GitHub and the Anthropic session sandbox",
    purpose: "Read and improve a repository selected by the user",
    categories: ["repository URL", "repository content", "short-lived installation token"],
  },
} as const;

export function claudeUserMessage(input: { text: string; runId: string }) {
  const text = input.text.trim();
  if (!text || text.length > 100_000) throw new Error("Message size is outside the allowed range.");
  if (!/^[0-9a-f-]{36}$/i.test(input.runId)) throw new Error("Invalid run identifier.");
  if (SECRET_TEXT_TEST.test(text) || /\bBearer\s+[A-Za-z0-9._~-]{20,}\b/i.test(text)) {
    throw new Error("Credentials must be connected securely; do not include them in the message.");
  }
  return {
    type: "user.message" as const,
    content: [{ type: "text" as const, text: `[OAL_RUN_ID:${input.runId}]\n${text}` }],
  };
}

const SECRET_KEY = /(?:authorization|cookie|password|passwd|secret|token|credential|private[_-]?key|access[_-]?key|api[_-]?key)/i;
const SECRET_TEXT_TEST = /\b(?:sk-ant-|sk-|ghp_|ghs_|ghu_|gho_|github_pat_|whsec_)[A-Za-z0-9_-]{12,}\b/i;
const SECRET_TEXT = /\b(?:sk-ant-|sk-|ghp_|ghs_|ghu_|gho_|github_pat_|whsec_)[A-Za-z0-9_-]{12,}\b/gi;

export function containsCredential(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (typeof value === "string") return SECRET_TEXT_TEST.test(value) || /\bBearer\s+[A-Za-z0-9._~-]{20,}\b/i.test(value);
  if (Array.isArray(value)) return value.some((item) => containsCredential(item, depth + 1));
  if (value && typeof value === "object") return Object.values(value as Record<string, unknown>)
    .some((item) => containsCredential(item, depth + 1));
  return false;
}

/** All SDK clients use this transport. It permits only Claude's API host and
 * refuses credential-shaped values in conversation events, including tool
 * results. Repository mount tokens travel in session resource fields instead.
 * This is an application egress check, not a claim about provider internals. */
export function auditedClaudeFetch(upstream: typeof fetch): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.protocol !== "https:" || url.hostname !== "api.anthropic.com" || url.port) {
      throw new Error("Claude SDK request is outside Oal's declared provider destination.");
    }
    if (request.method === "POST" && /\/v1\/sessions\/[^/]+\/events$/.test(url.pathname)) {
      let body: unknown;
      try { body = await request.clone().json(); }
      catch { throw new Error("Claude session events must use inspectable JSON."); }
      const events = (body as { events?: unknown })?.events;
      if (!Array.isArray(events)) throw new Error("Claude session events must be an array.");
      for (const event of events) {
        const entry = event as { type?: string; content?: unknown };
        if ((entry?.type === "user.message" || entry?.type === "user.custom_tool_result") && containsCredential(entry.content)) {
          throw new Error("Credentials must be connected securely; they cannot be sent in conversation events.");
        }
      }
    }
    return upstream(request);
  };
}

/** Scrub diagnostics before persistence. Raw user messages are stored only in
 * their owner-scoped conversation, never in diagnostic payloads. */
export function redactDiagnostics(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[nested value omitted]";
  if (typeof value === "string") return value.replace(SECRET_TEXT, "[redacted]").slice(0, 24_000);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redactDiagnostics(item, depth + 1));
  if (typeof value === "object") return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      SECRET_KEY.test(key) ? "[redacted]" : redactDiagnostics(entry, depth + 1),
    ]),
  );
  return "[unsupported value]";
}
