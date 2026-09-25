import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
// What the fake CLI answers every prompt with.
const FAKE_REPLY = "Fake Codex finished the turn.";

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
type RunEvent = { type: string; delta?: string };
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
    const binaryPath = join(root, "codex");
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
