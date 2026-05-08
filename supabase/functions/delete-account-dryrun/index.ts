// Edge function: delete-account-dryrun
//
// Wrapper públic de `delete-account` que SEMPRE força `dryRun: true`. Pensat
// per a:
//   - Pàgines externes / tercers que vulguen previsualitzar quins registres
//     s'esborrarien sense risc.
//   - Eines de monitorització i tests E2E que validen que el flux respon
//     contadors consistents.
//   - El propi formulari de la UI quan vol mostrar el "Vas a esborrar X
//     registres" abans del botó de confirmació.
//
// És IMPOSSIBLE que aquest endpoint esborre dades: ignora qualsevol valor
// de `dryRun` que envie el client i sempre el sobreescriu a `true` abans
// de cridar la funció real.
//
// Body:
//   { deviceId: string }
// Resposta (mateix shape que delete-account amb dryRun):
//   { ok: true, dryRun: true, deleted: {...}, anonymized: {...} }

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
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ??
  Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;

/** Mateixa validació estricta que `delete-account/index.ts` per evitar
 *  que aquest wrapper accepte inputs que la funció real rebutjaria. */
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

  let body: { deviceId?: unknown };
  try {
    body = await req.json();
  } catch {
    return jsonResponse(400, { error: "Invalid JSON body" });
  }

  const deviceId = body?.deviceId;
  if (!isValidDeviceId(deviceId)) {
    return jsonResponse(400, { error: "Invalid deviceId" });
  }

  // Reenviem a la funció real amb dryRun forçat. Mai exposem la
  // service-role key des d'aquest wrapper: ho fa la funció destí amb el
  // seu propi entorn.
  try {
    const upstream = await fetch(`${SUPABASE_URL}/functions/v1/delete-account`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ANON_KEY}`,
        apikey: ANON_KEY,
      },
      body: JSON.stringify({ deviceId, dryRun: true }),
    });

    const text = await upstream.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return jsonResponse(502, {
        error: "Upstream returned non-JSON",
        upstreamStatus: upstream.status,
      });
    }

    // Verifiquem que delete-account ens torna efectivament dryRun:true.
    // Si per qualsevol motiu no és així, fallem en comptes de propagar
    // una resposta que podria semblar un esborrat real.
    if (
      upstream.ok &&
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { dryRun?: unknown }).dryRun !== true
    ) {
      return jsonResponse(500, {
        error: "Upstream did not honour dryRun flag",
      });
    }

    return jsonResponse(upstream.status, parsed);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown error";
    return jsonResponse(502, { error: `Upstream error: ${msg}` });
  }
});
