-- admin_passwords table
CREATE TABLE IF NOT EXISTS public.admin_passwords (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.admin_passwords ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin_passwords_no_client" ON public.admin_passwords;
CREATE POLICY "admin_passwords_no_client" ON public.admin_passwords FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

-- chat_flag_audit table
CREATE TABLE IF NOT EXISTS public.chat_flag_audit (
  id bigserial PRIMARY KEY,
  flag_id bigint NOT NULL REFERENCES public.room_chat_flags(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('mute','ban','dismiss','warn')),
  admin_id uuid NOT NULL REFERENCES auth.users(id),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.chat_flag_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "chat_flag_audit_admin_read" ON public.chat_flag_audit;
CREATE POLICY "chat_flag_audit_admin_read" ON public.chat_flag_audit FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "chat_flag_audit_no_client_insert" ON public.chat_flag_audit;
CREATE POLICY "chat_flag_audit_no_client_insert" ON public.chat_flag_audit FOR INSERT TO anon, authenticated WITH CHECK (false);

-- Revoke execute on security definer functions
REVOKE EXECUTE ON FUNCTION public.set_account_links_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user_account_link() FROM PUBLIC, anon, authenticated;

-- Grant permissions
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT tablename FROM pg_tables WHERE schemaname='public' LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO anon, authenticated, service_role', r.tablename);
  END LOOP;
  FOR r IN SELECT sequence_name FROM information_schema.sequences WHERE sequence_schema='public' LOOP
    EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE public.%I TO anon, authenticated, service_role', r.sequence_name);
  END LOOP;
END$$;

-- Realtime for remaining tables
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.sala_chat; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.room_chat_flags; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.account_links; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
