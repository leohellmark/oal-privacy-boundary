import { z } from "zod";

export const workPreferenceCategory = z.enum([
  "planning", "communication", "design", "research", "review", "autonomy", "other",
]);

export const preferenceSuggestion = z.object({
  source_excerpt: z.string().trim().min(10).max(500),
  category: workPreferenceCategory,
  statement: z.string().trim().min(12).max(400),
}).strict();

export function validatesQuotedPreference(message: { role: string; content: string }, quote: string) {
  return message.role === "user" && message.content.includes(quote);
}

/** PostgreSQL substring positions count Unicode code points, while JS string
 * offsets count UTF-16 units. Keep the provenance span portable across both. */
export function exactQuoteSpan(content: string, quote: string) {
  const index = content.indexOf(quote);
  if (index < 0) return null;
  return { offset: Array.from(content.slice(0, index)).length, length: Array.from(quote).length };
}

export function quoteAtSpan(content: string, offset: number, length: number) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) return null;
  return Array.from(content).slice(offset, offset + length).join("");
}

export type WorkPreferenceCategory = z.infer<typeof workPreferenceCategory>;

/** Candidate statements are untrusted until the principal confirms them.
 * This function intentionally does not infer mood, mental state, or future
 * desires from a message: the model cannot observe any of those directly. */
export function consultationPolicy(enabled: boolean, confirmedCount: number) {
  if (!enabled) return "disabled" as const;
  if (confirmedCount === 0) return "no_confirmed_preferences" as const;
  return "advisory_only" as const;
}
