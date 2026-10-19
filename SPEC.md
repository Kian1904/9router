# 9router Render KV Sync

## Cloudflare KV state sync

- `cf-kv-worker/worker.js` exposes authenticated `GET /state` and `PUT /state` endpoints backed by a Cloudflare KV namespace binding named `NINEROUTER`.
- `src/lib/db/kv-sync.mjs` pulls the exported 9router database on boot and pushes changes periodically.
- `src/lib/network/initOutboundProxy.js` skips SQLite-backed settings initialization during Next build phases, preventing build-time database-lock races.
- The exported database is encrypted locally with AES-256-GCM before upload. The Cloudflare Worker stores only the encrypted envelope and never sees provider/API-key plaintext.
- Required Render environment variables: `CF_KV_URL`, `CF_KV_TOKEN`, `CF_KV_ENCRYPTION_KEY`. Optional: `CF_KV_STATE_KEY`, `CF_KV_SYNC_INTERVAL`.
- `custom-server.js` starts the pull/sync lifecycle after the HTTP server begins listening.

## Cloudflare setup

1. Create a KV namespace and bind it as `NINEROUTER`.
2. Set Worker secret `AUTH_TOKEN`.
3. Deploy `cf-kv-worker/worker.js`.
4. Set Render secrets. `CF_KV_TOKEN` must equal Worker `AUTH_TOKEN`; `CF_KV_ENCRYPTION_KEY` is an independent long random secret.

Never commit the three Render secrets or a database export.
