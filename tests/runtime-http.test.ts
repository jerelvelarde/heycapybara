import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../electron/store";
import { startRuntime } from "../server/runtime";
test("real runtime discovers AG-UI agent only after loopback authentication", async () => {
  const store = new Store(await mkdtemp(join(tmpdir(), "kite-runtime-test-")));
  await store.load();
  const runtime = await startRuntime(store, { screenshots: undefined });
  try {
    const denied = await fetch(runtime.settings.runtimeUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "info" }),
    });
    assert.equal(denied.status, 401);
    const deniedMcp = await fetch(
      new URL("/mcp", runtime.settings.runtimeUrl),
      {
        method: "POST",
        headers: { Authorization: "Bearer " + runtime.settings.runtimeToken },
      },
    );
    assert.equal(deniedMcp.status, 401);
    const response = await fetch(runtime.settings.runtimeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + runtime.settings.runtimeToken,
      },
      body: JSON.stringify({ method: "info" }),
    });
    assert.equal(response.status, 200);
    const info = await response.json();
    assert.ok(info.agents.default);
    const alternate = await mkdtemp(join(tmpdir(), "kite-workspace-test-"));
    await runtime.setWorkspace(alternate);
    assert.equal(runtime.settings.workspace, await realpath(alternate));
    await assert.rejects(runtime.setWorkspace(join(alternate, "missing")));
    assert.equal(runtime.settings.workspace, await realpath(alternate));
    const prior = runtime.settings.modelConfigured;
    assert.throws(() => runtime.setModelKey("invalid"), /valid OpenAI/);
    assert.equal(runtime.settings.modelConfigured, prior);
    const fixtureKey = "sk-testfixture00000000000000000000";
    runtime.setModelKey(fixtureKey);
    assert.equal(runtime.settings.modelConfigured, true);
    assert.ok(!JSON.stringify(runtime.settings).includes(fixtureKey));
  } finally {
    await new Promise<void>((resolve, reject) =>
      runtime.server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
