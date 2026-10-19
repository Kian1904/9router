import { getSettings } from "@/lib/localDb";
import { applyOutboundProxyEnv } from "@/lib/network/outboundProxy";

let initialized = false;

export async function ensureOutboundProxyInitialized() {
  if (initialized) return true;

  try {
    const settings = await getSettings();
    applyOutboundProxyEnv(settings);
    initialized = true;
  } catch (error) {
    console.error("[ServerInit] Error initializing outbound proxy:", error);
  }

  return initialized;
}

// Never touch the runtime SQLite DB during Next's build/static phases.
// The layout is imported by the build too, and opening the DB here can race
// migrations/other workers and produce `database is locked`.
const isBuildPhase = [
  "phase-production-build",
  "phase-export",
  "phase-static",
].includes(process.env.NEXT_PHASE || "");

// Defer init so the HTTP server accepts connections first.
if (!isBuildPhase) {
  setImmediate(() => {
    ensureOutboundProxyInitialized().catch((error) => {
      console.error("[ServerInit] Outbound proxy init skipped:", error.message);
    });
  });
}

export default ensureOutboundProxyInitialized;
