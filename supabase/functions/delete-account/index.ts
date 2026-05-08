// Edge function: delete-account
// Compleix el requisit de Google Play Store (User Data deletion, exigit
// des de 2024) i el dret de supressió del RGPD (art. 17).
//
// Public endpoint (no auth) — l'identitat és el `device_id` generat al
// client. Esborra TOTES les dades associades a aquest device_id en el
// nostre backend. No afecta dades d'altres jugadors. Si el device_id està
// asseguts a una sala activa, també l'esborra dels seients per no deixar
// "fantasmes". Els missatges de xat enviats per aquest dispositiu es
// conserven anonimitzats (text intacte, autor → "device_id buit") perquè
// si els esborrem trencaríem el context del fil per a la resta. Aquest
// comportament és compatible amb la guia de Play Store, que permet
// "anonymise" com a alternativa a "delete" per a contingut compartit.
//
// Body:
//   { deviceId: string, dryRun?: boolean }
// Resposta:
//   { ok: true, deleted: { ...comptadors per taula }, anonymized: { ... } }

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
const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Validació estricta del device_id: UUID v4 o el format de fallback
 *  generat a `usePlayerIdentity.ts` (`d-...`). Limitem a 80 caràcters
 *  per defensar-nos contra inputs malformats. */
function isValidDeviceId(s: unknown): s is string {
  if (typeof s !== "string") return false;
  if (s.length < 4 || s.length > 80) return false;
  return /^[a-zA-Z0-9_-]+$/.test(s);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  let body: { deviceId?: unknown; dryRun?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const deviceId = body?.deviceId;
  const dryRun = body?.dryRun === true;
  if (!isValidDeviceId(deviceId)) {
    return jsonResponse(400, { error: "Invalid deviceId" });
  }

  const deleted: Record<string, number> = {};
  const anonymized: Record<string, number> = {};

  // 1) Comptem primer (sempre, per al `dryRun` i per a la resposta final).
  async function countDelete(table: string, column: string) {
    const { count, error } = await admin
      .from(table)
      .select("*", { count: "exact", head: true })
      .eq(column, deviceId);
    if (error) throw new Error(`count ${table}: ${error.message}`);
    deleted[table] = count ?? 0;
  }

  try {
    await countDelete("player_profiles", "device_id");
    await countDelete("room_players", "device_id");
    await countDelete("sala_chat", "device_id");
    // Comptem texts de xat de partida (els anonimitzem, no els esborrem)
    {
      const { count, error } = await admin
        .from("room_text_chat")
        .select("*", { count: "exact", head: true })
        .eq("device_id", deviceId);
      if (error) throw new Error(`count room_text_chat: ${error.message}`);
      anonymized["room_text_chat"] = count ?? 0;
    }

    if (dryRun) {
      return jsonResponse(200, { ok: true, dryRun: true, deleted, anonymized });
    }

    // 2) Esborrats reals.
    const tablesHardDelete: Array<{ table: string; column: string }> = [
      { table: "player_profiles", column: "device_id" },
      { table: "room_players", column: "device_id" },
      { table: "sala_chat", column: "device_id" },
    ];
    for (const { table, column } of tablesHardDelete) {
      const { error } = await admin.from(table).delete().eq(column, deviceId);
      if (error) throw new Error(`delete ${table}: ${error.message}`);
    }

    // 3) Anonimització de missatges de xat de partida: substituim
    //    `device_id` per cadena buida, mantenint el text per coherència
    //    del fil. (Alternativa permesa per Play Store per a UGC).
    {
      const { error } = await admin
        .from("room_text_chat")
        .update({ device_id: "" })
        .eq("device_id", deviceId);
      if (error) throw new Error(`anonymize room_text_chat: ${error.message}`);
    }

    return jsonResponse(200, { ok: true, deleted, anonymized });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return jsonResponse(500, { error: msg });
  }
});
