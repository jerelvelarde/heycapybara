import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../electron/store";
import type { startRuntime } from "../server/runtime";
import { ScreenshotRegistry } from "../server/screenshots";

// Isolates this test from whatever the shell environment happens to export:
// a stray KITE_MODEL or CPK_INTELLIGENCE_* value would otherwise change
// startRuntime's behavior (or make it throw) depending on who runs the suite
// and from where.
const ENV_KEYS = [
  "KITE_MODEL",
  "CPK_INTELLIGENCE_API_KEY",
  "CPK_INTELLIGENCE_LEARNING_CONTAINER_ID",
] as const;

test("real runtime discovers AG-UI agent only after loopback authentication", async () => {
  const saved = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  const savedTelemetry = process.env.COPILOTKIT_TELEMETRY_DISABLED;
  let storeRoot: string | undefined;
  let alternate: string | undefined;
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    // Keeps the suite from sending CopilotKit a usage event on every run.
    // The telemetry client reads this switch once, when its module loads, so
    // the runtime is imported only after it is set.
    process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";
    const runtimeModule = await import("../server/runtime");
    storeRoot = await mkdtemp(join(tmpdir(), "kite-runtime-test-"));
    const store = new Store(storeRoot);
    await store.load();
    runtime = await runtimeModule.startRuntime(store, {
      screenshots: new ScreenshotRegistry(),
    });
    // A plain, non-optional alias: `runtime` itself stays `T | undefined` so
    // `finally` can close it even if something above throws, but that union
    // type doesn't narrow inside the closure `assert.throws` takes below.
    const rt = runtime;
    const denied = await fetch(rt.settings.runtimeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "info" }),
    });
    assert.equal(denied.status, 401);
    const deniedMcp = await fetch(new URL("/mcp", rt.settings.runtimeUrl), {
      method: "POST",
      headers: { Authorization: "Bearer " + rt.settings.runtimeToken },
    });
    assert.equal(deniedMcp.status, 401);
    const response = await fetch(rt.settings.runtimeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + rt.settings.runtimeToken,
      },
      body: JSON.stringify({ method: "info" }),
    });
    assert.equal(response.status, 200);
    const info = await response.json();
    assert.ok(info.agents.default);
    alternate = await mkdtemp(join(tmpdir(), "kite-workspace-test-"));
    await rt.setWorkspace(alternate);
    assert.equal(rt.settings.workspace, await realpath(alternate));
    await assert.rejects(rt.setWorkspace(join(alternate, "missing")));
    assert.equal(rt.settings.workspace, await realpath(alternate));
    const prior = rt.settings.modelConfigured;
    assert.throws(() => rt.setModelKey("invalid"), /valid OpenAI/);
    assert.equal(rt.settings.modelConfigured, prior);
    const fixtureKey = "sk-testfixture00000000000000000000";
    rt.setModelKey(fixtureKey);
    assert.equal(rt.settings.modelConfigured, true);
    assert.ok(!JSON.stringify(rt.settings).includes(fixtureKey));
  } finally {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    if (savedTelemetry === undefined)
      delete process.env.COPILOTKIT_TELEMETRY_DISABLED;
    else process.env.COPILOTKIT_TELEMETRY_DISABLED = savedTelemetry;
    runtime?.close();
    if (storeRoot) await rm(storeRoot, { recursive: true, force: true });
    if (alternate) await rm(alternate, { recursive: true, force: true });
  }
});
