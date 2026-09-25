import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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

async function waitFor(
  condition: () => boolean,
  { timeoutMs, intervalMs = 20 }: { timeoutMs: number; intervalMs?: number },
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (condition()) return;
    if (Date.now() > deadline)
      throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
    await sleep(intervalMs);
  }
}

// A stand-in `codex` binary (CodexRunner spawns it directly, per its
// `codexPathOverride`, the same way tests/runtime-e2e.test.ts's FAKE_CODEX
// does) whose only job is to leak the one secret this file's next test
// needs and production never exposes: the bearer token the real /mcp route
// checks. server/runtime.ts generates that token fresh per runtime and
// keeps it in a closure, never returning it on `settings` -- its one other
// holder is whatever process CodexRunner spawns, which receives it as the
// KITE_MCP_TOKEN environment variable (server/codex-agent.ts,
// codexEnvironment), the same allowlisted environment object a real `codex`
// binary reads to call kite MCP tools itself. This fixture drains stdin
// (so the SDK's `child.stdin.end()` doesn't hang) and writes out that one
// variable, then answers with the same minimal JSONL turn
// tests/fixtures/fake-codex.mjs uses, so the one-shot chat turn that spawns
// it still finishes normally.
function leakTokenFixtureSource(tokenFile: string) {
  return `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(tokenFile)}, process.env.KITE_MCP_TOKEN || "");
process.stdin.resume();
process.stdin.on("end", () => {
  const line = (event) => process.stdout.write(JSON.stringify(event) + "\\n");
  line({ type: "thread.started", thread_id: "leak-thread" });
  line({ type: "turn.started" });
  line({
    type: "item.completed",
    item: { id: "item_0", type: "agent_message", text: "ok" },
  });
  line({
    type: "turn.completed",
    usage: {
      input_tokens: 0,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: 0,
      reasoning_output_tokens: 0,
    },
  });
});
`;
}

// Posts one MCP JSON-RPC call to a real /mcp connection and returns the
// live request alongside a promise for its eventual response, so the
// caller can destroy the socket mid-flight instead of waiting for it.
function callMcp(mcpUrl: URL, token: string, payload: unknown) {
  const req = httpRequest({
    hostname: mcpUrl.hostname,
    port: mcpUrl.port,
    path: mcpUrl.pathname,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: "Bearer " + token,
    },
  });
  const settled = new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      });
      req.on("error", reject);
    },
  );
  req.end(JSON.stringify(payload));
  return { req, settled };
}

// README.md promises: "If the agent's turn ends before you answer, the
// prompt closes without acting." tests/tools.test.ts covers the shape of
// that promise, but it builds its own `Request` and its own AbortController
// (see "open_application and point_on_screen both forward the request's
// own AbortSignal to the action" there), so it never touches production's
// @hono/node-server abort wiring at all. Checked by hand against
// @hono/node-server 2.1.1 (package.json's pinned version): the action's
// signal aborts about 11 ms after the client socket drops, with reason
// "Client connection prematurely closed." This test drives the real HTTP
// server startRuntime creates and drops a real socket mid-request, so a
// future @hono/node-server upgrade that silently stops wiring that abort
// through fails here instead of only in a manual check.
test("dropping the client connection while point_on_screen's action is pending aborts the action's real signal", async () => {
  const saved = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  const savedTelemetry = process.env.COPILOTKIT_TELEMETRY_DISABLED;
  const savedApiKey = process.env.OPENAI_API_KEY;
  let root: string | undefined;
  let runtime: Awaited<ReturnType<typeof startRuntime>> | undefined;
  let mcpRequest: ReturnType<typeof callMcp>["req"] | undefined;
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.COPILOTKIT_TELEMETRY_DISABLED = "true";
    // CodexRunner only checks this is set before it will spawn Codex at
    // all; the fixture binary below never reads it.
    process.env.OPENAI_API_KEY = "placeholder-for-the-mcp-token-fixture";
    const runtimeModule = await import("../server/runtime");
    root = await mkdtemp(join(tmpdir(), "kite-runtime-http-mcp-"));
    const store = new Store(join(root, "store"));
    await store.load();

    const tokenFile = join(root, "leaked-mcp-token.txt");
    const binaryPath = join(root, "fake-codex-leak.cjs");
    await writeFile(binaryPath, leakTokenFixtureSource(tokenFile), {
      mode: 0o755,
    });

    const screenshots = new ScreenshotRegistry();
    let seenSignal: AbortSignal | undefined;
    runtime = await runtimeModule.startRuntime(store, {
      statePath: join(root, "agent"),
      binaryPath,
      screenshots,
      action: async (_action, signal) => {
        seenSignal = signal;
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
      },
    });

    // One throwaway chat turn, purely to have the real Codex machinery
    // spawn the fixture above so it can leak the token /mcp checks.
    const leakRun = await fetch(runtime.settings.runtimeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + runtime.settings.runtimeToken,
        Accept: "text/event-stream",
      },
      body: JSON.stringify({
        method: "agent/run",
        params: { agentId: "default" },
        body: {
          threadId: "leak-thread-http",
          runId: "leak-thread-http-run",
          state: {},
          messages: [{ id: "leak-message", role: "user", content: "hello" }],
          tools: [],
          context: [],
          forwardedProps: {},
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    assert.equal(leakRun.status, 200, await leakRun.text());

    const mcpToken = (await readFile(tokenFile, "utf8")).trim();
    assert.ok(
      mcpToken,
      "expected the fixture Codex process to leak a bearer token",
    );

    const shot = screenshots.add({
      displayId: "1",
      label: "Test display",
      bounds: { x: 0, y: 0, width: 1920, height: 1080 },
      width: 1920,
      height: 1080,
    });

    const mcpUrl = new URL("/mcp", runtime.settings.runtimeUrl);
    const { req, settled } = callMcp(mcpUrl, mcpToken, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "point_on_screen",
        arguments: {
          screenshotId: shot.id,
          x: 10,
          y: 20,
          label: "Test target",
        },
      },
    });
    mcpRequest = req;
    // This request is deliberately dropped below before it ever gets a
    // response; swallow the resulting error instead of leaving it an
    // unhandled rejection.
    settled.catch(() => {});

    await waitFor(() => seenSignal !== undefined, { timeoutMs: 2_000 });
    assert.equal(seenSignal?.aborted, false);

    req.destroy();

    await waitFor(() => seenSignal?.aborted === true, { timeoutMs: 2_000 });
  } finally {
    mcpRequest?.destroy();
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    if (savedTelemetry === undefined)
      delete process.env.COPILOTKIT_TELEMETRY_DISABLED;
    else process.env.COPILOTKIT_TELEMETRY_DISABLED = savedTelemetry;
    if (savedApiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedApiKey;
    runtime?.close();
    if (root) await rm(root, { recursive: true, force: true });
  }
});
