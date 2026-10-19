// Cloudflare KV sync for ephemeral deployments.
// Uses the app's DB adapter (getAdapter) so folders, schema migrations, and the
// shared SQLite connection are handled correctly. This avoids both the `@/`
// build-time alias (unresolved in the standalone runtime) and raw node:sqlite
// opening a file that may not exist yet at boot. The exported DB is encrypted
// locally with AES-256-GCM before upload; the Worker stores only the envelope.
// Required env: CF_KV_URL, CF_KV_TOKEN, CF_KV_ENCRYPTION_KEY

import crypto from "node:crypto";

const SYNC_INTERVAL_MS = parseInt(process.env.CF_KV_SYNC_INTERVAL || "300000", 10);
const STATE_KEY = process.env.CF_KV_STATE_KEY || "main";
let pushTimer = null;
let lastPushedHash = null;

function log(msg) { console.log(`[KV-Sync] ${msg}`); }
function warn(msg) { console.warn(`[KV-Sync] WARN: ${msg}`); }

function config() {
  const { CF_KV_URL: url, CF_KV_TOKEN: token, CF_KV_ENCRYPTION_KEY: key } = process.env;
  if (!url || !token || !key) {
    warn("CF_KV_URL, CF_KV_TOKEN, and CF_KV_ENCRYPTION_KEY are all required");
    return null;
  }
  return { url: url.replace(/\/$/, ""), token, key };
}

function parseJson(v, f) { try { return JSON.parse(v); } catch { return f; } }
function authOf(c) { return ["Bearer", c.token].join(" "); }

async function exportDb() {
  const { getAdapter } = await import("./driver.js");
  const db = await getAdapter();
  const sRow = db.get("SELECT data FROM settings WHERE id = 1");
  const out = {
    settings: sRow ? parseJson(sRow.data, {}) : {},
    providerConnections: db.all("SELECT * FROM providerConnections").map((r) => ({ ...parseJson(r.data, {}), id: r.id, provider: r.provider, authType: r.authType, name: r.name, email: r.email, priority: r.priority, isActive: r.isActive === 1, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    providerNodes: db.all("SELECT * FROM providerNodes").map((r) => ({ ...parseJson(r.data, {}), id: r.id, type: r.type, name: r.name, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    proxyPools: db.all("SELECT * FROM proxyPools").map((r) => ({ ...parseJson(r.data, {}), id: r.id, isActive: r.isActive === 1, testStatus: r.testStatus, createdAt: r.createdAt, updatedAt: r.updatedAt })),
    apiKeys: db.all("SELECT * FROM apiKeys").map((r) => ({ id: r.id, key: r.key, name: r.name, machineId: r.machineId, isActive: r.isActive === 1, createdAt: r.createdAt })),
    combos: db.all("SELECT * FROM combos").map((r) => ({ id: r.id, name: r.name, kind: r.kind, models: parseJson(r.models, []), createdAt: r.createdAt, updatedAt: r.updatedAt })),
    modelAliases: {}, customModels: [], mitmAlias: {}, pricing: {},
  };
  for (const r of db.all("SELECT key, value FROM kv WHERE scope = 'modelAliases'")) out.modelAliases[r.key] = parseJson(r.value);
  for (const r of db.all("SELECT key, value FROM kv WHERE scope = 'customModels'")) out.customModels.push(parseJson(r.value));
  for (const r of db.all("SELECT key, value FROM kv WHERE scope = 'mitmAlias'")) out.mitmAlias[r.key] = parseJson(r.value);
  for (const r of db.all("SELECT key, value FROM kv WHERE scope = 'pricing'")) out.pricing[r.key] = parseJson(r.value);
  return out;
}

async function importDb(payload) {
  const { getAdapter } = await import("./driver.js");
  const db = await getAdapter();
  db.transaction(() => {
    db.run("DELETE FROM settings");
    db.run("DELETE FROM providerConnections");
    db.run("DELETE FROM providerNodes");
    db.run("DELETE FROM proxyPools");
    db.run("DELETE FROM apiKeys");
    db.run("DELETE FROM combos");
    db.run("DELETE FROM kv WHERE scope IN ('modelAliases', 'customModels', 'mitmAlias', 'pricing')");
    if (payload.settings) db.run("INSERT INTO settings(id, data) VALUES(1, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data", [JSON.stringify(payload.settings)]);
    for (const c of payload.providerConnections || []) {
      const { id, provider, authType, name, email, priority, isActive, createdAt, updatedAt, ...rest } = c;
      db.run("INSERT OR REPLACE INTO providerConnections(id, provider, authType, name, email, priority, isActive, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [id, provider, authType || "oauth", name || null, email || null, priority || null, isActive === false ? 0 : 1, JSON.stringify(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]);
    }
    for (const n of payload.providerNodes || []) {
      const { id, type, name, createdAt, updatedAt, ...rest } = n;
      db.run("INSERT OR REPLACE INTO providerNodes(id, type, name, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)", [id, type || null, name || null, JSON.stringify(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]);
    }
    for (const p of payload.proxyPools || []) {
      const { id, isActive, testStatus, createdAt, updatedAt, ...rest } = p;
      db.run("INSERT OR REPLACE INTO proxyPools(id, isActive, testStatus, data, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)", [id, isActive === false ? 0 : 1, testStatus || "unknown", JSON.stringify(rest), createdAt || new Date().toISOString(), updatedAt || new Date().toISOString()]);
    }
    for (const k of payload.apiKeys || []) {
      db.run("INSERT OR REPLACE INTO apiKeys(id, key, name, machineId, isActive, createdAt) VALUES(?, ?, ?, ?, ?, ?)", [k.id, k.key, k.name || null, k.machineId || null, k.isActive === false ? 0 : 1, k.createdAt || new Date().toISOString()]);
    }
    for (const c of payload.combos || []) {
      db.run("INSERT OR REPLACE INTO combos(id, name, kind, models, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?)", [c.id, c.name, c.kind || null, JSON.stringify(c.models || []), c.createdAt || new Date().toISOString(), c.updatedAt || new Date().toISOString()]);
    }
    for (const [a, m] of Object.entries(payload.modelAliases || {})) db.run("INSERT OR REPLACE INTO kv(scope, key, value) VALUES('modelAliases', ?, ?)", [a, JSON.stringify(m)]);
    for (const m of payload.customModels || []) { const k = `${m.providerAlias}|${m.id}|${m.type || "llm"}`; db.run("INSERT OR REPLACE INTO kv(scope, key, value) VALUES('customModels', ?, ?)", [k, JSON.stringify(m)]); }
    for (const [tool, mappings] of Object.entries(payload.mitmAlias || {})) db.run("INSERT OR REPLACE INTO kv(scope, key, value) VALUES('mitmAlias', ?, ?)", [tool, JSON.stringify(mappings || {})]);
    for (const [provider, models] of Object.entries(payload.pricing || {})) db.run("INSERT OR REPLACE INTO kv(scope, key, value) VALUES('pricing', ?, ?)", [provider, JSON.stringify(models || {})]);
  });
  return true;
}

function isEmptyState(data) {
  return !data || (
    (data.providerConnections || []).length === 0 &&
    (data.apiKeys || []).length === 0 &&
    (data.combos || []).length === 0
  );
}

function hashPayload(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}
function deriveKey(secret) {
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}
function encryptPayload(payload, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}
function decryptPayload(value, secret) {
  const parts = String(value).split(":");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Invalid encrypted KV payload");
  const decipher = crypto.createDecipheriv("aes-256-gcm", deriveKey(secret), Buffer.from(parts[1], "base64url"));
  decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
  const plaintext = Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]).toString("utf8");
  return JSON.parse(plaintext);
}

function endpoint(c) { return `${c.url}/state?key=${encodeURIComponent(STATE_KEY)}`; }

export async function pullFromKV() {
  const c = config();
  if (!c) return false;
  try {
    const res = await fetch(endpoint(c), { headers: { Authorization: authOf(c) }, signal: AbortSignal.timeout(15000) });
    if (res.status === 404) { log("No state in KV yet (first boot)"); return false; }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.found || typeof json.data !== "string") throw new Error("Malformed KV response");
    const data = decryptPayload(json.data, c.key);
    await importDb(data);
    lastPushedHash = hashPayload(data);
    log(`State restored from KV (saved: ${json.saved || "unknown"})`);
    return true;
  } catch (e) {
    warn(`Pull failed: ${e.message}; continuing with local DB`);
    return false;
  }
}

export async function pushToKV() {
  const c = config();
  if (!c) return false;
  try {
    const data = await exportDb();
    if (isEmptyState(data)) {
      try {
        const res = await fetch(endpoint(c), { headers: { Authorization: authOf(c) }, signal: AbortSignal.timeout(15000) });
        const json = res.ok ? await res.json() : null;
        if (json && json.found) { log("Skip push: local DB empty but remote has state"); return false; }
      } catch {}
    }
    const hash = hashPayload(data);
    if (hash === lastPushedHash) return true;
    const res = await fetch(endpoint(c), {
      method: "PUT",
      headers: { Authorization: authOf(c), "Content-Type": "text/plain" },
      body: encryptPayload(data, c.key),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    lastPushedHash = hash;
    log("State pushed to KV (encrypted)");
    return true;
  } catch (e) {
    warn(`Push failed: ${e.message}`);
    return false;
  }
}

export function startPeriodicSync() {
  if (!config() || pushTimer) return;
  pushTimer = setInterval(async () => {
    try {
      const data = await exportDb();
      if (isEmptyState(data)) { await pullFromKV(); return; }
      await pushToKV();
    } catch {}
  }, SYNC_INTERVAL_MS);
  pushTimer.unref?.();
  log(`Periodic sync started (every ${SYNC_INTERVAL_MS / 1000}s)`);
}

export function stopPeriodicSync() {
  if (pushTimer) clearInterval(pushTimer);
  pushTimer = null;
}
