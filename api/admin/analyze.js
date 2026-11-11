// /api/admin/analyze — reads job photos + the crew's description with Google Gemini (free tier) and suggests a load size.
//   POST {description, images: [base64 JPEG, ...], pricing}  →  {result}
// The Gemini key lives only here (Vercel env GEMINI_API_KEY); crews never see it.
// Photos are sent to Google for this one request and are not stored anywhere by this site.

const auth = require("../_lib/auth");
const store = require("../_lib/store");
const { send, body, str } = require("../_lib/http");

// First model that exists wins. Override with GEMINI_MODEL in Vercel if Google renames things.
const MODELS = [process.env.GEMINI_MODEL, "gemini-flash-latest", "gemini-2.5-flash", "gemini-2.0-flash"].filter(Boolean);
const MAX_IMAGES = 6;
const MAX_IMAGE_B64 = 1_200_000; // ~900 KB each after the phone shrinks it

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(res, 405, { error: "Method not allowed" }); }
  try {
    const me = await auth.currentUser(req);
    if (!me) return send(res, 401, { error: "Log in first." });
    if (!process.env.GEMINI_API_KEY) return send(res, 503, { error: "AI isn't set up yet (GEMINI_API_KEY in Vercel).", code: "not_configured" });
    if ((await store.hit(`rl:ai:${me.id}`, 3600)) > 40) return send(res, 429, { error: "That's a lot of photo checks this hour. Try again later.", code: "rate_limited" });

    const b = body(req);
    const description = str(b.description, 3000);
    const images = (Array.isArray(b.images) ? b.images : []).slice(0, MAX_IMAGES)
      .filter((x) => typeof x === "string" && x.length < MAX_IMAGE_B64 && /^[A-Za-z0-9+/=]+$/.test(x.slice(0, 200)));
    if (!description && !images.length) return send(res, 400, { error: "Add a photo or a description first." });

    const pricing = (await store.getJSON("config:pricing")) || (b.pricing && typeof b.pricing === "object" ? b.pricing : null);
    if (!pricing || !Array.isArray(pricing.tiers)) return send(res, 400, { error: "No price list to work from." });

    const parts = [{ text: prompt(pricing, description, images.length) }, ...images.map((data) => ({ inline_data: { mime_type: "image/jpeg", data } }))];
    let lastErr = null;
    for (const model of MODELS) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
        body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { responseMimeType: "application/json", temperature: 0.2 } }),
      });
      if (r.status === 404) { lastErr = `model ${model} not found`; continue; }
      if (r.status === 429) return send(res, 429, { error: "The free AI limit is used up for now. Pick the size by hand.", code: "quota" });
      if (!r.ok) { lastErr = `${r.status} ${(await r.text()).slice(0, 300)}`; break; }
      const data = await r.json();
      const text = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
      const result = parseJSON(text);
      if (!result) { lastErr = "unreadable answer"; break; }
      return send(res, 200, { ok: true, model, result });
    }
    console.error("[analyze]", lastErr);
    return send(res, 502, { error: "AI couldn't read that one. Try again or pick the size by hand." });
  } catch (e) {
    console.error("[analyze]", e);
    return send(res, 500, { error: "AI couldn't read that one. Try again or pick the size by hand." });
  }
};

function parseJSON(t) {
  if (!t) return null;
  const s = t.indexOf("{"), e = t.lastIndexOf("}");
  if (s < 0 || e < 0) return null;
  try { return JSON.parse(t.slice(s, e + 1)); } catch { return null; }
}

function prompt(pricing, description, nImgs) {
  const yd = Number(pricing.truckYards) || 15;
  const tiers = pricing.tiers.map((t) => `- "${t.key}": ${t.label} (about ${Math.round((Number(t.frac) || 0) * yd * 10) / 10} cubic yards)`).join("\n");
  const addons = (pricing.addons || []).map((a) => `- "${a.key}": ${a.label}, counted ${a.unit || "each"}`).join("\n");
  return `You are helping a junk removal crew at JC's Junk Removal (Fairbanks / North Pole / Salcha, Alaska) write a price estimate.
${nImgs ? `You are given ${nImgs} photo(s) of the junk after this text.` : "No photos were provided."} The crew's description is below.
Their truck holds ${yd} cubic yards. Estimate how much truck space the job will take.

Load size keys:
${tiers}

Add-on keys (charged on top of truck space; only count what clearly applies):
${addons}

Return ONLY a JSON object with exactly this shape:
{
  "summary": "1-2 plain sentences describing the job for the crew",
  "items": [{"name": "item name", "qty": 1}],
  "est_cubic_yards": number,
  "load_tier": "one of the load size keys above",
  "extra_full_loads": 0,
  "addons": {"addon_key": quantity},
  "flags": ["short warnings: hazardous or not-accepted items (paint, chemicals, fuel, propane tanks, asbestos, batteries, medical waste), access problems, anything to confirm on site"],
  "crew_size": 2,
  "est_hours": number,
  "confidence": "low" | "medium" | "high"
}
Rules:
- If the junk needs more than one full truck, set load_tier to "full" and put the number of extra full loads in extra_full_loads.
- Count heavy debris (concrete, dirt, rock, shingles) in quarter-truck units under "heavy" if that key exists.
- Only count "stairs" if the description or photos show stairs; count flights.
- If unsure between two sizes, choose the larger one and say so in summary.
- Use "low" confidence when photos are unclear, partial, or missing.

Crew description:
"""${description || "(none)"}"""`;
}
