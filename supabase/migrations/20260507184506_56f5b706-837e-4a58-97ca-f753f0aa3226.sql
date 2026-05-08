-- Combined migrations from original Truc project
DO $$ BEGIN
  CREATE TYPE public.room_status AS ENUM ('lobby', 'playing', 'finished', 'abandoned');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.seat_kind AS ENUM ('human', 'bot', 'empty');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  status public.room_status NOT NULL DEFAULT 'lobby',
  target_cames INTEGER NOT NULL DEFAULT 2 CHECK (target_cames BETWEEN 1 AND 5),
  initial_mano SMALLINT NOT NULL DEFAULT 0 CHECK (initial_mano BETWEEN 0 AND 3),
  seat_kinds public.seat_kind[] NOT NULL,
  host_device TEXT NOT NULL,
  match_state JSONB,
  bot_intents JSONB NOT NULL DEFAULT '{}'::jsonb,
  turn_started_at timestamptz,
  paused_at timestamptz,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS target_cama integer NOT NULL DEFAULT 12;
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS turn_timeout_sec integer NOT NULL DEFAULT 30;
ALTER TABLE public.rooms ADD COLUMN IF NOT EXISTS pending_proposal jsonb;
ALTER TABLE public.rooms DROP CONSTRAINT IF EXISTS rooms_target_cama_chk;
ALTER TABLE public.rooms ADD CONSTRAINT rooms_target_cama_chk CHECK (target_cama IN (9, 12));
ALTER TABLE public.rooms DROP CONSTRAINT IF EXISTS rooms_turn_timeout_sec_chk;
ALTER TABLE public.rooms ADD CONSTRAINT rooms_turn_timeout_sec_chk CHECK (turn_timeout_sec IN (15, 30, 45, 60));

CREATE INDEX IF NOT EXISTS rooms_code_idx ON public.rooms (code);
CREATE INDEX IF NOT EXISTS rooms_status_idx ON public.rooms (status);

CREATE TABLE IF NOT EXISTS public.room_players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  seat SMALLINT NOT NULL CHECK (seat BETWEEN 0 AND 3),
  device_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 24),
  is_online BOOLEAN NOT NULL DEFAULT TRUE,
  last_seen TIMESTAMPTZ NOT NULL DEFAULT now(),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (room_id, seat)
);
CREATE INDEX IF NOT EXISTS room_players_room_idx ON public.room_players (room_id);
CREATE INDEX IF NOT EXISTS room_players_device_idx ON public.room_players (device_id);

CREATE TABLE IF NOT EXISTS public.room_actions (
  id BIGSERIAL PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  seat SMALLINT NOT NULL CHECK (seat BETWEEN 0 AND 3),
  action JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS room_actions_room_idx ON public.room_actions (room_id, id);

CREATE TABLE IF NOT EXISTS public.room_chat (
  id bigserial PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  seat smallint NOT NULL,
  phrase_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS room_chat_room_idx ON public.room_chat(room_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.room_text_chat (
  id BIGSERIAL PRIMARY KEY,
  room_id UUID NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  seat SMALLINT NOT NULL CHECK (seat >= 0 AND seat <= 3),
  device_id TEXT NOT NULL,
  text TEXT NOT NULL CHECK (char_length(text) > 0 AND char_length(text) <= 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_room_text_chat_room_created ON public.room_text_chat(room_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.player_profiles (
  device_id text PRIMARY KEY,
  games_played integer NOT NULL DEFAULT 0,
  envit_called integer NOT NULL DEFAULT 0,
  envit_called_bluff integer NOT NULL DEFAULT 0,
  envit_accepted integer NOT NULL DEFAULT 0,
  envit_rejected integer NOT NULL DEFAULT 0,
  truc_called integer NOT NULL DEFAULT 0,
  truc_called_bluff integer NOT NULL DEFAULT 0,
  truc_accepted integer NOT NULL DEFAULT 0,
  truc_rejected integer NOT NULL DEFAULT 0,
  envit_strength_sum integer NOT NULL DEFAULT 0,
  envit_strength_n integer NOT NULL DEFAULT 0,
  truc_strength_sum integer NOT NULL DEFAULT 0,
  truc_strength_n integer NOT NULL DEFAULT 0,
  aggressiveness real NOT NULL DEFAULT 0.5,
  bluff_rate real NOT NULL DEFAULT 0.15,
  accept_threshold real NOT NULL DEFAULT 0.5,
  bot_difficulty text NOT NULL DEFAULT 'conservative' CHECK (bot_difficulty IN ('conservative', 'balanced', 'aggressive')),
  bot_honesty text NOT NULL DEFAULT 'sincero',
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.player_profiles DROP CONSTRAINT IF EXISTS player_profiles_bot_honesty_check;
ALTER TABLE public.player_profiles ADD CONSTRAINT player_profiles_bot_honesty_check CHECK (bot_honesty IN ('sincero', 'pillo', 'mentider'));

COMMENT ON COLUMN public.rooms.pending_proposal IS
  'Propuesta colectiva en curso (pause/restart). Estructura: { kind: "pause"|"restart", proposerSeat: int, proposerName: text, createdAt: iso, expiresAt: iso, votes: { [seat]: "accepted"|"rejected"|"pending" } }';

ALTER TABLE public.rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_players ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_chat ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.room_text_chat ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.player_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "rooms_public_read" ON public.rooms;
CREATE POLICY "rooms_public_read" ON public.rooms FOR SELECT USING (true);
DROP POLICY IF EXISTS "room_players_public_read" ON public.room_players;
CREATE POLICY "room_players_public_read" ON public.room_players FOR SELECT USING (true);
DROP POLICY IF EXISTS "room_actions_public_read" ON public.room_actions;
CREATE POLICY "room_actions_public_read" ON public.room_actions FOR SELECT USING (true);
DROP POLICY IF EXISTS "room_chat_public_read" ON public.room_chat;
CREATE POLICY "room_chat_public_read" ON public.room_chat FOR SELECT USING (true);
DROP POLICY IF EXISTS "room_text_chat_public_read" ON public.room_text_chat;
CREATE POLICY "room_text_chat_public_read" ON public.room_text_chat FOR SELECT USING (true);
DROP POLICY IF EXISTS "player_profiles_public_read" ON public.player_profiles;
CREATE POLICY "player_profiles_public_read" ON public.player_profiles FOR SELECT USING (true);

DROP POLICY IF EXISTS "rooms_no_client_insert" ON public.rooms;
CREATE POLICY "rooms_no_client_insert" ON public.rooms FOR INSERT TO anon, authenticated WITH CHECK (false);
DROP POLICY IF EXISTS "rooms_no_client_update" ON public.rooms;
CREATE POLICY "rooms_no_client_update" ON public.rooms FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "rooms_no_client_delete" ON public.rooms;
CREATE POLICY "rooms_no_client_delete" ON public.rooms FOR DELETE TO anon, authenticated USING (false);

DROP POLICY IF EXISTS "room_players_no_client_insert" ON public.room_players;
CREATE POLICY "room_players_no_client_insert" ON public.room_players FOR INSERT TO anon, authenticated WITH CHECK (false);
DROP POLICY IF EXISTS "room_players_no_client_update" ON public.room_players;
CREATE POLICY "room_players_no_client_update" ON public.room_players FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "room_players_no_client_delete" ON public.room_players;
CREATE POLICY "room_players_no_client_delete" ON public.room_players FOR DELETE TO anon, authenticated USING (false);

DROP POLICY IF EXISTS "room_actions_no_client_insert" ON public.room_actions;
CREATE POLICY "room_actions_no_client_insert" ON public.room_actions FOR INSERT TO anon, authenticated WITH CHECK (false);
DROP POLICY IF EXISTS "room_actions_no_client_update" ON public.room_actions;
CREATE POLICY "room_actions_no_client_update" ON public.room_actions FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "room_actions_no_client_delete" ON public.room_actions;
CREATE POLICY "room_actions_no_client_delete" ON public.room_actions FOR DELETE TO anon, authenticated USING (false);

DROP POLICY IF EXISTS "room_chat_no_client_insert" ON public.room_chat;
CREATE POLICY "room_chat_no_client_insert" ON public.room_chat FOR INSERT TO anon, authenticated WITH CHECK (false);
DROP POLICY IF EXISTS "room_chat_no_client_update" ON public.room_chat;
CREATE POLICY "room_chat_no_client_update" ON public.room_chat FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "room_chat_no_client_delete" ON public.room_chat;
CREATE POLICY "room_chat_no_client_delete" ON public.room_chat FOR DELETE TO anon, authenticated USING (false);

DROP POLICY IF EXISTS "room_text_chat_no_client_insert" ON public.room_text_chat;
CREATE POLICY "room_text_chat_no_client_insert" ON public.room_text_chat FOR INSERT TO anon, authenticated WITH CHECK (false);
DROP POLICY IF EXISTS "room_text_chat_no_client_update" ON public.room_text_chat;
CREATE POLICY "room_text_chat_no_client_update" ON public.room_text_chat FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "room_text_chat_no_client_delete" ON public.room_text_chat;
CREATE POLICY "room_text_chat_no_client_delete" ON public.room_text_chat FOR DELETE TO anon, authenticated USING (false);

DROP POLICY IF EXISTS "player_profiles_no_client_insert" ON public.player_profiles;
CREATE POLICY "player_profiles_no_client_insert" ON public.player_profiles FOR INSERT TO anon, authenticated WITH CHECK (false);
DROP POLICY IF EXISTS "player_profiles_no_client_update" ON public.player_profiles;
CREATE POLICY "player_profiles_no_client_update" ON public.player_profiles FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "player_profiles_no_client_delete" ON public.player_profiles;
CREATE POLICY "player_profiles_no_client_delete" ON public.player_profiles FOR DELETE TO anon, authenticated USING (false);

DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.rooms; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.room_players; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.room_actions; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.room_chat; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.room_text_chat; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- account_deletion_requests
CREATE TABLE IF NOT EXISTS public.account_deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  device_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','completed','failed')),
  reason text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  error_message text
);
ALTER TABLE public.account_deletion_requests ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "account_deletion_requests_self_select" ON public.account_deletion_requests;
CREATE POLICY "account_deletion_requests_self_select" ON public.account_deletion_requests FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "account_deletion_requests_self_insert" ON public.account_deletion_requests;
CREATE POLICY "account_deletion_requests_self_insert" ON public.account_deletion_requests FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);

-- sala_chat
CREATE TABLE IF NOT EXISTS public.sala_chat (
  id bigserial PRIMARY KEY,
  sala_slug text NOT NULL,
  device_id text NOT NULL,
  name text NOT NULL,
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sala_chat_slug ON public.sala_chat(sala_slug, created_at DESC);
ALTER TABLE public.sala_chat ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "sala_chat_public_read" ON public.sala_chat;
CREATE POLICY "sala_chat_public_read" ON public.sala_chat FOR SELECT USING (true);
DROP POLICY IF EXISTS "sala_chat_public_insert" ON public.sala_chat;
CREATE POLICY "sala_chat_public_insert" ON public.sala_chat FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS "sala_chat_no_client_update" ON public.sala_chat;
CREATE POLICY "sala_chat_no_client_update" ON public.sala_chat FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
DROP POLICY IF EXISTS "sala_chat_no_client_delete" ON public.sala_chat;
CREATE POLICY "sala_chat_no_client_delete" ON public.sala_chat FOR DELETE TO anon, authenticated USING (false);

-- account_links
CREATE TABLE IF NOT EXISTS public.account_links (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  device_id TEXT,
  email TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS account_links_device_idx ON public.account_links(device_id);
CREATE INDEX IF NOT EXISTS account_links_email_idx ON public.account_links(email);
ALTER TABLE public.account_links ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "account_links_self_select" ON public.account_links;
CREATE POLICY "account_links_self_select" ON public.account_links FOR SELECT TO authenticated USING (auth.uid() = user_id);
DROP POLICY IF EXISTS "account_links_self_update" ON public.account_links;
CREATE POLICY "account_links_self_update" ON public.account_links FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
DROP POLICY IF EXISTS "account_links_no_client_insert" ON public.account_links;
CREATE POLICY "account_links_no_client_insert" ON public.account_links FOR INSERT TO anon, authenticated WITH CHECK (false);
DROP POLICY IF EXISTS "account_links_no_client_delete" ON public.account_links;
CREATE POLICY "account_links_no_client_delete" ON public.account_links FOR DELETE TO anon, authenticated USING (false);

CREATE OR REPLACE FUNCTION public.set_account_links_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$;
DROP TRIGGER IF EXISTS trg_account_links_updated_at ON public.account_links;
CREATE TRIGGER trg_account_links_updated_at BEFORE UPDATE ON public.account_links FOR EACH ROW EXECUTE FUNCTION public.set_account_links_updated_at();

CREATE OR REPLACE FUNCTION public.handle_new_user_account_link()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.account_links (user_id, email, device_id)
  VALUES (NEW.id, NEW.email, NULLIF(NEW.raw_user_meta_data->>'device_id', ''))
  ON CONFLICT (user_id) DO UPDATE SET
    email = EXCLUDED.email,
    device_id = COALESCE(EXCLUDED.device_id, public.account_links.device_id),
    updated_at = now();
  RETURN NEW;
END; $$;
DROP TRIGGER IF EXISTS on_auth_user_created_link ON auth.users;
CREATE TRIGGER on_auth_user_created_link AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_account_link();

-- room_chat_flags (final schema)
DROP TABLE IF EXISTS public.chat_flag_audit CASCADE;
DROP TABLE IF EXISTS public.room_chat_flags CASCADE;
CREATE TABLE public.room_chat_flags (
  id BIGSERIAL PRIMARY KEY,
  room_id UUID NOT NULL,
  target_seat SMALLINT NOT NULL,
  target_device_id TEXT NOT NULL,
  reporter_device_id TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'dismissed')),
  decided_at TIMESTAMP WITH TIME ZONE,
  decided_by TEXT,
  message_text TEXT,
  message_id BIGINT,
  UNIQUE (room_id, target_device_id, reporter_device_id)
);
CREATE INDEX IF NOT EXISTS idx_room_chat_flags_room ON public.room_chat_flags(room_id);
CREATE INDEX IF NOT EXISTS idx_room_chat_flags_target ON public.room_chat_flags(target_device_id);
CREATE INDEX IF NOT EXISTS idx_room_chat_flags_status ON public.room_chat_flags(status);
ALTER TABLE public.room_chat_flags ENABLE ROW LEVEL SECURITY;
CREATE POLICY "room_chat_flags_public_read" ON public.room_chat_flags FOR SELECT USING (true);
CREATE POLICY "room_chat_flags_public_insert" ON public.room_chat_flags FOR INSERT WITH CHECK (true);
CREATE POLICY "room_chat_flags_no_client_update" ON public.room_chat_flags FOR UPDATE TO anon, authenticated USING (false) WITH CHECK (false);
CREATE POLICY "room_chat_flags_no_client_delete" ON public.room_chat_flags FOR DELETE TO anon, authenticated USING (false);

-- admin_passwords
CREATE TABLE IF NOT EXISTS public.admin_passwords (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.admin_passwords ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "admin_passwords_no_client" ON public.admin_passwords;
CREATE POLICY "admin_passwords_no_client" ON public.admin_passwords FOR ALL TO anon, authenticated USING (false) WITH CHECK (false);

-- chat_flag_audit
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

REVOKE EXECUTE ON FUNCTION public.set_account_links_updated_at() FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.handle_new_user_account_link() FROM PUBLIC, anon, authenticated;

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

DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.sala_chat; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.room_chat_flags; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.account_links; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
