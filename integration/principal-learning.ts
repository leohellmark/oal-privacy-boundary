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

export type WorkPreferenceCategory = z.infer<typeof workPreferenceCategory>;

/** Candidate statements are untrusted until the principal confirms them.
 * This function intentionally does not infer mood, mental state, or future
 * desires from a message: the model cannot observe any of those directly. */
export function consultationPolicy(enabled: boolean, confirmedCount: number) {
  if (!enabled) return "disabled" as const;
  if (confirmedCount === 0) return "no_confirmed_preferences" as const;
  return "advisory_only" as const;
}
