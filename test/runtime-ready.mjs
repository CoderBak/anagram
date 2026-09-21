// Real-model suites own their daemon and must also own its saved runtime choice.
// They finish first-run selection explicitly, as a user would, without touching a
// configuration belonging to an installed daemon or a developer's normal checkout.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function testRuntimeConfig() {
  const dir = mkdtempSync(join(tmpdir(), "anagram-runtime-test-"));
  return { path: join(dir, "runtime.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function finishTestSetup(base, health, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  let applied = false;
  while (Date.now() < deadline) {
    const ready = await health();
    if (ready) return ready;
    const runtime = await fetch(`${base}/runtime`, { signal: AbortSignal.timeout(2000) })
      .then((r) => r.ok ? r.json() : null, () => null);
    if (runtime?.state === "error") throw new Error(runtime.error || "Runtime setup failed");
    if (!applied && runtime?.state === "awaiting_selection") {
      const eligible = runtime.candidates.filter((c) => c.available && c.precision === "fp32" && !c.experimental);
      const choice = eligible.find((c) => c.id === runtime.recommended_id) ?? eligible[0];
      if (!choice) throw new Error("No FP32 configuration is available for the real-model test");
      const result = await fetch(`${base}/runtime/config`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: choice.id }), signal: AbortSignal.timeout(5000),
      });
      // A completed report can become visible while its worker finishes saving.
      // The control plane refuses overlap with 409; retry on the next poll.
      if (!result.ok && result.status !== 409) throw new Error(`Runtime selection failed (${result.status})`);
      if (result.ok) applied = true;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("The test daemon did not finish benchmark and configuration loading in time");
}
