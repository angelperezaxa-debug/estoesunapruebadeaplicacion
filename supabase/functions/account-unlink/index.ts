// Edge function: account-unlink
//
// Permet a un usuari autenticat trencar la vinculació entre el seu compte
// (auth.users) i el `device_id` local, conservant tot el progrés del
// dispositiu (que viu a `player_profiles` indexat per `device_id`).
//
// - Esborra la fila de `account_links` corresponent a `auth.uid()`.
// - NO toca `player_profiles` ni cap altra dada del joc.
// - NO esborra el compte de auth (per fer-ho hi ha `delete-account`).
// - El client, després d'un OK, hauria de fer `supabase.auth.signOut()`.
//
// Resposta:
//   { ok: true, removed: number }   — files esborrades (0 o 1)
//   { ok: false, error: string }    — en cas d'error

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { ok: false, error: "Method not allowed" });
  }

  // Verifiquem el JWT del usuari fent servir la clau anònima + el bearer
  // de la petició; si auth.getUser() retorna usuari, el token és vàlid.
  const authHeader = req.headers.get("Authorization") ?? "";
  if (!authHeader.toLowerCase().startsWith("bearer ")) {
    return jsonResponse(401, { ok: false, error: "Missing bearer token" });
  }

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) {
    return jsonResponse(401, { ok: false, error: "Invalid session" });
  }
  const userId = userData.user.id;

  // Esborrem la vinculació amb service role (RLS bloqueja DELETE des del client).
  const { error: delErr, count } = await admin
    .from("account_links")
    .delete({ count: "exact" })
    .eq("user_id", userId);

  if (delErr) {
    return jsonResponse(500, { ok: false, error: delErr.message });
  }

  return jsonResponse(200, { ok: true, removed: count ?? 0 });
});
