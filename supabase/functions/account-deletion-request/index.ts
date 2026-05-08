// Edge function: account-deletion-request
//
// Endpoint públic que rep sol·licituds del formulari /eliminar-cuenta i les
// persisteix a `public.account_deletion_requests` per al seu processament
// manual (compliment del termini màxim d'1 mes — art. 12.3 RGPD).
//
// Aquesta funció NO esborra dades immediatament: només registra la petició.
// El moderador/equip processa la cua i marca cada fila com a `completed` o
// `rejected`. Per a esborrat instantani per device_id existeix la funció
// `delete-account` (i el seu wrapper `delete-account-dryrun`).
//
// Body:
//   { email: string, reason?: string, deviceId?: string, confirmed: true }
// Resposta:
//   { ok: true, requestId: string }   // èxit
//   { error: string }                  // error de validació o servidor
//
// Defenses:
//   - Validació estricta dels camps (longitud, format email).
//   - Rate limit per IP (`ip_masked`): màxim 5 sol·licituds per /24 cada hora.
//   - Mai retorna informació sensible: ni si l'email ja existia ni quantes
//     sol·licituds hi ha en cua. Resposta uniforme.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DEVICE_RE = /^[a-zA-Z0-9_-]{4,80}$/;

function isValidEmail(s: unknown): s is string {
  return typeof s === "string" && s.length >= 5 && s.length <= 254 && EMAIL_RE.test(s);
}
function isValidReason(s: unknown): s is string | undefined {
  if (s === undefined || s === null || s === "") return true;
  return typeof s === "string" && s.length <= 1000;
}
function isValidDeviceId(s: unknown): boolean {
  if (s === undefined || s === null || s === "") return true;
  return typeof s === "string" && DEVICE_RE.test(s);
}

/** Enmascara una IP guardant només el /24 (IPv4) o /48 (IPv6) per a
 *  rate-limit i auditoria sense exposar l'IP completa. */
function maskIp(raw: string | null): string | null {
  if (!raw) return null;
  const ip = raw.split(",")[0].trim();
  if (!ip) return null;
  if (ip.includes(":")) {
    // IPv6 → conservem 3 primers grups
    const parts = ip.split(":");
    return parts.slice(0, 3).join(":") + "::/48";
  }
  // IPv4 → conservem 3 primers octets
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
}

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse(405, { error: "Method not allowed" });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "Cos JSON invàlid" });
  }

  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const reasonRaw = typeof body.reason === "string" ? body.reason.trim() : "";
  const reason = reasonRaw.length === 0 ? undefined : reasonRaw;
  const deviceId = typeof body.deviceId === "string" ? body.deviceId.trim() : "";
  const confirmed = body.confirmed === true;

  if (!isValidEmail(email)) {
    return jsonResponse(400, { error: "Adreça de correu invàlida" });
  }
  if (!isValidReason(reason)) {
    return jsonResponse(400, { error: "El motiu és massa llarg (màx. 1000 caràcters)" });
  }
  if (!isValidDeviceId(deviceId)) {
    return jsonResponse(400, { error: "Identificador de dispositiu invàlid" });
  }
  if (!confirmed) {
    return jsonResponse(400, { error: "Cal confirmar explícitament la sol·licitud" });
  }

  const ipMasked = maskIp(req.headers.get("x-forwarded-for"));
  const userAgent = (req.headers.get("user-agent") ?? "").slice(0, 500);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false },
  });

  // Rate-limit: màx. 5 sol·licituds per /24 cada hora.
  if (ipMasked) {
    const since = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count } = await admin
      .from("account_deletion_requests")
      .select("id", { head: true, count: "exact" })
      .eq("ip_masked", ipMasked)
      .gte("created_at", since);
    if ((count ?? 0) >= 5) {
      return jsonResponse(429, {
        error: "Massa sol·licituds. Torna-ho a provar d'aquí a una hora.",
      });
    }
  }

  const { data, error } = await admin
    .from("account_deletion_requests")
    .insert({
      email,
      reason: reason ?? null,
      device_id: deviceId.length > 0 ? deviceId : null,
      ip_masked: ipMasked,
      user_agent: userAgent || null,
      status: "pending",
    })
    .select("id")
    .single();

  if (error || !data) {
    console.error("account-deletion-request insert failed", error);
    return jsonResponse(500, { error: "No s'ha pogut registrar la sol·licitud" });
  }

  return jsonResponse(200, { ok: true, requestId: data.id });
});
