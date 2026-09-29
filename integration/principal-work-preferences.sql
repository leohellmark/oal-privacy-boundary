-- A user-controlled, application-owned work preference store. Claude's
-- writable mission memory is deliberately not the authority for these rows.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS principal_learning_enabled boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.principal_work_preferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  category text NOT NULL CHECK (category IN ('planning', 'communication', 'design', 'research', 'review', 'autonomy', 'other')),
  statement text NOT NULL CHECK (length(statement) BETWEEN 12 AND 400),
  origin text NOT NULL CHECK (origin IN ('user_entry', 'agent_suggestion')),
  source_message_id uuid REFERENCES public.orchestrator_messages(id) ON DELETE CASCADE,
  source_offset integer,
  source_length integer,
  source_sha256 text,
  status text NOT NULL CHECK (status IN ('candidate', 'confirmed', 'dismissed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT principal_preference_origin CHECK (
    (origin = 'user_entry' AND source_message_id IS NULL AND source_offset IS NULL
      AND source_length IS NULL AND source_sha256 IS NULL AND status = 'confirmed')
    OR (origin = 'agent_suggestion' AND source_message_id IS NOT NULL
      AND source_offset IS NOT NULL AND source_offset >= 0
      AND source_length IS NOT NULL AND source_length BETWEEN 10 AND 500
      AND source_sha256 IS NOT NULL AND source_sha256 ~ '^[0-9a-f]{64}$')
  ),
  UNIQUE (user_id, workspace_id, source_message_id, statement)
);
CREATE INDEX IF NOT EXISTS principal_work_preferences_owner_idx
  ON public.principal_work_preferences(user_id, workspace_id, status, created_at DESC);

CREATE OR REPLACE FUNCTION public.guard_principal_work_preference()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_message record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.workspaces w
    WHERE w.id = NEW.workspace_id AND w.user_id = NEW.user_id) THEN
    RAISE EXCEPTION 'Preference workspace does not belong to this user';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF (NEW.user_id, NEW.workspace_id, NEW.category, NEW.statement, NEW.origin,
        NEW.source_message_id, NEW.source_offset, NEW.source_length, NEW.source_sha256) IS DISTINCT FROM
       (OLD.user_id, OLD.workspace_id, OLD.category, OLD.statement, OLD.origin,
        OLD.source_message_id, OLD.source_offset, OLD.source_length, OLD.source_sha256)
       OR (OLD.status <> 'candidate' AND NEW.status IS DISTINCT FROM OLD.status)
       OR (OLD.origin = 'user_entry' AND NEW.status IS DISTINCT FROM OLD.status) THEN
      RAISE EXCEPTION 'Saved preference provenance and confirmed values are immutable; delete and add a correction';
    END IF;
  END IF;
  IF NEW.origin = 'agent_suggestion' THEN
    IF (TG_OP = 'INSERT' OR NEW.status = 'confirmed') AND NOT EXISTS (SELECT 1 FROM public.profiles p
      WHERE p.id = NEW.user_id AND p.principal_learning_enabled) THEN
      RAISE EXCEPTION 'Principal learning is disabled';
    END IF;
    IF TG_OP = 'INSERT' AND NEW.status <> 'candidate' THEN
      RAISE EXCEPTION 'Agent suggestions must await user review';
    END IF;
    SELECT m.role, m.content, d.workspace_id, d.user_id INTO v_message
      FROM public.orchestrator_messages m
      JOIN public.directives d ON d.id = m.directive_id
      WHERE m.id = NEW.source_message_id;
    IF v_message.role IS DISTINCT FROM 'user'
      OR v_message.workspace_id IS DISTINCT FROM NEW.workspace_id
      OR v_message.user_id IS DISTINCT FROM NEW.user_id
      OR NEW.source_offset + NEW.source_length > length(v_message.content)
      OR encode(sha256(convert_to(substring(v_message.content from NEW.source_offset + 1
        for NEW.source_length), 'UTF8')), 'hex') IS DISTINCT FROM NEW.source_sha256 THEN
      RAISE EXCEPTION 'Suggested preference lacks the cited user message';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_principal_work_preference ON public.principal_work_preferences;
CREATE TRIGGER guard_principal_work_preference BEFORE INSERT OR UPDATE
  ON public.principal_work_preferences FOR EACH ROW EXECUTE FUNCTION public.guard_principal_work_preference();

ALTER TABLE public.principal_work_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY principal_work_preferences_owner_read ON public.principal_work_preferences
  FOR SELECT TO authenticated USING (user_id = auth.uid() AND EXISTS (
    SELECT 1 FROM public.workspaces w WHERE w.id = workspace_id AND w.user_id = auth.uid()
  ));
GRANT SELECT ON public.principal_work_preferences TO authenticated;
GRANT ALL ON public.principal_work_preferences TO service_role;
NOTIFY pgrst, 'reload schema';
