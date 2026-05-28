const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function identityKey(context) {
  const raw = context.params?.key;
  const key = Array.isArray(raw) ? raw.join("/") : raw;
  return typeof key === "string" ? decodeURIComponent(key).trim() : "";
}

function validKey(key) {
  return /^(sha256:[a-f0-9]{64}|sample:P\d{4})$/i.test(key);
}

function cleanIdentity(input) {
  const family = String(input?.family || "").trim();
  const variant = String(input?.variant || "").trim();
  const displayName = String(input?.displayName || "").trim();
  const inspectionId = String(input?.inspectionId || "").trim();
  if (!family || !variant) return null;
  return {
    inspectionId,
    family,
    variant,
    displayName,
    source: "manual",
    updatedAt: String(input?.updatedAt || new Date().toISOString()),
  };
}

export async function onRequestGet(context) {
  const key = identityKey(context);
  if (!validKey(key)) return json({ error: "Invalid identity key." }, 400);
  const kv = context.env?.PLUX_IDENTITIES;
  if (!kv) return json({ error: "Missing PLUX_IDENTITIES KV binding." }, 500);
  const identity = await kv.get(key, { type: "json" });
  return json({ found: Boolean(identity), identity: identity || null });
}

export async function onRequestPut(context) {
  const key = identityKey(context);
  if (!validKey(key)) return json({ error: "Invalid identity key." }, 400);
  const kv = context.env?.PLUX_IDENTITIES;
  if (!kv) return json({ error: "Missing PLUX_IDENTITIES KV binding." }, 500);
  const identity = cleanIdentity(await context.request.json().catch(() => null));
  if (!identity) return json({ error: "Invalid identity payload." }, 400);
  await kv.put(key, JSON.stringify(identity));
  return json({ saved: true, identity });
}

export async function onRequest(context) {
  if (context.request.method === "OPTIONS") return new Response(null, { status: 204, headers: JSON_HEADERS });
  return json({ error: "Method not allowed." }, 405);
}
