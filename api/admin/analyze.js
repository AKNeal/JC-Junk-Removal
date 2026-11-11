// /api/admin/analyze — reads job photos + the crew's description with AI and suggests a load size.
//   POST {description, images: [base64 JPEG, ...], pricing}  →  {result, provider, model}
// Uses Claude when ANTHROPIC_API_KEY is set in Vercel; otherwise Gemini when GEMINI_API_KEY is set.
// Keys live only here on the server; crews never see them. Photos are sent for this one request and not stored by this site.

const auth = require("../_lib/auth");
const store = require("../_lib/store");
const { send, body, str } = require("../_lib/http");

// First model that exists wins. Override with ANTHROPIC_MODEL / GEMINI_MODEL in Vercel if names change.
const CLAUDE_MODELS = [process.env.ANTHROPIC_MODEL, "claude-haiku-5-5", "claude-sonnet-5-5"].filter(Boolean);
const GEMINI_MODELS = [process.env.GEMINI_MODEL, "gemini-flash-latest", "gemini-2.5-flash"].filter(Boolean);
const MAX_IMAGES = 6;
const MAX_IMAGE_B64 = 1_200_000; // ~900 KB each after the phone shrinks it

class AIError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }

module.exports = async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow", "POST"); return send(res, 405, { error: "Method not allowed" }); }
  try {
    const me = await auth.currentUser(req);
    if (!me) return send(res, 401, { error: "Log in first." });
    const provider = process.env.ANTHROPIC_API_KEY ? "claude" : process.env.GEMINI_API_KEY ? "gemini" : null;
    if (!provider) return send(res, 503, { error: "AI isn't set up yet (add ANTHROPIC_API_KEY in Vercel).", code: "not_configured" });
    if ((await store.hit(`rl:ai:${me.id}`, 3600)) > 40) return send(res, 429, { error: "That's a lot of photo checks this hour. Try again later.", code: "rate_limited" });

    const b = body(req);
    const description = str(b.description, 3000);
    const images = (Array.isArray(b.images) ? b.images : []).slice(0, MAX_IMAGES)
      .filter((x) => typeof x === "string" && x.length < MAX_IMAGE_B64 && /^[A-Za-z0-9+/=]+$/.test(x.slice(0, 200)));
    if (!description && !images.length) return send(res, 400, { error: "Add a photo or a description first." });

    const pricing = (await store.getJSON("config:pricing")) || (b.pricing && typeof b.pricing === "object" ? b.pricing : null);
    if (!pricing || !Array.isArray(pricing.tiers)) return send(res, 400, { error: "No price list to work from." });

    const text = prompt(pricing, description, images.length);
    const out = provider === "claude" ? await askClaude(text, images) : await askGemini(text, images);
    return send(res, 200, { ok: true, provider, model: out.model, result: out.result });
  } catch (e) {
    if (e instanceof AIError) return send(res, e.status, { error: e.message, code: e.code });
    console.error("[analyze]", e);
    return send(res, 500, { error: "AI couldn't read that one. Try again or pick the size by hand." });
  }
};

async function askClaude(text, images) {
  // Photos first, then the instructions (Anthropic's recommended order for image questions).
  const content = [...images.map((data) => ({ type: "image", source: { type: "base64", media_type: "image/jpeg", data } })), { type: "text", text }];
  let lastErr = null;
  for (const model of CLAUDE_MODELS) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: 1500, messages: [{ role: "user", content }] }),
    });
    if (r.ok) {
      const data = await r.json();
      const result = parseJSON((data.content || []).filter((c) => c.type === "text").map((c) => c.text).join(""));
      if (!result) throw new AIError(502, "AI couldn't read that one. Try again or pick the size by hand.");
      return { model, result };
    }
    const errText = await r.text();
    if (r.status === 404 || /not_found_error/.test(errText)) { lastErr = `model ${model} not found`; continue; }
    console.error("[analyze claude]", r.status, errText.slice(0, 400));
    if (r.status === 401 || r.status === 403) throw new AIError(503, "The Claude key in Vercel isn't working. Ask Neal to check ANTHROPIC_API_KEY.", "bad_key");
    if (/credit balance/i.test(errText)) throw new AIError(402, "AI credits have run out. Pick the size by hand and tell Neal.", "no_credits");
    if (r.status === 429 || r.status === 529) throw new AIError(429, "AI is busy right now. Try again in a minute.", "busy");
    throw new AIError(502, "AI couldn't read that one. Try again or pick the size by hand.");
  }
  console.error("[analyze claude]", lastErr);
  throw new AIError(502, "AI couldn't read that one. Try again or pick the size by hand.");
}

async function askGemini(text, images) {
  const parts = [{ text }, ...images.map((data) => ({ inline_data: { mime_type: "image/jpeg", data } }))];
  for (const model of GEMINI_MODELS) {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { responseMimeType: "application/json", temperature: 0.2 } }),
    });
    if (r.status === 404) continue;
    if (r.status === 429) throw new AIError(429, "The AI limit is used up for now. Pick the size by hand.", "quota");
    if (!r.ok) { console.error("[analyze gemini]", r.status, (await r.text()).slice(0, 400)); throw new AIError(502, "AI couldn't read that one. Try again or pick the size by hand."); }
    const data = await r.json();
    const result = parseJSON((data.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join(""));
    if (!result) throw new AIError(502, "AI couldn't read that one. Try again or pick the size by hand.");
    return { model, result };
  }
  throw new AIError(502, "AI couldn't read that one. Try again or pick the size by hand.");
}

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
${nImgs ? `You are given ${nImgs} photo(s) of the junk.` : "No photos were provided."} The crew's description is below.
Their truck holds ${yd} cubic yards. Estimate how much truck space the job will take.

Load size keys:
${tiers}

Add-on keys (charged on top of truck space; only count what clearly applies):
${addons}

Return ONLY a JSON object (no other text, no code fences) with exactly this shape:
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
