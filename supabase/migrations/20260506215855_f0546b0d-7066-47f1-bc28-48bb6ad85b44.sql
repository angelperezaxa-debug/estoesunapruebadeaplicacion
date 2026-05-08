-- Drop dependent table first
DROP TABLE IF EXISTS public.chat_flag_audit CASCADE;

-- Recreate room_chat_flags with correct schema
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
DO $$ BEGIN ALTER PUBLICATION supabase_realtime ADD TABLE public.room_chat_flags; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
