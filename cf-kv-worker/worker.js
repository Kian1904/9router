// cf-kv-worker/worker.js - Cloudflare Worker untuk 9router KV state sync.
// Deploy via dashboard CF Workers atau wrangler.
//
// Env vars yang harus di-set di CF Dashboard:
//   AUTH_TOKEN = string panjang random (sama dengan CF_KV_TOKEN di Render)
//   Bindings: tambah KV namespace binding nama "NINEROUTER"
//
// Endpoints:
//   GET /state?key=<key> - ambil state
//   PUT /state?key=<key> - simpan state (body = JSON)
//   GET /health          - cek worker hidup

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Health check (no auth needed for uptime pingers)
    if (path === "/health" || path === "/") {
      return new Response(JSON.stringify({ ok: true, ts: Date.now() }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // All other routes require auth
    const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "")
      || url.searchParams.get("token");
    if (!token || token !== env.AUTH_TOKEN) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }

    const key = url.searchParams.get("key") || "default";
    const kvKey = `9router:${key}`;

    // GET state
    if (request.method === "GET" && path === "/state") {
      try {
        const value = await env.NINEROUTER.get(kvKey);
        if (value === null) {
          return new Response(JSON.stringify({ found: false }), {
            status: 404,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ found: true, data: value, ts: Date.now() }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // PUT state
    if (request.method === "PUT" && path === "/state") {
      try {
        const body = await request.text();
        if (!body || body.length > 25 * 1024 * 1024) {
          return new Response(JSON.stringify({ error: "invalid or oversized body" }), {
            status: 413,
            headers: { "Content-Type": "application/json" },
          });
        }
        // Body is an AES-256-GCM envelope; Worker stores it without decrypting.
        await env.NINEROUTER.put(kvKey, body);
        return new Response(JSON.stringify({ ok: true, saved: Date.now() }), {
          headers: { "Content-Type": "application/json" },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    return new Response(JSON.stringify({ error: "not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  },
};
