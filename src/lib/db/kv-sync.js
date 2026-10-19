// Cloudflare KV sync for ephemeral deployments.
// Credentials never leave 9router as plaintext: the exported DB is encrypted
// locally with AES-256-GCM before it is sent to the Worker.
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

function hashPayload(obj) {
  return crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex");
}

function deriveKey(secret) {
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}

function encryptPayload(payload, secret) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", deriveKey(secret), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

function decryptPayload(value, secret) {
  const parts = String(value).split(":");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Invalid encrypted KV payload");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    deriveKey(secret),
    Buffer.from(parts[1], "base64url"),
  );
  decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(parts[3], "base64url")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext);
}

async function endpoint(c) {
  return `${c.url}/state?key=${encodeURIComponent(STATE_KEY)}`;
}

export async function pullFromKV() {
  const c = config();
  if (!c) return false;
  try {
    const res = await fetch(await endpoint(c), {
      headers: { Authorization: `Bearer ${c.token}` },
      signal: AbortSignal.timeout(15000),
    });
    if (res.status === 404) {
      log("No state in KV yet (first boot)");
      return false;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    if (!json.found || typeof json.data !== "string") throw new Error("Malformed KV response");
    const data = decryptPayload(json.data, c.key);
    const { importDb } = await import("./index.js");
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
    const { exportDb } = await import("./index.js");
    const data = await exportDb();
    const hash = hashPayload(data);
    if (hash === lastPushedHash) return true;
    const res = await fetch(await endpoint(c), {
      method: "PUT",
      headers: { Authorization: `Bearer ${c.token}`, "Content-Type": "text/plain" },
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
  pushTimer = setInterval(() => { pushToKV().catch(() => {}); }, SYNC_INTERVAL_MS);
  pushTimer.unref?.();
  log(`Periodic sync started (every ${SYNC_INTERVAL_MS / 1000}s)`);
}

export function stopPeriodicSync() {
  if (pushTimer) clearInterval(pushTimer);
  pushTimer = null;
}
