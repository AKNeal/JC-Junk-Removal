// /api/admin/estimates — saved estimates and the shared price list. Logged-in team only.
//   GET                                   {estimates (newest 300), pricing, me}
//   POST {action:"save", estimate}        create or update (by estimate number)
//   POST {action:"delete", number}        owner/site admin, or whoever made it
//   POST {action:"prices", pricing}       owner/site admin only

const auth = require("../_lib/auth");
const store = require("../_lib/store");
const { send, body, str } = require("../_lib/http");

const NUM_RE = /^JC-\d{6}-[A-Z0-9]{3,6}$/;
const MAX_LIST = 300;

module.exports = async function handler(req, res) {
  try {
    const me = await auth.currentUser(req);
    if (!me) return send(res, 401, { error: "Log in first." });
    if (req.method === "GET") return await list(res, me);
    if (req.method !== "POST") { res.setHeader("Allow", "GET, POST"); return send(res, 405, { error: "Method not allowed" }); }
    const b = body(req);
    switch (b.action) {
      case "save": return await save(res, me, b.estimate);
      case "delete": return await remove(res, me, str(b.number, 30));
      case "prices": return await prices(res, me, b.pricing);
      default: return send(res, 400, { error: "Unknown action." });
    }
  } catch (e) {
    console.error("[estimates]", e);
    return send(res, 400, { error: e.message || "Something went wrong." });
  }
};

async function list(res, me) {
  const ids = await store.indexRange("estimates", MAX_LIST);
  const rows = (await store.getMany(ids.map((n) => `est:${n}`))).filter(Boolean);
  return send(res, 200, {
    estimates: rows,
    pricing: await store.getJSON("config:pricing"),
    me: { id: me.id, name: me.name, role: me.role, canEditPrices: auth.isFull(me) },
    aiReady: Boolean(process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY),
  });
}

async function save(res, me, e) {
  if (!e || typeof e !== "object") return send(res, 400, { error: "Nothing to save." });
  const number = str(e.number, 30);
  if (!NUM_RE.test(number)) return send(res, 400, { error: "Bad estimate number." });
  if (JSON.stringify(e).length > 100000) return send(res, 400, { error: "That estimate is too big to save." });
  const prev = await store.getJSON(`est:${number}`);
  const now = Date.now();
  const doc = {
    ...e, number,
    createdAt: prev?.createdAt || now,
    createdBy: prev?.createdBy || me.id,
    createdByName: prev?.createdByName || me.name,
    updatedAt: now, updatedBy: me.id, updatedByName: me.name,
  };
  await store.setJSON(`est:${number}`, doc);
  await store.indexAdd("estimates", number, now);
  return send(res, 200, { ok: true, estimate: doc });
}

async function remove(res, me, number) {
  const prev = await store.getJSON(`est:${number}`);
  if (!prev) return send(res, 200, { ok: true });
  if (!auth.isFull(me) && prev.createdBy !== me.id) return send(res, 403, { error: "Only the person who made it or an owner can delete it." });
  await store.del(`est:${number}`);
  await store.indexRemove("estimates", number);
  return send(res, 200, { ok: true });
}

async function prices(res, me, p) {
  if (!auth.isFull(me)) return send(res, 403, { error: "Only an owner can change prices." });
  if (!p || typeof p !== "object" || !Array.isArray(p.tiers) || !Array.isArray(p.addons)) return send(res, 400, { error: "Those prices don't look right." });
  if (JSON.stringify(p).length > 50000) return send(res, 400, { error: "Price list is too big." });
  const out = { ...p, updatedAt: Date.now(), updatedByName: me.name };
  await store.setJSON("config:pricing", out);
  return send(res, 200, { ok: true, pricing: out });
}
