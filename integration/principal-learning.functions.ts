import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { missingDatabaseTable } from "@/lib/supabase-schema";
import { addPrincipalWorkPreference, principalLearningAvailability } from "@/server/principal-learning.server";
import { quoteAtSpan, workPreferenceCategory } from "@/server/principal-learning";

const db = supabaseAdmin as unknown as { from: (table: string) => any };

export type PrincipalPreferenceRow = {
  id: string;
  workspace_id: string;
  category: string;
  statement: string;
  origin: "user_entry" | "agent_suggestion";
  source_excerpt: string | null;
  status: "candidate" | "confirmed" | "dismissed";
  created_at: string;
};

export const getPrincipalLearning = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const state = await principalLearningAvailability(context.userId);
    if (!state.available) return { ...state, workspaces: [], preferences: [] as PrincipalPreferenceRow[] };
    const workspaceResult = await context.supabase.from("workspaces")
      .select("id, name").eq("user_id", context.userId).is("archived_at", null)
      .order("created_at", { ascending: false });
    if (workspaceResult.error) throw new Error(workspaceResult.error.message);
    const preferences: PrincipalPreferenceRow[] = [];
    const sourceSpans: Array<{ preferenceId: string; messageId: string; offset: number; length: number }> = [];
    for (let offset = 0; ; offset += 500) {
      const page = await db.from("principal_work_preferences")
        .select("id, workspace_id, category, statement, origin, source_message_id, source_offset, source_length, status, created_at")
        .eq("user_id", context.userId).order("created_at", { ascending: false })
        .order("id", { ascending: false }).range(offset, offset + 499);
      if (missingDatabaseTable(page.error, "principal_work_preferences")) {
        return { available: false, enabled: false, workspaces: [], preferences: [] as PrincipalPreferenceRow[] };
      }
      if (page.error) throw new Error(page.error.message);
      for (const row of page.data ?? []) {
        preferences.push({
          id: row.id, workspace_id: row.workspace_id, category: row.category,
          statement: row.statement, origin: row.origin, source_excerpt: null,
          status: row.status, created_at: row.created_at,
        });
        if (row.source_message_id && row.source_offset != null && row.source_length != null) {
          sourceSpans.push({ preferenceId: row.id, messageId: row.source_message_id,
            offset: row.source_offset, length: row.source_length });
        }
      }
      if ((page.data ?? []).length < 500) break;
    }
    const byId = new Map(preferences.map((preference) => [preference.id, preference]));
    for (let offset = 0; offset < sourceSpans.length; offset += 500) {
      const batch = sourceSpans.slice(offset, offset + 500);
      const { data: messages, error } = await db.from("orchestrator_messages")
        .select("id, content").in("id", batch.map((source) => source.messageId));
      if (error) throw new Error(error.message);
      const contentById = new Map((messages ?? []).map((message: { id: string; content: string }) => [message.id, message.content]));
      for (const source of batch) {
        const content = contentById.get(source.messageId);
        const preference = byId.get(source.preferenceId);
        if (typeof content === "string" && preference) {
          preference.source_excerpt = quoteAtSpan(content, source.offset, source.length);
        }
      }
    }
    return { ...state, workspaces: workspaceResult.data ?? [], preferences };
  });

export const setPrincipalLearningEnabled = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => z.object({ enabled: z.boolean() }).parse(raw))
  .handler(async ({ data, context }) => {
    const state = await principalLearningAvailability(context.userId);
    if (!state.available) throw new Error("Personal learning is available after the database update.");
    const { error } = await db.from("profiles").update({ principal_learning_enabled: data.enabled }).eq("id", context.userId);
    if (error) throw new Error(error.message);
    return { enabled: data.enabled };
  });

export const addMyWorkPreference = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => z.object({
    workspace_id: z.string().uuid(), category: workPreferenceCategory,
    statement: z.string().trim().min(12).max(400),
  }).parse(raw))
  .handler(async ({ data, context }) => {
    const state = await principalLearningAvailability(context.userId);
    if (!state.enabled) throw new Error("Turn on personal learning first.");
    const id = await addPrincipalWorkPreference({
      userId: context.userId, workspaceId: data.workspace_id,
      category: data.category, statement: data.statement,
    });
    return { id };
  });

export const reviewMyWorkPreference = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => z.object({
    id: z.string().uuid(), decision: z.enum(["confirm", "dismiss"]),
  }).parse(raw))
  .handler(async ({ data, context }) => {
    if (data.decision === "confirm" && !(await principalLearningAvailability(context.userId)).enabled) {
      throw new Error("Turn on personal learning before confirming a suggestion.");
    }
    const status = data.decision === "confirm" ? "confirmed" : "dismissed";
    const { data: row, error } = await db.from("principal_work_preferences")
      .update({ status }).eq("id", data.id).eq("user_id", context.userId)
      .eq("origin", "agent_suggestion").eq("status", "candidate").select("id").maybeSingle();
    if (error) throw new Error(error.message);
    return { ok: Boolean(row) };
  });

export const deleteMyWorkPreference = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((raw: unknown) => z.object({ id: z.string().uuid() }).parse(raw))
  .handler(async ({ data, context }) => {
    const { error } = await db.from("principal_work_preferences").delete()
      .eq("id", data.id).eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const clearMyWorkPreferences = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { error } = await db.from("principal_work_preferences").delete().eq("user_id", context.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
