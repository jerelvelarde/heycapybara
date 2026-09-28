import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import type { UserMessage } from "@ag-ui/core";
import { Store } from "../electron/store";
import {
  ScreenshotRegistry,
  describeScreenshot,
  unreferencedImageNote,
} from "../server/screenshots";
import { userContent } from "../src/message-content";
import { pngHeader } from "./png-fixture";

// These tests send a chat message down the production route: an HTTP
// `agent/run` POST into the runtime startRuntime builds, then CopilotKit's
// request parsing, agent clone and per-request middlewares, CodexRunner and
// the Codex SDK, out to the arguments and stdin of the `codex` CLI. That CLI
// is tests/fixtures/fake-codex.mjs, which records how it was called.

const FAKE_CODEX = fileURLToPath(
  new URL("./fixtures/fake-codex.mjs", import.meta.url),
);
// What the fake CLI replies with, for every prompt except the hang trigger
// below.
const FAKE_REPLY = "Fake Codex finished the turn.";
// Kept identical to tests/fixtures/fake-codex.mjs's own copy of this
// constant: that file is spawned as a separate process by the Codex SDK, so
// it can't import this, and duplicates it instead (the same way FAKE_REPLY's
// text is duplicated there).
const HANG_TRIGGER = "__FAKE_CODEX_HANG_UNTIL_KILLED__";

const CAPTURE = {
  displayId: "1",
  label: "Built-in Retina Display",
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  width: 1386,
  height: 900,
};

type CodexCall = {
  argv: string[];
  stdin: string;
  images: { size: number; header: string }[];
};
type RunEvent = { type: string; delta?: string; message?: string };
type Runtime = {
  server: NodeJS.EventEmitter;
  close(): void;
  settings: { runtimeUrl: string; runtimeToken: string };
};

// What startRuntime reads from the environment. Intelligence stays
// unconfigured, so the runtime never calls it, and Codex gets a placeholder
// key that only the fake CLI sees. CopilotKit's telemetry reads its switch
// once, when its module loads, so the runtime is imported only after this is
// applied.
const ENVIRONMENT: Record<string, string | undefined> = {
  COPILOTKIT_TELEMETRY_DISABLED: "true",
  OPENAI_API_KEY: "placeholder-for-the-fake-codex",
  CPK_INTELLIGENCE_API_KEY: undefined,
  CPK_INTELLIGENCE_LEARNING_CONTAINER_ID: undefined,
  KITE_MODEL: undefined,
};

function applyEnvironment() {
  const saved = Object.fromEntries(
    Object.keys(ENVIRONMENT).map((key) => [key, process.env[key]]),
  );
  const assign = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  };
  assign(ENVIRONMENT);
  return () => assign(saved);
}

// Refuses, and records, every outbound connection except one to the runtime
// on 127.0.0.1, so a run that tries to reach the network fails instead of
// reaching it. Node's fetch, http, https and tls clients all connect through
// Socket.prototype.connect.
function refuseNetwork() {
  const refused: string[] = [];
  const { connect } = Socket.prototype;
  Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
    // net.connect() hands over its already-parsed [options, listener] pair
    // as one array.
    const [options] = Array.isArray(args[0]) ? args[0] : args;
    const { host, port } = (options ?? {}) as {
      host?: unknown;
      port?: unknown;
    };
    if (host === "127.0.0.1") return Reflect.apply(connect, this, args);
    refused.push(`${String(host)}:${String(port)}`);
    // Fails the socket a tick later, the way a refused connection does, so
    // the caller finishes setting it up and gets the error. tls.connect, for
    // one, still needs the socket after this returns.
    process.nextTick(() =>
      this.destroy(new Error("This test refuses connections off 127.0.0.1")),
    );
    return this;
  } as typeof connect;
  return {
    refused,
    restore: () => {
      Socket.prototype.connect = connect;
    },
  };
}

async function closeRuntime(runtime: Runtime) {
  const closed = once(runtime.server, "close");
  runtime.close();
  await closed;
}

async function postRun(
  runtime: Runtime,
  threadId: string,
  content: UserMessage["content"],
) {
  const response = await fetch(runtime.settings.runtimeUrl, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + runtime.settings.runtimeToken,
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    // The single-route envelope CopilotKitProvider sends with
    // useSingleEndpoint (src/App.tsx).
    body: JSON.stringify({
      method: "agent/run",
      params: { agentId: "default" },
      body: {
        threadId,
        runId: `${threadId}-run`,
        state: {},
        messages: [{ id: `${threadId}-message`, role: "user", content }],
        tools: [],
        context: [],
        forwardedProps: {},
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  return { status: response.status, body: await response.text() };
}

// Sends `agent/stop` the way the renderer does: the single-route envelope
// @copilotkit/core's ProxiedCopilotRuntimeAgent.abortRun posts
// (node_modules/@copilotkit/core/dist/index.mjs). It adds a run-scoped
// `body: { runId }` whenever it has an active run recorded for this thread --
// which is every real Stop press, since the button only appears while a run
// is showing as active. `runId` stays an optional parameter here only to
// keep the thread-scoped shape (no `body` key) available too, for the one
// case the renderer itself falls back to it: no known runId for the thread.
async function postStop(runtime: Runtime, threadId: string, runId?: string) {
  const response = await fetch(runtime.settings.runtimeUrl, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + runtime.settings.runtimeToken,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      method: "agent/stop",
      params: { agentId: "default", threadId },
      ...(runId === undefined ? {} : { body: { runId } }),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  return { status: response.status, body: await response.json() };
}

// `process.kill(pid, 0)` sends no signal; it only checks whether `pid` is a
// process we could signal, throwing ESRCH once it is gone.
function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  { timeoutMs, intervalMs = 25 }: { timeoutMs: number; intervalMs?: number },
) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (Date.now() > deadline)
      throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
    await sleep(intervalMs);
  }
}

// Posts one user message to a fresh runtime and, once the run has finished
// without touching the network, returns the one call it made to the Codex
// CLI.
async function runThroughRuntime(
  screenshots: ScreenshotRegistry,
  threadId: string,
  content: UserMessage["content"],
): Promise<CodexCall> {
  const root = await mkdtemp(join(tmpdir(), "kite-runtime-e2e-"));
  const restoreEnvironment = applyEnvironment();
  const network = refuseNetwork();
  try {
    const { startRuntime } = await import("../server/runtime");
    const store = new Store(join(root, "store"));
    await store.load();
    // The SDK spawns the CLI itself rather than through node, so the copy it
    // runs must be executable.
    // `.mjs` makes Node treat this copy as ESM unambiguously: an
    // extensionless copy relies on Node's module-syntax detection, which
    // isn't available before Node 22.7 / 20.19 and would otherwise fail to
    // parse this fixture's `import` statements as CommonJS.
    const binaryPath = join(root, "codex.mjs");
    await copyFile(FAKE_CODEX, binaryPath);
    await chmod(binaryPath, 0o755);
    const statePath = join(root, "agent");
    const runtime = await startRuntime(store, {
      statePath,
      binaryPath,
      screenshots,
    });
    const response = await postRun(runtime, threadId, content).finally(() =>
      closeRuntime(runtime),
    );
    assert.deepEqual(
      network.refused,
      [],
      "the run tried to connect to something other than the runtime",
    );
    // With Intelligence off, the run takes the runtime's plain SSE path.
    assert.equal(runtime.settings.intelligenceConfigured, false);
    assert.equal(response.status, 200, response.body);
    const events = response.body
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as RunEvent);
    // The run finished: no error, the fake CLI's reply came back over HTTP,
    // and the stream ended on RUN_FINISHED.
    assert.deepEqual(
      events.filter((event) => event.type === "RUN_ERROR"),
      [],
    );
    assert.equal(
      events.find((event) => event.type === "TEXT_MESSAGE_CONTENT")?.delta,
      FAKE_REPLY,
    );
    assert.equal(events.at(-1)?.type, "RUN_FINISHED");
    // CodexRunner sets CODEX_HOME to <statePath>/codex, where the fake CLI
    // keeps its record.
    const calls = JSON.parse(
      await readFile(join(statePath, "codex", "fake-codex-calls.json"), "utf8"),
    ) as CodexCall[];
    assert.equal(calls.length, 1, "expected exactly one Codex CLI call");
    return calls[0];
  } finally {
    network.restore();
    restoreEnvironment();
    await rm(root, { recursive: true, force: true });
  }
}

const base64 = (png: Uint8Array) => Buffer.from(png).toString("base64");
// How the fake CLI identifies each image it was given.
const identify = (png: Uint8Array) => ({
  size: png.length,
  header: Buffer.from(png.subarray(0, 24)).toString("hex"),
});

test("a screenshot attached in the UI reaches the Codex CLI as its one --image, introduced by its id and size", async () => {
  const screenshots = new ScreenshotRegistry();
  const shot = screenshots.add(CAPTURE);
  const png = pngHeader(shot.width, shot.height);
  const content = userContent("Point at the menu", {
    id: shot.id,
    label: shot.label,
    width: shot.width,
    height: shot.height,
    dataUrl: "data:image/png;base64," + base64(png),
  });
  const call = await runThroughRuntime(screenshots, "e2e-referenced", content);
  assert.deepEqual(call.argv.slice(0, 2), ["exec", "--experimental-json"]);
  assert.ok(
    call.stdin.includes("Point at the menu"),
    `expected the prompt to carry the user's text, got ${JSON.stringify(call.stdin)}`,
  );
  assert.ok(
    call.stdin.includes(describeScreenshot(shot, 1)),
    `expected the prompt to describe ${shot.id}, got ${JSON.stringify(call.stdin)}`,
  );
  assert.equal(call.argv.filter((arg) => arg === "--image").length, 1);
  assert.deepEqual(call.images, [identify(png)]);
});

test("an image with no screen reference reaches the Codex CLI with the unreferenced note, even when a capture of its size exists", async () => {
  const screenshots = new ScreenshotRegistry();
  const shot = screenshots.add(CAPTURE);
  const png = pngHeader(shot.width, shot.height);
  const call = await runThroughRuntime(screenshots, "e2e-unreferenced", [
    { type: "text", text: "Point at the menu" },
    { type: "binary", mimeType: "image/png", data: base64(png) },
  ]);
  assert.ok(
    call.stdin.includes(unreferencedImageNote(1)),
    `expected the unreferenced note, got ${JSON.stringify(call.stdin)}`,
  );
  assert.ok(
    !call.stdin.includes(shot.id),
    "an image without an id must not be matched to a capture",
  );
  assert.equal(call.argv.filter((arg) => arg === "--image").length, 1);
  assert.deepEqual(call.images, [identify(png)]);
});

test("two attached images keep their order, so each note names the --image it describes", async () => {
  const screenshots = new ScreenshotRegistry();
  const shot = screenshots.add(CAPTURE);
  const referenced = pngHeader(shot.width, shot.height);
  const unreferenced = pngHeader(640, 480);
  const call = await runThroughRuntime(screenshots, "e2e-order", [
    { type: "text", text: "Compare these" },
    {
      type: "binary",
      mimeType: "image/png",
      data: base64(referenced),
      id: shot.id,
    },
    { type: "binary", mimeType: "image/png", data: base64(unreferenced) },
  ]);
  const first = call.stdin.indexOf(describeScreenshot(shot, 1));
  const second = call.stdin.indexOf(unreferencedImageNote(2));
  assert.ok(
    first !== -1 && second > first,
    `expected image 1's note before image 2's, got ${JSON.stringify(call.stdin)}`,
  );
  assert.deepEqual(call.images, [identify(referenced), identify(unreferenced)]);
});

// Reproduces the Stop button with Intelligence off: the renderer's Stop
// sends `agent/stop`, and the runtime's in-memory runner handles that by
// calling `agent.abortRun()` on the same (per-request) KiteCodexAgent
// instance that is running (@copilotkit/runtime's InMemoryAgentRunner.stop).
// The fake CLI's hang mode gives this test a Codex process that would run
// forever left alone, so it can prove `agent/stop` actually kills that
// process and ends the run as stopped, not just reports `stopped: true`
// while the process keeps going.
test("agent/stop ends a run and kills its Codex process, with Intelligence off", async () => {
  const root = await mkdtemp(join(tmpdir(), "kite-runtime-e2e-stop-"));
  const restoreEnvironment = applyEnvironment();
  const network = refuseNetwork();
  try {
    const { startRuntime } = await import("../server/runtime");
    const store = new Store(join(root, "store"));
    await store.load();
    // `.mjs` makes Node treat this copy as ESM unambiguously: an
    // extensionless copy relies on Node's module-syntax detection, which
    // isn't available before Node 22.7 / 20.19 and would otherwise fail to
    // parse this fixture's `import` statements as CommonJS.
    const binaryPath = join(root, "codex.mjs");
    await copyFile(FAKE_CODEX, binaryPath);
    await chmod(binaryPath, 0o755);
    const statePath = join(root, "agent");
    const runtime = await startRuntime(store, {
      statePath,
      binaryPath,
      screenshots: new ScreenshotRegistry(),
    });
    try {
      assert.equal(runtime.settings.intelligenceConfigured, false);
      const threadId = "e2e-stop";
      // Not awaited yet: the fake CLI hangs, so this run doesn't finish
      // until Stop ends it, below. Observed right away regardless: if an
      // assertion between here and the real `await runPromise` further down
      // throws first, this promise must still settle somewhere, or its
      // eventual rejection (once the runtime closes under it) becomes an
      // unhandled rejection instead.
      const runPromise = postRun(runtime, threadId, HANG_TRIGGER);
      void runPromise.catch(() => {});

      const recordPath = join(statePath, "codex", "fake-codex-calls.json");
      let pid: number | undefined;
      await waitUntil(
        async () => {
          try {
            const calls = JSON.parse(await readFile(recordPath, "utf8")) as {
              pid?: number;
            }[];
            pid = calls.find((call) => typeof call.pid === "number")?.pid;
          } catch {
            pid = undefined;
          }
          return pid !== undefined;
        },
        { timeoutMs: 10_000 },
      );
      assert.ok(pid, "expected the fake Codex CLI to record its pid");
      // Narrows to `number` for the closure below: a control-flow narrowing
      // from `assert.ok` above doesn't survive into a callback defined
      // afterwards.
      const activePid: number = pid;
      assert.ok(
        isAlive(activePid),
        "expected the fake Codex process to still be running before Stop",
      );

      // Matches what the renderer actually sends: a run is active for this
      // thread, so ProxiedCopilotRuntimeAgent.abortRun posts this run's own
      // runId in `body`, not the bodyless thread-scoped form.
      const stop = await postStop(runtime, threadId, `${threadId}-run`);
      assert.equal(stop.status, 200, JSON.stringify(stop.body));
      assert.equal(stop.body.stopped, true);

      // The load-bearing assertion: proves `agent/stop` actually kills the
      // Codex process instead of only marking the run as stopped while it
      // keeps running.
      await waitUntil(() => !isAlive(activePid), { timeoutMs: 2_000 });

      // Stop must also end the run itself, not just the process: the
      // renderer's fetch for `agent/run` has to resolve.
      const response = await runPromise;
      assert.equal(response.status, 200, response.body);
      const events = response.body
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice("data: ".length)) as RunEvent);
      assert.equal(events[0]?.type, "RUN_STARTED");
      const runError = events.find((event) => event.type === "RUN_ERROR");
      assert.ok(
        runError,
        `expected a RUN_ERROR event once Stop ended the run, got ${JSON.stringify(events)}`,
      );
      assert.equal(runError?.message, "Run stopped");
    } finally {
      await closeRuntime(runtime);
    }
    assert.deepEqual(
      network.refused,
      [],
      "the run tried to connect to something other than the runtime",
    );
  } finally {
    network.restore();
    restoreEnvironment();
    await rm(root, { recursive: true, force: true });
  }
});

// The kite MCP route takes only the token of a run that is still going
// (server/run-registry.ts). The fake CLI's hang mode records the token it
// was started with, so this calls the real /mcp route with it while the run
// hangs, Stops the run, and tries the same token again.
test("a run's MCP token works while the run is going and is refused once Stop ends it", async () => {
  const root = await mkdtemp(join(tmpdir(), "kite-runtime-e2e-token-"));
  const restoreEnvironment = applyEnvironment();
  const network = refuseNetwork();
  try {
    const { startRuntime } = await import("../server/runtime");
    const store = new Store(join(root, "store"));
    await store.load();
    const binaryPath = join(root, "codex.mjs");
    await copyFile(FAKE_CODEX, binaryPath);
    await chmod(binaryPath, 0o755);
    const statePath = join(root, "agent");
    const runtime = await startRuntime(store, {
      statePath,
      binaryPath,
      screenshots: new ScreenshotRegistry(),
    });
    try {
      const threadId = "e2e-token";
      const runPromise = postRun(runtime, threadId, HANG_TRIGGER);
      void runPromise.catch(() => {});
      const recordPath = join(statePath, "codex", "fake-codex-calls.json");
      let pid: number | undefined;
      let mcpToken: string | undefined;
      await waitUntil(
        async () => {
          try {
            const calls = JSON.parse(await readFile(recordPath, "utf8")) as {
              pid?: number;
              mcpToken?: string;
            }[];
            const hung = calls.find((call) => typeof call.pid === "number");
            pid = hung?.pid;
            mcpToken = hung?.mcpToken;
          } catch {
            pid = undefined;
          }
          return pid !== undefined && !!mcpToken;
        },
        { timeoutMs: 10_000 },
      );
      assert.ok(pid && mcpToken, "expected the hung fake CLI's pid and token");
      const hungPid: number = pid;
      const token: string = mcpToken;
      const listSkills = () =>
        fetch(new URL("/mcp", runtime.settings.runtimeUrl), {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
            Accept: "application/json, text/event-stream",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: { name: "list_local_skills", arguments: {} },
          }),
          signal: AbortSignal.timeout(10_000),
        });
      const live = await listSkills();
      assert.equal(live.status, 200);
      assert.equal((await live.json()).result.content[0].text, "[]");

      const stop = await postStop(runtime, threadId, `${threadId}-run`);
      assert.equal(stop.status, 200, JSON.stringify(stop.body));
      await waitUntil(() => !isAlive(hungPid), { timeoutMs: 2_000 });
      await runPromise;

      assert.equal((await listSkills()).status, 401);
    } finally {
      await closeRuntime(runtime);
    }
    assert.deepEqual(
      network.refused,
      [],
      "the run tried to connect to something other than the runtime",
    );
  } finally {
    network.restore();
    restoreEnvironment();
    await rm(root, { recursive: true, force: true });
  }
});
