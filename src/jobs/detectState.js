// src/jobs/detectState.js
import { detectAllOnce } from "../detectors/stateDetector.js";

export function startDetectStateLoop({ intervalMs = 60_000 } = {}) {
  console.log(`⏱️ detectState loop every ${Math.round(intervalMs / 1000)}s`);
  const tick = async () => {
    try {
      const r = await detectAllOnce();
      if (r.total) console.log(`[detectState] miners=${r.total} changed=${r.changed}`);
    } catch (e) {
      console.error("[detectState] fatal:", e);
    } finally {
      setTimeout(tick, intervalMs);
    }
  };
  setTimeout(tick, 2000);
}

// CLI (continua a funcionar)
if (import.meta.url === `file://${process.argv[1]}`) {
  (async () => {
    try {
      const r = await detectAllOnce();
      console.log(`[detectState] miners=${r.total} changed=${r.changed}`);
      process.exit(0);
    } catch (e) {
      console.error("[detectState] ERRO:", e);
      process.exit(1);
    }
  })();
}
