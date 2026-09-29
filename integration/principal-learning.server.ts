import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { missingDatabaseColumn, missingDatabaseTable } from "@/lib/supabase-schema";
import { createHash } from "node:crypto";
import { consultationPolicy, exactQuoteSpan, preferenceSuggestion, type WorkPreferenceCategory } from "./principal-learning";
import { containsCredential } from "../../packages/oal-privacy-boundary/src/index";

const db = supabaseAdmin as unknown as { from: (table: string) => any };

export async function principalLearningAvailability(userId: string) {
  const { data, error } = await db.from("profiles")
    .select("principal_learning_enabled").eq("id", userId).maybeSingle();
  if (missingDatabaseColumn(error, "principal_learning_enabled")) return { available: false, enabled: false };
  if (error) throw new Error(error.message);
  return { available: true, enabled: data?.principal_learning_enabled === true };
}

export async function suggestPrincipalWorkPreference(input: {
  userId: string;
  workspaceId: string;
  directiveId: string;
  suggestion: unknown;
}) {
  const state = await principalLearningAvailability(input.userId);
  if (!state.available || !state.enabled) return { state: "disabled" as const };
  const suggestion = preferenceSuggestion.parse(input.suggestion);
  if (containsCredential(suggestion.statement) || containsCredential(suggestion.source_excerpt)) {
    return { state: "invalid_source" as const };
  }
  const { data: directive, error: directiveError } = await db.from("directives")
    .select("id").eq("id", input.directiveId).eq("workspace_id", input.workspaceId)
    .eq("user_id", input.userId).maybeSingle();
  if (directiveError || !directive) return { state: "invalid_source" as const };
  const { data: messages, error: messageError } = await db.from("orchestrator_messages")
    .select("id, role, content").eq("directive_id", input.directiveId).eq("role", "user")
    .order("created_at", { ascending: false }).limit(30);
  const message = (messages ?? []).find((candidate: { role: string; content: string }) =>
    candidate.role === "user" && String(candidate.content ?? "").includes(suggestion.source_excerpt));
  if (messageError || !message) {
    return { state: "invalid_source" as const };
  }
  const span = exactQuoteSpan(String(message.content ?? ""), suggestion.source_excerpt);
  if (!span) return { state: "invalid_source" as const };
  const { data: created, error } = await db.from("principal_work_preferences").insert({
    user_id: input.userId, workspace_id: input.workspaceId,
    category: suggestion.category, statement: suggestion.statement,
    origin: "agent_suggestion", source_message_id: message.id,
    source_offset: span.offset, source_length: span.length,
    source_sha256: createHash("sha256").update(suggestion.source_excerpt).digest("hex"),
    status: "candidate",
  }).select("id").single();
  if (missingDatabaseTable(error, "principal_work_preferences")) return { state: "disabled" as const };
  if (error?.code === "23505") return { state: "already_suggested" as const };
  if (error || !created) throw new Error(error?.message ?? "Could not save the preference suggestion.");
  return { state: "candidate" as const, id: created.id as string };
}

export async function consultPrincipalWorkPreferences(input: { userId: string; workspaceId: string }) {
  const state = await principalLearningAvailability(input.userId);
  if (!state.available || !state.enabled) return { state: "disabled" as const, preferences: [] };
  const { data, error } = await db.from("principal_work_preferences")
    .select("id, category, statement, origin, source_message_id, updated_at")
    .eq("user_id", input.userId).eq("workspace_id", input.workspaceId)
    .eq("status", "confirmed").order("updated_at", { ascending: false }).limit(25);
  if (missingDatabaseTable(error, "principal_work_preferences")) return { state: "disabled" as const, preferences: [] };
  if (error) throw new Error(error.message);
  const preferences = data ?? [];
  return { state: consultationPolicy(true, preferences.length), preferences };
}

export async function addPrincipalWorkPreference(input: {
  userId: string; workspaceId: string; category: WorkPreferenceCategory; statement: string;
}) {
  if (containsCredential(input.statement)) throw new Error("Credentials cannot be saved as work preferences.");
  const { data: workspace, error: ownerError } = await db.from("workspaces")
    .select("id").eq("id", input.workspaceId).eq("user_id", input.userId).maybeSingle();
  if (ownerError || !workspace) throw new Error("Mission not found.");
  const { data, error } = await db.from("principal_work_preferences").insert({
    user_id: input.userId, workspace_id: input.workspaceId,
    category: input.category, statement: input.statement,
    origin: "user_entry", source_message_id: null,
    status: "confirmed",
  }).select("id").single();
  if (error || !data) throw new Error(error?.message ?? "Could not save your work preference.");
  return data.id as string;
}
