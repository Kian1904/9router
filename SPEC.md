# 9router Render KV Sync

## Cloudflare KV state sync

- `cf-kv-worker/worker.js` exposes authenticated `GET /state` and `PUT /state` endpoints backed by a Cloudflare KV namespace binding named `NINEROUTER`.
- `src/lib/db/kv-sync.mjs` is **self-contained** (uses `node:sqlite` directly, no `@/` alias / no raw import of `index.js`) — this fixed a runtime `Cannot find package '@/lib'` failure and removed the `MODULE_TYPELESS` reparse warning. It pulls the exported 9router database on boot and pushes changes periodically.
- kv-sync safety guards: (a) never push an **empty** local DB over a remote that already has state (prevents a fresh instance clobbering a migration); (b) when the local DB is empty, the periodic tick **re-pulls** from KV to self-seed without a redeploy.
- Round-trip verified: `exportDb` → `importDb` → `exportDb` is byte-identical (78 conn / 1 apiKey / 4 combos).
- `src/lib/network/initOutboundProxy.js` skips SQLite-backed settings initialization during Next build phases, preventing build-time database-lock races.
- `src/sse/utils/logger.mjs` is explicitly marked ESM; its importers use the `.mjs` path to avoid Node's module-type detection overhead.
- The exported database is encrypted locally with AES-256-GCM before upload. The Cloudflare Worker stores only the encrypted envelope and never sees provider/API-key plaintext.
- Required Render environment variables: `CF_KV_URL`, `CF_KV_TOKEN`, `CF_KV_ENCRYPTION_KEY`. Optional: `CF_KV_STATE_KEY`, `CF_KV_SYNC_INTERVAL`.
- `custom-server.js` starts the pull/sync lifecycle after the HTTP server begins listening.

## Cloudflare setup

1. Create a KV namespace and bind it as `NINEROUTER`.
2. Set Worker secret `AUTH_TOKEN`.
3. Deploy `cf-kv-worker/worker.js`.
4. Set Render secrets. `CF_KV_TOKEN` must equal Worker `AUTH_TOKEN`; `CF_KV_ENCRYPTION_KEY` is an independent long random secret.

Never commit the three Render secrets or a database export.
