// Basket Lover · pizarra-ia: lee la foto de una pizarra y devuelve jugadores, balón y flechas.
// Solo para entrenadores con sesión iniciada. La clave de Google va en el secreto GEMINI_API_KEY.
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const PROMPT = `Eres un asistente de entrenadores de baloncesto. La imagen es la foto de una pizarra (de rotulador o magnética) con un ejercicio o jugada dibujado sobre una pista.
Identifica la pista dibujada y devuelve lo que hay encima en JSON.
Coordenadas normalizadas de 0 a 1 respecto a la PISTA DIBUJADA (no a la foto):
- x: 0 = línea lateral izquierda, 1 = línea lateral derecha (mirando la pizarra de frente).
- y: 0 = línea de fondo donde está la canasta de arriba, 1 = medio campo si es media pista, o la otra línea de fondo si es pista completa.
Si la canasta está abajo en la foto, gira mentalmente la pista para que la canasta quede arriba (y=0).
Jugadores: atacantes suelen ser círculos o números (1-5); defensores suelen ser X o X con número. Pon "n" con su número si lo tiene, si no 0.
Balón: un círculo pequeño relleno o con rayas, si lo hay.
Flechas: type "corte" (línea continua con punta), "pase" (línea discontinua), "bote" (línea en zigzag u ondulada), "bloqueo" (línea que acaba en una raya perpendicular "T").
"from" es el inicio de la flecha (normalmente en un jugador) y "to" el final.
Conos: triángulos o conos dibujados.
No inventes nada que no esté dibujado.`;

const PT = { type: "object", properties: { x: { type: "number" }, y: { type: "number" } }, required: ["x", "y"] };
const SCHEMA = {
  type: "object",
  properties: {
    court: { type: "string", enum: ["half", "full"] },
    players: { type: "array", items: { type: "object", properties: { side: { type: "string", enum: ["a", "d"] }, n: { type: "integer" }, x: { type: "number" }, y: { type: "number" } }, required: ["side", "x", "y"] } },
    ball: { type: "object", nullable: true, properties: { x: { type: "number" }, y: { type: "number" } } },
    cones: { type: "array", items: PT },
    arrows: { type: "array", items: { type: "object", properties: { type: { type: "string", enum: ["corte", "pase", "bote", "bloqueo"] }, from: PT, to: PT }, required: ["type", "from", "to"] } },
  },
  required: ["court", "players", "arrows"],
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Método no permitido" }, 405);
  try {
    const auth = req.headers.get("Authorization") || "";
    let pub = Deno.env.get("SUPABASE_ANON_KEY") || "";
    if (!pub) { try { pub = String(Object.values(JSON.parse(Deno.env.get("SUPABASE_PUBLISHABLE_KEYS") || "{}"))[0] || ""); } catch (_) { /* nada */ } }
    const sb = createClient(Deno.env.get("SUPABASE_URL")!, pub);
    const token = auth.replace(/^Bearer\s+/i, "");
    const { data: { user } } = token ? await sb.auth.getUser(token) : { data: { user: null } };
    if (!user) return json({ error: "Entra con tu cuenta para usar esta opción" }, 401);

    const key = Deno.env.get("GEMINI_API_KEY");
    if (!key) return json({ error: "Falta la clave GEMINI_API_KEY en Supabase" }, 500);
    const { image, mime } = await req.json();
    if (!image || typeof image !== "string" || image.length > 8_000_000) return json({ error: "Imagen no válida o demasiado grande" }, 400);

    const body = JSON.stringify({
      contents: [{ parts: [{ text: PROMPT }, { inline_data: { mime_type: mime || "image/jpeg", data: image } }] }],
      generationConfig: { temperature: 0.1, response_mime_type: "application/json", response_schema: SCHEMA },
    });
    const call = (m: string) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": key }, body });
    // probar modelos hasta dar con uno que funcione en el plan gratis
    const zero = (x: { error?: { message?: string } }) => /limit:\s*0\b/.test((x && x.error && x.error.message) || "");
    const cands: string[] = [];
    const env = Deno.env.get("GEMINI_MODEL");
    if (env) cands.push(env);
    cands.push("gemini-flash-latest", "gemini-flash-lite-latest");
    let listed = false;
    let model = "", r: Response | null = null, j: any = null;
    for (let i = 0; i < cands.length && i < 10; i++) {
      model = cands[i];
      r = await call(model); j = await r.json();
      if (r.ok) break;
      if (r.status === 429 && !zero(j)) break; // límite real del plan gratis: no seguir gastando
      if (!listed) {
        listed = true;
        const lr = await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { headers: { "x-goog-api-key": key } });
        const lj = await lr.json();
        const more = (lj.models || []).filter((m: { name: string; supportedGenerationMethods?: string[] }) =>
          /flash/i.test(m.name) && !/image|tts|audio|live|exp|preview|omni/i.test(m.name) && (m.supportedGenerationMethods || []).includes("generateContent"))
          .map((m: { name: string }) => m.name.replace(/^models\//, ""))
          .sort((x: string, y: string) => y.localeCompare(x, undefined, { numeric: true }));
        for (const m of more) if (!cands.includes(m)) cands.push(m);
      }
    }
    r = r as Response;
    if (!r.ok) return json({ error: (j && j.error && j.error.message) || "Error de Google", model }, r.status === 429 ? 429 : 502);
    const txt = (j.candidates?.[0]?.content?.parts || []).map((p: { text?: string }) => p.text || "").join("") || "{}";
    return json({ ...JSON.parse(txt), _model: model });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
