// Edge function: enviar missatge al xat d'una sala (lobby de sala).
// Body: { salaSlug: string, deviceId: string, name: string, text: string }
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
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

const ALLOWED_SALAS = new Set(["la-falta", "truquers", "joc-fora", "9-bones"]);

// Anti-spam molt bàsic en memòria (per instància d'edge runtime).
const lastSentByDevice = new Map<string, number>();
const MIN_GAP_MS = 800;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse(405, { error: "Method not allowed" });

  let body: any;
  try { body = await req.json(); } catch { return jsonResponse(400, { error: "JSON invàlid" }); }

  const salaSlug = String(body?.salaSlug ?? "").trim();
  const deviceId = String(body?.deviceId ?? "").trim();
  const name = String(body?.name ?? "").replace(/\s+/g, " ").trim().slice(0, 24);
  const text = String(body?.text ?? "").trim().slice(0, 200);

  if (!ALLOWED_SALAS.has(salaSlug)) return jsonResponse(400, { error: "Sala desconeguda" });
  if (!deviceId) return jsonResponse(400, { error: "Falta deviceId" });
  if (!name) return jsonResponse(400, { error: "Falta nom" });
  if (!text) return jsonResponse(400, { error: "Missatge buit" });

  const now = Date.now();
  const last = lastSentByDevice.get(deviceId) ?? 0;
  if (now - last < MIN_GAP_MS) return jsonResponse(429, { error: "Massa ràpid, espera un moment" });
  lastSentByDevice.set(deviceId, now);

  const { data, error } = await admin
    .from("sala_chat")
    .insert({ sala_slug: salaSlug, device_id: deviceId, name, text })
    .select("id, sala_slug, device_id, name, text, created_at")
    .single();

  if (error) return jsonResponse(500, { error: error.message });
  return jsonResponse(200, { ok: true, message: data });
});
