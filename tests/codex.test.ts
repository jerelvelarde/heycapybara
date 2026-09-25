import { test } from "node:test";
import assert from "node:assert/strict";
import { codexEvents } from "../server/codex-events";
import { RunRegistry, type AgentRun } from "../server/run-registry";
import { pngHeader } from "./png-fixture";
import { otherId } from "./test-ids";

test("Codex completion emits a single valid AG-UI text message", () => {
  const events = codexEvents({
    type: "item.completed",
    item: { id: "1", type: "agent_message", text: "Done" },
  });
  assert.deepEqual(
    events.map((e) => e.type),
    ["TEXT_MESSAGE_START", "TEXT_MESSAGE_CONTENT", "TEXT_MESSAGE_END"],
  );
  assert.equal(
    codexEvents({
      type: "item.updated",
      item: { id: "1", type: "agent_message", text: "D" },
    }).length,
    0,
  );
});
test("fatal Codex events fail the run instead of manufacturing success", () => {
  assert.throws(
    () => codexEvents({ type: "turn.failed", error: { message: "quota" } }),
    /quota/,
  );
  assert.throws(
    () => codexEvents({ type: "error", message: "offline" }),
    /offline/,
  );
});
test("command activity omits raw output and reasoning is never published", () => {
  const events = codexEvents({
    type: "item.completed",
    item: {
      type: "command_execution",
      id: "x",
      command: "pwd",
      aggregated_output: "private output",
      exit_code: 0,
      status: "completed",
    },
  });
  assert.ok(JSON.stringify(events).includes("pwd"));
  assert.ok(!JSON.stringify(events).includes("private output"));
  assert.equal(
    codexEvents({
      type: "item.completed",
      item: { type: "reasoning", id: "r", text: "private" },
    }).length,
    0,
  );
});

test("AG-UI adapter fails truncated streams and redacts key-shaped errors", async () => {
  const { KiteCodexAgent } = await import("../server/codex-agent");
  const events: { type: string; message?: string }[] = [];
  const agent = new KiteCodexAgent(async function* () {
    yield { type: "turn.started" };
  });
  await new Promise<void>((resolve) =>
    agent
      .run({
        threadId: "t",
        runId: "r",
        messages: [],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      })
      .subscribe({ next: (e) => events.push(e), complete: resolve }),
  );
  assert.deepEqual(
    events.map((e) => e.type),
    ["RUN_STARTED", "RUN_ERROR"],
  );
  const { safeAgentError } = await import("../server/codex-agent");
  assert.ok(
    !safeAgentError(new Error("invalid sk-test00000000000000000000")).includes(
      "sk-test",
    ),
  );
});

test("unsubscribing AG-UI aborts the native run", async () => {
  const { KiteCodexAgent } = await import("../server/codex-agent");
  let runSignal: AbortSignal | undefined;
  const agent = new KiteCodexAgent(async function* (_input, signal) {
    runSignal = signal;
    yield { type: "turn.started" };
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  });
  const subscription = agent
    .run({
      threadId: "t",
      runId: "r",
      messages: [],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    })
    .subscribe();
  subscription.unsubscribe();
  assert.equal(runSignal?.aborted, true);
});

test('abortRun() stops the active run: it aborts the run\'s signal and ends with RUN_ERROR "Run stopped"', async () => {
  const { KiteCodexAgent } = await import("../server/codex-agent");
  let runSignal: AbortSignal | undefined;
  const agent = new KiteCodexAgent(async function* (_input, signal) {
    runSignal = signal;
    yield { type: "turn.started" };
    // Mirrors CodexRunner.run's own defensive check in server/codex-agent.ts
    // (`if (outerSignal.aborted) controller.abort();`): a signal can already
    // be aborted by the time we get here, since `abortRun()` below runs
    // synchronously right after `subscribe()`, before this generator is
    // resumed past its first `yield`. Without this check, an
    // already-fired "abort" event would have no listener left to catch it.
    if (!signal.aborted)
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
    // The real Codex SDK rethrows Node's own AbortError once `spawn`'s
    // `signal` kills the child process, rather than letting the stream end
    // quietly (verified against Node: `name` "AbortError", `instanceof
    // Error` true). Throwing that same shape here is what actually
    // exercises KiteCodexAgent.run's `catch` branch the way a real Stop
    // does, instead of this test passing only because of the `for await`
    // loop's own post-loop `if (controller.signal.aborted)` check.
    const abortError = new Error("The operation was aborted");
    abortError.name = "AbortError";
    throw abortError;
  });
  const events: { type: string; message?: string }[] = [];
  const done = new Promise<void>((resolve) =>
    agent
      .run({
        threadId: "t",
        runId: "r",
        messages: [],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      })
      .subscribe({ next: (e) => events.push(e), complete: resolve }),
  );
  // Mirrors what the runtime's in-memory runner does on `agent/stop`: call
  // `abortRun()` on the same agent instance that is running (see
  // InMemoryAgentRunner.stop in @copilotkit/runtime), without unsubscribing.
  agent.abortRun();
  await done;
  assert.equal(runSignal?.aborted, true);
  assert.deepEqual(
    events.map((e) => e.type),
    ["RUN_STARTED", "RUN_ERROR"],
  );
  assert.equal(events[1]?.message, "Run stopped");
});

test("abortRun() called before run() has subscribed still stops the run it precedes", async () => {
  const { KiteCodexAgent } = await import("../server/codex-agent");
  let runSignal: AbortSignal | undefined;
  const agent = new KiteCodexAgent(async function* (_input, signal) {
    runSignal = signal;
    yield { type: "turn.started" };
  });
  // In production, `runAgent()` (@ag-ui/client's AbstractAgent) sets
  // `isRunning` true before it awaits its way to subscribing this agent's
  // `run()`, so a `Stop` can race in during that gap with `this.controller`
  // still unset. This test drives `run()` directly rather than through
  // `runAgent()`, so it sets `isRunning` itself to reproduce that same gap.
  // Without latching this request, it would be dropped on the floor, and
  // the run started right below would complete normally instead of ending
  // as stopped.
  agent.isRunning = true;
  agent.abortRun();
  const events: { type: string; message?: string }[] = [];
  await new Promise<void>((resolve) =>
    agent
      .run({
        threadId: "t",
        runId: "r",
        messages: [],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      })
      .subscribe({ next: (e) => events.push(e), complete: resolve }),
  );
  assert.equal(runSignal?.aborted, true);
  assert.deepEqual(
    events.map((e) => e.type),
    ["RUN_STARTED", "RUN_ERROR"],
  );
  assert.equal(events[1]?.message, "Run stopped");
});

test("abortRun() before any run is a no-op, and after a run finishes doesn't stop a later run on the same instance", async () => {
  const { KiteCodexAgent } = await import("../server/codex-agent");
  const agent = new KiteCodexAgent(async function* () {
    yield {
      type: "turn.completed",
      usage: {
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
      },
    };
  });
  // No run has ever started on this instance, so `isRunning` is still false
  // and there's no controller either: nothing to latch.
  assert.doesNotThrow(() => agent.abortRun());
  await new Promise<void>((resolve) =>
    agent
      .run({
        threadId: "t",
        runId: "r",
        messages: [],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      })
      .subscribe({ complete: resolve }),
  );
  // The bug this guards: an `abortRun()` that arrives after a run has
  // already finished must not latch and silently stop the NEXT run on this
  // same instance. Production clones a fresh agent per request, so this
  // exact sequence is harmless today, but the semantics shouldn't depend on
  // that.
  assert.doesNotThrow(() => agent.abortRun());
  const events: { type: string; message?: string }[] = [];
  await new Promise<void>((resolve) =>
    agent
      .run({
        threadId: "t",
        runId: "r",
        messages: [],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      })
      .subscribe({ next: (e) => events.push(e), complete: resolve }),
  );
  assert.deepEqual(
    events.map((e) => e.type),
    ["RUN_STARTED", "RUN_FINISHED"],
  );
});

test("Codex receives only allowlisted environment and isolated shell home", async () => {
  const { codexEnvironment } = await import("../server/codex-agent");
  process.env.KITE_TEST_UNRELATED_SECRET = "fixture-secret";
  try {
    const env = codexEnvironment(
      "/private/codex",
      "/private/shell-home",
      "fixture-token",
    );
    assert.equal(env.HOME, "/private/shell-home");
    assert.equal(env.ZDOTDIR, env.HOME);
    assert.equal(env.BASH_ENV, "/dev/null");
    assert.ok(!JSON.stringify(env).includes("fixture-secret"));
  } finally {
    delete process.env.KITE_TEST_UNRELATED_SECRET;
  }
});

test("a Stop that lands during prompt preparation never starts the native run", async () => {
  const { CodexRunner } = await import("../server/codex-agent");
  const { ScreenshotRegistry } = await import("../server/screenshots");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "kite-prepare-abort-test-"));
  let runStreamedCalls = 0;
  const runner = new CodexRunner({
    runs: new RunRegistry(),
    statePath: root,
    screenshots: new ScreenshotRegistry(),
    getConfig: () => ({
      apiKey: "fixture-key",
      model: "gpt-5.4",
      workspace: "/test/one",
      mcpUrl: "http://localhost/mcp",
    }),
    createClient: () => ({
      startThread: () => ({
        runStreamed: async () => {
          runStreamedCalls += 1;
          throw new Error("runStreamed should not be called");
        },
      }),
      resumeThread: () => {
        throw new Error("Unexpected resume");
      },
    }),
  });
  const controller = new AbortController();
  const iterator = runner.run(
    {
      threadId: "prepare-abort",
      runId: "r",
      messages: [{ id: "m", role: "user", content: "hello" }],
      tools: [],
      context: [],
      state: {},
      forwardedProps: {},
    },
    controller.signal,
  );
  try {
    // `run()` is an async generator: calling `.next()` starts it running
    // from the top (mkdir, the thread mapping, ...) but suspends at its
    // first `await` without this test awaiting anything yet, so aborting
    // synchronously right after -- on the same tick, before that first
    // `await mkdir(...)` can resolve -- reproduces a Stop landing while
    // preparation is still in flight, well before `thread.runStreamed`.
    const first = iterator.next();
    controller.abort();
    await assert.rejects(first, /Run stopped/);
    assert.equal(runStreamedCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("conversations resume their own native thread and reject workspace changes", async () => {
  const { CodexRunner } = await import("../server/codex-agent");
  const { ScreenshotRegistry } = await import("../server/screenshots");
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "kite-thread-test-"));
  const resumed: string[] = [];
  let counter = 0;
  let workspace = "/test/one";
  const fakeThread = (id: string) => ({
    runStreamed: async () => ({
      events: (async function* () {
        yield { type: "thread.started" as const, thread_id: id };
      })(),
    }),
  });
  const runner = new CodexRunner({
    runs: new RunRegistry(),
    statePath: root,
    screenshots: new ScreenshotRegistry(),
    getConfig: () => ({
      apiKey: "fixture-key",
      model: "gpt-5.4",
      workspace,
      mcpUrl: "http://localhost/mcp",
    }),
    createClient: (options) => {
      assert.equal(options.config?.allow_login_shell, false);
      assert.deepEqual(options.config?.features, { shell_snapshot: false });
      const policy = options.config?.shell_environment_policy;
      assert.ok(policy && typeof policy === "object" && !Array.isArray(policy));
      assert.equal(policy.inherit, "none");
      assert.deepEqual(policy.exclude, [
        "CODEX_API_KEY",
        "OPENAI_API_KEY",
        "KITE_MCP_TOKEN",
      ]);
      const mcpServers = options.config?.mcp_servers;
      assert.ok(
        mcpServers &&
          typeof mcpServers === "object" &&
          !Array.isArray(mcpServers),
      );
      const kite = mcpServers.kite;
      assert.ok(kite && typeof kite === "object" && !Array.isArray(kite));
      // Pinned ourselves rather than left to Codex's own default, so an
      // upstream Codex change can't silently move this out from under us.
      assert.equal(kite.tool_timeout_sec, 300);
      return {
        startThread: () => fakeThread("native-" + ++counter),
        resumeThread: (id) => {
          resumed.push(id);
          return fakeThread(id);
        },
      };
    },
  });
  const run = async (threadId: string) => {
    for await (const event of runner.run(
      {
        threadId,
        runId: "r",
        messages: [{ id: "m", role: "user", content: "hello" }],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
      new AbortController().signal,
    )) {
      assert.equal(event.type, "thread.started");
    }
  };
  try {
    await run("one");
    await run("two");
    await run("one");
    assert.deepEqual(resumed, ["native-1"]);
    const saved = await readFile(join(root, "threads/one.json"), "utf8");
    assert.ok(!saved.includes("fixture-key"));
    workspace = "/test/two";
    await assert.rejects(run("one"), /Workspace changed/);
    assert.equal(runner.busy, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("attached screenshots are introduced with their id, display and pixel size", async () => {
  const { CodexRunner, instructions } = await import("../server/codex-agent");
  const { ScreenshotRegistry } = await import("../server/screenshots");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "kite-prompt-test-"));
  const screenshots = new ScreenshotRegistry();
  const shot = screenshots.add({
    displayId: "1",
    label: "Built-in Retina Display",
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
    width: 1386,
    height: 900,
  });
  let prompt: unknown;
  const runner = new CodexRunner({
    runs: new RunRegistry(),
    statePath: root,
    screenshots,
    getConfig: () => ({
      apiKey: "fixture-key",
      model: "gpt-5.4",
      workspace: "/test/one",
      mcpUrl: "http://localhost/mcp",
    }),
    createClient: () => ({
      startThread: () => ({
        runStreamed: async (input) => {
          prompt = input;
          return {
            events: (async function* () {
              yield { type: "thread.started" as const, thread_id: "native-1" };
            })(),
          };
        },
      }),
      resumeThread: () => {
        throw new Error("Unexpected resume");
      },
    }),
  });
  const referenced = Buffer.from(pngHeader(1386, 900)).toString("base64");
  const unreferenced = Buffer.from(pngHeader(640, 480)).toString("base64");
  try {
    const events = runner.run(
      {
        threadId: "prompt",
        runId: "r",
        messages: [
          {
            id: "m",
            role: "user",
            content: [
              { type: "text", text: "Where is Export?" },
              {
                type: "binary",
                mimeType: "image/png",
                data: referenced,
                id: shot.id,
              },
              { type: "binary", mimeType: "image/png", data: unreferenced },
            ],
          },
        ],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
      new AbortController().signal,
    );
    for await (const event of events)
      assert.equal(event.type, "thread.started");
    const parts = prompt as { type: string; text?: string }[];
    assert.deepEqual(
      parts.map((part) => part.type),
      ["text", "text", "local_image", "text", "local_image"],
    );
    assert.match(parts[1].text ?? "", /^Image 1 in this message is screenshot/);
    assert.match(parts[1].text ?? "", new RegExp(shot.id));
    assert.match(parts[1].text ?? "", /1386×900 pixels/);
    assert.match(parts[1].text ?? "", /Built-in Retina Display/);
    assert.match(parts[1].text ?? "", /origin at the top-left/);
    assert.match(
      parts[3].text ?? "",
      /^Image 2 in this message has no screen reference/,
    );
    assert.match(instructions, /never guess screen coordinates/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a screenshot whose attached image doesn't match the registered capture size is named as a mismatch", async () => {
  const { CodexRunner } = await import("../server/codex-agent");
  const { ScreenshotRegistry } = await import("../server/screenshots");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "kite-prompt-mismatch-test-"));
  const screenshots = new ScreenshotRegistry();
  const shot = screenshots.add({
    displayId: "1",
    label: "Built-in Retina Display",
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
    width: 1386,
    height: 900,
  });
  let prompt: unknown;
  const runner = new CodexRunner({
    runs: new RunRegistry(),
    statePath: root,
    screenshots,
    getConfig: () => ({
      apiKey: "fixture-key",
      model: "gpt-5.4",
      workspace: "/test/one",
      mcpUrl: "http://localhost/mcp",
    }),
    createClient: () => ({
      startThread: () => ({
        runStreamed: async (input) => {
          prompt = input;
          return {
            events: (async function* () {
              yield { type: "thread.started" as const, thread_id: "native-1" };
            })(),
          };
        },
      }),
      resumeThread: () => {
        throw new Error("Unexpected resume");
      },
    }),
  });
  const mismatched = Buffer.from(pngHeader(100, 100)).toString("base64");
  try {
    const events = runner.run(
      {
        threadId: "prompt",
        runId: "r",
        messages: [
          {
            id: "m",
            role: "user",
            content: [
              {
                type: "binary",
                mimeType: "image/png",
                data: mismatched,
                id: shot.id,
              },
            ],
          },
        ],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
      new AbortController().signal,
    );
    for await (const event of events)
      assert.equal(event.type, "thread.started");
    const parts = prompt as { type: string; text?: string }[];
    assert.match(
      parts[0].text ?? "",
      /^Image 1 in this message doesn't match the screenshot it names/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a screenshot capture older than 10 minutes is described as too stale to point at", async () => {
  const { CodexRunner } = await import("../server/codex-agent");
  const { ScreenshotRegistry } = await import("../server/screenshots");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "kite-prompt-stale-test-"));
  const screenshots = new ScreenshotRegistry(
    16,
    () => Date.now() - 11 * 60 * 1000,
  );
  const shot = screenshots.add({
    displayId: "1",
    label: "Built-in Retina Display",
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
    width: 1386,
    height: 900,
  });
  let prompt: unknown;
  const runner = new CodexRunner({
    runs: new RunRegistry(),
    statePath: root,
    screenshots,
    getConfig: () => ({
      apiKey: "fixture-key",
      model: "gpt-5.4",
      workspace: "/test/one",
      mcpUrl: "http://localhost/mcp",
    }),
    createClient: () => ({
      startThread: () => ({
        runStreamed: async (input) => {
          prompt = input;
          return {
            events: (async function* () {
              yield { type: "thread.started" as const, thread_id: "native-1" };
            })(),
          };
        },
      }),
      resumeThread: () => {
        throw new Error("Unexpected resume");
      },
    }),
  });
  const image = Buffer.from(pngHeader(1386, 900)).toString("base64");
  try {
    const events = runner.run(
      {
        threadId: "prompt",
        runId: "r",
        messages: [
          {
            id: "m",
            role: "user",
            content: [
              {
                type: "binary",
                mimeType: "image/png",
                data: image,
                id: shot.id,
              },
            ],
          },
        ],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
      new AbortController().signal,
    );
    for await (const event of events)
      assert.equal(event.type, "thread.started");
    const parts = prompt as { type: string; text?: string }[];
    assert.match(
      parts[0].text ?? "",
      /^Image 1 in this message is a screenshot that is too old to point at, or whose capture time is unknown\./,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a binary attachment that isn't actually a PNG is rejected even when labelled image/png", async () => {
  const { CodexRunner } = await import("../server/codex-agent");
  const { ScreenshotRegistry } = await import("../server/screenshots");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "kite-prompt-badpng-test-"));
  const runner = new CodexRunner({
    runs: new RunRegistry(),
    statePath: root,
    screenshots: new ScreenshotRegistry(),
    getConfig: () => ({
      apiKey: "fixture-key",
      model: "gpt-5.4",
      workspace: "/test/one",
      mcpUrl: "http://localhost/mcp",
    }),
    createClient: () => ({
      startThread: () => ({
        runStreamed: async () => {
          throw new Error("runStreamed should not be called");
        },
      }),
      resumeThread: () => {
        throw new Error("Unexpected resume");
      },
    }),
  });
  const notAPng = Buffer.from("not actually a png").toString("base64");
  try {
    await assert.rejects(async () => {
      for await (const event of runner.run(
        {
          threadId: "prompt",
          runId: "r",
          messages: [
            {
              id: "m",
              role: "user",
              content: [
                { type: "binary", mimeType: "image/png", data: notAPng },
              ],
            },
          ],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
        new AbortController().signal,
      ))
        assert.equal(event.type, "thread.started");
    }, /Image 1 is not a valid PNG image/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a binary part whose MIME type isn't image/png is rejected before decoding", async () => {
  const { CodexRunner } = await import("../server/codex-agent");
  const { ScreenshotRegistry } = await import("../server/screenshots");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "kite-prompt-mimetype-test-"));
  const runner = new CodexRunner({
    runs: new RunRegistry(),
    statePath: root,
    screenshots: new ScreenshotRegistry(),
    getConfig: () => ({
      apiKey: "fixture-key",
      model: "gpt-5.4",
      workspace: "/test/one",
      mcpUrl: "http://localhost/mcp",
    }),
    createClient: () => ({
      startThread: () => ({
        runStreamed: async () => {
          throw new Error("runStreamed should not be called");
        },
      }),
      resumeThread: () => {
        throw new Error("Unexpected resume");
      },
    }),
  });
  const image = Buffer.from(pngHeader(10, 10)).toString("base64");
  try {
    await assert.rejects(async () => {
      for await (const event of runner.run(
        {
          threadId: "prompt",
          runId: "r",
          messages: [
            {
              id: "m",
              role: "user",
              content: [
                { type: "binary", mimeType: "image/jpeg", data: image },
              ],
            },
          ],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
        new AbortController().signal,
      ))
        assert.equal(event.type, "thread.started");
    }, /Attachment 1 is not a PNG screenshot\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a binary image part with no data is rejected", async () => {
  const { CodexRunner } = await import("../server/codex-agent");
  const { ScreenshotRegistry } = await import("../server/screenshots");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "kite-prompt-nodata-test-"));
  const runner = new CodexRunner({
    runs: new RunRegistry(),
    statePath: root,
    screenshots: new ScreenshotRegistry(),
    getConfig: () => ({
      apiKey: "fixture-key",
      model: "gpt-5.4",
      workspace: "/test/one",
      mcpUrl: "http://localhost/mcp",
    }),
    createClient: () => ({
      startThread: () => ({
        runStreamed: async () => {
          throw new Error("runStreamed should not be called");
        },
      }),
      resumeThread: () => {
        throw new Error("Unexpected resume");
      },
    }),
  });
  try {
    await assert.rejects(async () => {
      for await (const event of runner.run(
        {
          threadId: "prompt",
          runId: "r",
          messages: [
            {
              id: "m",
              role: "user",
              content: [{ type: "binary", mimeType: "image/png" }],
            },
          ],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
        new AbortController().signal,
      ))
        assert.equal(event.type, "thread.started");
    }, /Image 1 has no image data\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an image's data length boundary: 16,000,000 characters passes, 16,000,001 is rejected", async () => {
  const { CodexRunner } = await import("../server/codex-agent");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "kite-prompt-sizelimit-test-"));
  const { ScreenshotRegistry } = await import("../server/screenshots");
  const makeRunner = () =>
    new CodexRunner({
      runs: new RunRegistry(),
      statePath: root,
      screenshots: new ScreenshotRegistry(),
      getConfig: () => ({
        apiKey: "fixture-key",
        model: "gpt-5.4",
        workspace: "/test/one",
        mcpUrl: "http://localhost/mcp",
      }),
      createClient: () => ({
        startThread: () => ({
          runStreamed: async () => ({
            events: (async function* () {
              yield {
                type: "thread.started" as const,
                thread_id: "native-1",
              };
            })(),
          }),
        }),
        resumeThread: () => {
          throw new Error("Unexpected resume");
        },
      }),
    });
  const runWith = async (threadId: string, data: string) => {
    for await (const event of makeRunner().run(
      {
        threadId,
        runId: "r",
        messages: [
          {
            id: "m",
            role: "user",
            content: [{ type: "binary", mimeType: "image/png", data }],
          },
        ],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
      new AbortController().signal,
    ))
      assert.equal(event.type, "thread.started");
  };
  try {
    // Base64 has no padding when the byte length is a multiple of 3, and
    // encodes to exactly 4 characters per 3 bytes, so 12,000,000 PNG-shaped
    // bytes produce exactly the 16,000,000-character limit, with a valid PNG
    // header in the first 33 bytes so the run completes past the size check.
    const atLimitBytes = Buffer.alloc(12_000_000);
    atLimitBytes.set(pngHeader(10, 10));
    const atLimit = atLimitBytes.toString("base64");
    assert.equal(atLimit.length, 16_000_000);
    // Distinct thread ids: a shared one would make the second run resume the
    // first run's saved native thread instead of starting fresh.
    await runWith("at-limit", atLimit);

    const overLimit = "a".repeat(16_000_001);
    await assert.rejects(
      runWith("over-limit", overLimit),
      /Image 1 is larger than 12 MB\./,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a content part that is neither text nor binary is rejected as an unsupported, numbered attachment", async () => {
  const { CodexRunner } = await import("../server/codex-agent");
  const { ScreenshotRegistry } = await import("../server/screenshots");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "kite-prompt-unsupported-test-"));
  const runner = new CodexRunner({
    runs: new RunRegistry(),
    statePath: root,
    screenshots: new ScreenshotRegistry(),
    getConfig: () => ({
      apiKey: "fixture-key",
      model: "gpt-5.4",
      workspace: "/test/one",
      mcpUrl: "http://localhost/mcp",
    }),
    createClient: () => ({
      startThread: () => ({
        runStreamed: async () => {
          throw new Error("runStreamed should not be called");
        },
      }),
      resumeThread: () => {
        throw new Error("Unexpected resume");
      },
    }),
  });
  // A valid image occupies attachment 1, so the unsupported part must be
  // named 2: proving the count advances across kinds, not just always "1".
  const validImage = Buffer.from(pngHeader(10, 10)).toString("base64");
  try {
    await assert.rejects(async () => {
      for await (const event of runner.run(
        {
          threadId: "prompt",
          runId: "r",
          messages: [
            {
              id: "m",
              role: "user",
              content: [
                { type: "binary", mimeType: "image/png", data: validImage },
                {
                  type: "image",
                  source: {
                    type: "data",
                    value: "abc",
                    mimeType: "image/png",
                  },
                },
              ],
            },
          ],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
        new AbortController().signal,
      ))
        assert.equal(event.type, "thread.started");
    }, /Attachment 2 \(image\) is not supported\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a recovered conversation keeps the text a user typed alongside an earlier image", async () => {
  const { CodexRunner } = await import("../server/codex-agent");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "kite-history-test-"));
  const { ScreenshotRegistry } = await import("../server/screenshots");
  let prompt: unknown;
  const runner = new CodexRunner({
    runs: new RunRegistry(),
    statePath: root,
    screenshots: new ScreenshotRegistry(),
    getConfig: () => ({
      apiKey: "fixture-key",
      model: "gpt-5.4",
      workspace: "/test/one",
      mcpUrl: "http://localhost/mcp",
    }),
    createClient: () => ({
      startThread: () => ({
        runStreamed: async (input) => {
          prompt = input;
          return {
            events: (async function* () {
              yield {
                type: "thread.started" as const,
                thread_id: "native-1",
              };
            })(),
          };
        },
      }),
      resumeThread: () => {
        throw new Error("Unexpected resume");
      },
    }),
  });
  const earlierImage = Buffer.from(pngHeader(10, 10)).toString("base64");
  try {
    // No saved thread mapping exists yet for "recovered", and there is more
    // than one message, so the runner rebuilds history from `messages`
    // instead of resuming a native thread.
    const events = runner.run(
      {
        threadId: "recovered",
        runId: "r",
        messages: [
          {
            id: "earlier",
            role: "user",
            content: [
              { type: "text", text: "Here is where I clicked" },
              { type: "binary", mimeType: "image/png", data: earlierImage },
            ],
          },
          { id: "latest", role: "user", content: "What did you see?" },
        ],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
      new AbortController().signal,
    );
    for await (const event of events)
      assert.equal(event.type, "thread.started");
    const parts = prompt as { type: string; text?: string }[];
    const historyPart = parts.find((part) =>
      part.text?.startsWith("Previous conversation"),
    );
    assert.ok(historyPart, "expected a previous-conversation history part");
    assert.match(historyPart?.text ?? "", /Here is where I clicked/);
    assert.match(historyPart?.text ?? "", /\[image omitted\]/);
    assert.ok(
      !historyPart?.text?.includes(earlierImage),
      "the image's base64 data must not leak into the recovered history text",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recovered history labels an image part distinctly from audio, video, document and non-image binary attachments", async () => {
  const { CodexRunner } = await import("../server/codex-agent");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "kite-history-kinds-test-"));
  const { ScreenshotRegistry } = await import("../server/screenshots");
  let prompt: unknown;
  const runner = new CodexRunner({
    runs: new RunRegistry(),
    statePath: root,
    screenshots: new ScreenshotRegistry(),
    getConfig: () => ({
      apiKey: "fixture-key",
      model: "gpt-5.4",
      workspace: "/test/one",
      mcpUrl: "http://localhost/mcp",
    }),
    createClient: () => ({
      startThread: () => ({
        runStreamed: async (input) => {
          prompt = input;
          return {
            events: (async function* () {
              yield {
                type: "thread.started" as const,
                thread_id: "native-1",
              };
            })(),
          };
        },
      }),
      resumeThread: () => {
        throw new Error("Unexpected resume");
      },
    }),
  });
  try {
    // No saved thread mapping exists yet for "recovered-kinds", and there is
    // more than one message, so the runner rebuilds history from `messages`
    // instead of resuming a native thread.
    const events = runner.run(
      {
        threadId: "recovered-kinds",
        runId: "r",
        messages: [
          {
            id: "earlier",
            role: "user",
            content: [
              { type: "text", text: "Mixed attachments" },
              {
                type: "binary",
                mimeType: "image/png",
                data: Buffer.from(pngHeader(10, 10)).toString("base64"),
              },
              {
                type: "image",
                source: { type: "data", value: "abc", mimeType: "image/png" },
              },
              {
                type: "audio",
                source: { type: "data", value: "abc", mimeType: "audio/wav" },
              },
              {
                type: "video",
                source: { type: "data", value: "abc", mimeType: "video/mp4" },
              },
              {
                type: "document",
                source: {
                  type: "data",
                  value: "abc",
                  mimeType: "application/pdf",
                },
              },
              {
                type: "binary",
                mimeType: "application/pdf",
                data: "abc",
              },
            ],
          },
          { id: "latest", role: "user", content: "What did you see?" },
        ],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
      new AbortController().signal,
    );
    for await (const event of events)
      assert.equal(event.type, "thread.started");
    const parts = prompt as { type: string; text?: string }[];
    const historyPart = parts.find((part) =>
      part.text?.startsWith("Previous conversation"),
    );
    assert.ok(historyPart, "expected a previous-conversation history part");
    const text = historyPart?.text ?? "";
    assert.match(text, /Mixed attachments/);
    // One "binary" image/png part and one "image" part: exactly two image
    // labels.
    assert.equal(text.match(/\[image omitted\]/g)?.length, 2);
    // audio, video, document, and a non-image "binary" part: exactly four
    // attachment labels.
    assert.equal(text.match(/\[attachment omitted\]/g)?.length, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a RunAgentInput built with userContent and validated by RunAgentInputSchema keeps the screenshot id through to its note", async () => {
  const { CodexRunner } = await import("../server/codex-agent");
  const { ScreenshotRegistry } = await import("../server/screenshots");
  const { userContent } = await import("../src/message-content");
  const { RunAgentInputSchema } = await import("@ag-ui/core");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "kite-agui-schema-test-"));
  const screenshots = new ScreenshotRegistry();
  const shot = screenshots.add({
    displayId: "1",
    label: "Built-in Retina Display",
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
    width: 1386,
    height: 900,
  });
  const dataUrl =
    "data:image/png;base64," +
    Buffer.from(pngHeader(1386, 900)).toString("base64");
  const content = userContent("Where is Export?", {
    id: shot.id,
    label: shot.label,
    width: shot.width,
    height: shot.height,
    dataUrl,
  });
  const input = RunAgentInputSchema.parse({
    threadId: "prompt",
    runId: "r",
    messages: [{ id: "m", role: "user", content }],
    tools: [],
    context: [],
    state: {},
    forwardedProps: {},
  });
  let prompt: unknown;
  const runner = new CodexRunner({
    runs: new RunRegistry(),
    statePath: root,
    screenshots,
    getConfig: () => ({
      apiKey: "fixture-key",
      model: "gpt-5.4",
      workspace: "/test/one",
      mcpUrl: "http://localhost/mcp",
    }),
    createClient: () => ({
      startThread: () => ({
        runStreamed: async (streamed) => {
          prompt = streamed;
          return {
            events: (async function* () {
              yield {
                type: "thread.started" as const,
                thread_id: "native-1",
              };
            })(),
          };
        },
      }),
      resumeThread: () => {
        throw new Error("Unexpected resume");
      },
    }),
  });
  try {
    for await (const event of runner.run(input, new AbortController().signal))
      assert.equal(event.type, "thread.started");
    const parts = prompt as { type: string; text?: string }[];
    const note = parts.find((part) => part.text?.includes(shot.id));
    assert.ok(note, "expected a prompt part naming the screenshot id");
    assert.match(note?.text ?? "", /^Image 1 in this message is screenshot/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the real AG-UI middleware pipeline still carries the screenshot id on a binary content part", async () => {
  const { KiteCodexAgent } = await import("../server/codex-agent");
  const { userContent } = await import("../src/message-content");
  let recorded: unknown;
  const agent = new KiteCodexAgent(async function* (input) {
    recorded = input;
    yield {
      type: "turn.completed",
      usage: {
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
      },
    };
  });
  const dataUrl =
    "data:image/png;base64," +
    Buffer.from(pngHeader(10, 10)).toString("base64");
  agent.addMessage({
    id: "m",
    role: "user",
    content: userContent("hi", {
      id: "shot_deadbeef",
      label: "Test Display",
      width: 10,
      height: 10,
      dataUrl,
    }),
  });
  await agent.runAgent();
  const messages = (recorded as { messages: { content: unknown }[] }).messages;
  const content = messages[0]?.content as
    { type: string; id?: string }[] | undefined;
  const binaryPart = content?.find((part) => part.type === "binary");
  assert.equal(binaryPart?.type, "binary");
  assert.equal(binaryPart?.id, "shot_deadbeef");
});

type NoteRow = {
  name: string;
  runnerHasCapture: boolean;
  registryNow?: () => number;
  imageSize: { width: number; height: number };
  referenceId: "valid" | "unknown" | "none";
  opening: string;
};

// Shared setup for the note-state matrix below. `registry.add` always runs,
// so the capture always exists in a registry -- backdated or forward-dated
// when the row sets `registryNow`, to land it outside the freshness window
// either way. Attaches a single image referencing the capture (or not), and
// returns the first prompt part's text -- the note codex-agent.ts chose for
// that state.
async function firstNoteFor(row: NoteRow) {
  const { CodexRunner } = await import("../server/codex-agent");
  const { ScreenshotRegistry } = await import("../server/screenshots");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "kite-prompt-matrix-"));
  const registry = new ScreenshotRegistry(16, row.registryNow);
  const shot = registry.add({
    displayId: "1",
    label: "Built-in Retina Display",
    bounds: { x: 0, y: 0, width: 1512, height: 982 },
    width: 1386,
    height: 900,
  });
  let prompt: unknown;
  const runner = new CodexRunner({
    runs: new RunRegistry(),
    statePath: root,
    screenshots: row.runnerHasCapture ? registry : new ScreenshotRegistry(),
    getConfig: () => ({
      apiKey: "fixture-key",
      model: "gpt-5.4",
      workspace: "/test/one",
      mcpUrl: "http://localhost/mcp",
    }),
    createClient: () => ({
      startThread: () => ({
        runStreamed: async (input) => {
          prompt = input;
          return {
            events: (async function* () {
              yield {
                type: "thread.started" as const,
                thread_id: "native-1",
              };
            })(),
          };
        },
      }),
      resumeThread: () => {
        throw new Error("Unexpected resume");
      },
    }),
  });
  const image = Buffer.from(
    pngHeader(row.imageSize.width, row.imageSize.height),
  ).toString("base64");
  const id =
    row.referenceId === "valid"
      ? shot.id
      : row.referenceId === "unknown"
        ? otherId(shot.id)
        : undefined;
  try {
    const events = runner.run(
      {
        threadId: "prompt",
        runId: "r",
        messages: [
          {
            id: "m",
            role: "user",
            content: [
              { type: "binary", mimeType: "image/png", data: image, id },
            ],
          },
        ],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
      new AbortController().signal,
    );
    for await (const event of events)
      assert.equal(event.type, "thread.started");
    const parts = prompt as { type: string; text?: string }[];
    return parts[0]?.text ?? "";
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("screenshot notes cover every state, checked in the documented order", async () => {
  const rows: NoteRow[] = [
    {
      name: "fresh",
      runnerHasCapture: true,
      imageSize: { width: 1386, height: 900 },
      referenceId: "valid",
      opening: "Image 1 in this message is screenshot",
    },
    {
      name: "stale",
      runnerHasCapture: true,
      registryNow: () => Date.now() - 11 * 60 * 1000,
      imageSize: { width: 1386, height: 900 },
      referenceId: "valid",
      opening:
        "Image 1 in this message is a screenshot that is too old to point at, or whose capture time is unknown.",
    },
    {
      name: "wrong size",
      runnerHasCapture: true,
      imageSize: { width: 100, height: 100 },
      referenceId: "valid",
      opening: "Image 1 in this message doesn't match the screenshot it names",
    },
    {
      name: "stale and wrong size (must be mismatched)",
      runnerHasCapture: true,
      registryNow: () => Date.now() - 11 * 60 * 1000,
      imageSize: { width: 100, height: 100 },
      referenceId: "valid",
      opening: "Image 1 in this message doesn't match the screenshot it names",
    },
    {
      name: "future capture time",
      runnerHasCapture: true,
      registryNow: () => Date.now() + 5 * 60 * 1000,
      imageSize: { width: 1386, height: 900 },
      referenceId: "valid",
      opening:
        "Image 1 in this message is a screenshot that is too old to point at, or whose capture time is unknown.",
    },
    {
      name: "unknown id",
      runnerHasCapture: true,
      imageSize: { width: 1386, height: 900 },
      referenceId: "unknown",
      opening:
        "Image 1 in this message names a screenshot OpenMuse doesn't have",
    },
    {
      name: "no id",
      runnerHasCapture: true,
      imageSize: { width: 1386, height: 900 },
      referenceId: "none",
      opening: "Image 1 in this message has no screen reference",
    },
    {
      name: "runner whose registry is empty, given an id it doesn't have (must be unknown)",
      runnerHasCapture: false,
      imageSize: { width: 1386, height: 900 },
      referenceId: "valid",
      opening:
        "Image 1 in this message names a screenshot OpenMuse doesn't have",
    },
  ];
  for (const row of rows) {
    const note = await firstNoteFor(row);
    assert.ok(
      note.startsWith(row.opening),
      `${row.name}: expected note to start with ${JSON.stringify(row.opening)}, got ${JSON.stringify(note)}`,
    );
  }
});

test("the system instructions tell the agent to name the target with a short label", async () => {
  const { instructions } = await import("../server/codex-agent");
  assert.match(instructions, /a short label naming the target/);
});

test("temp screenshot directories are removed after a successful run and after a mid-run validation failure", async () => {
  const { CodexRunner } = await import("../server/codex-agent");
  const { ScreenshotRegistry } = await import("../server/screenshots");
  const { mkdtemp, rm, readdir } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "kite-prompt-tempcleanup-test-"));
  const makeRunner = () =>
    new CodexRunner({
      runs: new RunRegistry(),
      statePath: root,
      screenshots: new ScreenshotRegistry(),
      getConfig: () => ({
        apiKey: "fixture-key",
        model: "gpt-5.4",
        workspace: "/test/one",
        mcpUrl: "http://localhost/mcp",
      }),
      createClient: () => ({
        startThread: () => ({
          runStreamed: async () => ({
            events: (async function* () {
              yield {
                type: "thread.started" as const,
                thread_id: "native-1",
              };
            })(),
          }),
        }),
        resumeThread: () => {
          throw new Error("Unexpected resume");
        },
      }),
    });
  // Removing `if (temp) await rm(temp, ...)` in codex-agent.ts's `run()`
  // would still pass every other test, because they each delete their own
  // temp root wholesale in `finally`. This test keeps `root` alive across
  // both runs and inspects it directly, so a missing cleanup shows up here.
  const screenDirs = async () =>
    (await readdir(root)).filter((name) => name.startsWith("screen-"));
  const goodImage = Buffer.from(pngHeader(10, 10)).toString("base64");
  try {
    for await (const event of makeRunner().run(
      {
        threadId: "cleanup-success",
        runId: "r",
        messages: [
          {
            id: "m",
            role: "user",
            content: [
              { type: "binary", mimeType: "image/png", data: goodImage },
            ],
          },
        ],
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
      new AbortController().signal,
    ))
      assert.equal(event.type, "thread.started");
    assert.deepEqual(
      await screenDirs(),
      [],
      "expected no leftover screen-* directory after a successful run",
    );

    const badImage = Buffer.from("not actually a png").toString("base64");
    await assert.rejects(async () => {
      for await (const event of makeRunner().run(
        {
          threadId: "cleanup-failure",
          runId: "r",
          messages: [
            {
              id: "m",
              role: "user",
              content: [
                { type: "binary", mimeType: "image/png", data: goodImage },
                { type: "binary", mimeType: "image/png", data: badImage },
              ],
            },
          ],
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
        new AbortController().signal,
      ))
        assert.equal(event.type, "thread.started");
    }, /Image 2 is not a valid PNG image/);
    assert.deepEqual(
      await screenDirs(),
      [],
      "expected no leftover screen-* directory after image 2 fails validation",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a failed temp cleanup never replaces the run's real outcome", async () => {
  const { CodexRunner } = await import("../server/codex-agent");
  const { ScreenshotRegistry } = await import("../server/screenshots");
  const { mkdtemp, rm, chmod } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "kite-cleanup-fail-test-"));
  const image = Buffer.from(pngHeader(10, 10)).toString("base64");
  const contentWith = (data: string) => [
    {
      id: "m",
      role: "user" as const,
      content: [
        { type: "binary" as const, mimeType: "image/png" as const, data },
      ],
    },
  ];
  try {
    // The image is already written to its `screen-*` directory by the time
    // `runStreamed` is called, so removing write permission on its parent
    // (`root`, this runner's statePath) blocks the `finally` block's `rm`
    // cleanup below without disturbing anything this run already wrote.
    const successRunner = new CodexRunner({
      runs: new RunRegistry(),
      statePath: root,
      screenshots: new ScreenshotRegistry(),
      getConfig: () => ({
        apiKey: "fixture-key",
        model: "gpt-5.4",
        workspace: "/test/one",
        mcpUrl: "http://localhost/mcp",
      }),
      createClient: () => ({
        startThread: () => ({
          runStreamed: async () => {
            await chmod(root, 0o555);
            return {
              events: (async function* () {
                yield {
                  type: "thread.started" as const,
                  thread_id: "native-1",
                };
              })(),
            };
          },
        }),
        resumeThread: () => {
          throw new Error("Unexpected resume");
        },
      }),
    });
    for await (const event of successRunner.run(
      {
        threadId: "cleanup-fails-but-run-succeeds",
        runId: "r",
        messages: contentWith(image),
        tools: [],
        context: [],
        state: {},
        forwardedProps: {},
      },
      new AbortController().signal,
    ))
      assert.equal(event.type, "thread.started");
    // Writable again so the second runner below can create its own temp
    // directory under `root`.
    await chmod(root, 0o700);

    // The same failed cleanup must also leave a real, non-abort error
    // exactly as it was, not replace it with an EACCES from the `rm`.
    const failureRunner = new CodexRunner({
      runs: new RunRegistry(),
      statePath: root,
      screenshots: new ScreenshotRegistry(),
      getConfig: () => ({
        apiKey: "fixture-key",
        model: "gpt-5.4",
        workspace: "/test/one",
        mcpUrl: "http://localhost/mcp",
      }),
      createClient: () => ({
        startThread: () => ({
          runStreamed: async () => {
            await chmod(root, 0o555);
            return {
              events: (async function* () {
                yield {
                  type: "thread.started" as const,
                  thread_id: "native-2",
                };
                throw new Error("Simulated Codex stream failure");
              })(),
            };
          },
        }),
        resumeThread: () => {
          throw new Error("Unexpected resume");
        },
      }),
    });
    await assert.rejects(async () => {
      for await (const event of failureRunner.run(
        {
          threadId: "cleanup-fails-and-run-fails",
          runId: "r",
          messages: contentWith(image),
          tools: [],
          context: [],
          state: {},
          forwardedProps: {},
        },
        new AbortController().signal,
      ))
        assert.equal(event.type, "thread.started");
    }, /Simulated Codex stream failure/);
  } finally {
    // Restore before this test's own `rm(root, ...)` below, which needs
    // `root` writable to remove what is still inside it.
    await chmod(root, 0o700);
    await rm(root, { recursive: true, force: true });
  }
});

const mcpCall = (token: string) =>
  new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
  });

const runInput = (threadId: string) => ({
  threadId,
  runId: "r",
  messages: [{ id: "m", role: "user" as const, content: "hello" }],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
});

test("each run gets its own MCP token, which stops working when the run ends", async () => {
  const { CodexRunner } = await import("../server/codex-agent");
  const { ScreenshotRegistry } = await import("../server/screenshots");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "kite-run-token-test-"));
  const runs = new RunRegistry();
  const tokens: string[] = [];
  const during: { run?: AgentRun; aborted?: boolean }[] = [];
  const runner = new CodexRunner({
    runs,
    statePath: root,
    screenshots: new ScreenshotRegistry(),
    getConfig: () => ({
      apiKey: "fixture-key",
      model: "gpt-5.4",
      workspace: "/test/one",
      mcpUrl: "http://localhost/mcp",
    }),
    createClient: (options) => {
      const token = options.env?.KITE_MCP_TOKEN;
      assert.ok(token, "Codex must be given its run's MCP token");
      tokens.push(token);
      return {
        startThread: () => ({
          runStreamed: async () => ({
            events: (async function* () {
              const run = runs.authorize(mcpCall(token));
              during.push({ run, aborted: run?.signal.aborted });
              yield {
                type: "thread.started" as const,
                thread_id: "native-" + tokens.length,
              };
            })(),
          }),
        }),
        resumeThread: () => {
          throw new Error("Unexpected resume");
        },
      };
    },
  });
  try {
    for (const threadId of ["one", "two"])
      for await (const event of runner.run(
        runInput(threadId),
        new AbortController().signal,
      ))
        assert.equal(event.type, "thread.started");
    assert.equal(tokens.length, 2);
    assert.notEqual(tokens[0], tokens[1]);
    const [first, second] = during.map((entry) => entry.run);
    assert.ok(first && second, "each run's token must authorize while it runs");
    assert.notEqual(first.id, second.id);
    assert.deepEqual(
      during.map((entry) => entry.aborted),
      [false, false],
    );
    assert.equal(first.signal.aborted, true);
    for (const token of tokens)
      assert.equal(runs.authorize(mcpCall(token)), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Stop ends a run's MCP token at once, before Codex has exited", async () => {
  const { CodexRunner } = await import("../server/codex-agent");
  const { ScreenshotRegistry } = await import("../server/screenshots");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "kite-run-token-stop-test-"));
  const runs = new RunRegistry();
  let token: string | undefined;
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  const runner = new CodexRunner({
    runs,
    statePath: root,
    screenshots: new ScreenshotRegistry(),
    getConfig: () => ({
      apiKey: "fixture-key",
      model: "gpt-5.4",
      workspace: "/test/one",
      mcpUrl: "http://localhost/mcp",
    }),
    createClient: (options) => {
      token = options.env?.KITE_MCP_TOKEN;
      return {
        startThread: () => ({
          runStreamed: async () => ({
            events: (async function* () {
              yield { type: "thread.started" as const, thread_id: "native-1" };
              // Stands in for Codex still running after Stop: the runner
              // only notices the abort at its next event.
              await released;
              yield { type: "turn.started" as const };
            })(),
          }),
        }),
        resumeThread: () => {
          throw new Error("Unexpected resume");
        },
      };
    },
  });
  const controller = new AbortController();
  const iterator = runner.run(runInput("stop"), controller.signal);
  try {
    assert.equal((await iterator.next()).value?.type, "thread.started");
    assert.ok(token);
    const run = runs.authorize(mcpCall(token));
    assert.ok(run);
    controller.abort();
    assert.equal(run.signal.aborted, true);
    assert.equal(runs.authorize(mcpCall(token)), undefined);
    release();
    await assert.rejects(iterator.next(), /Run stopped/);
  } finally {
    release();
    await rm(root, { recursive: true, force: true });
  }
});

// A kite tool Codex doesn't pre-approve is refused under
// `approvalPolicy: "never"`, so a new tool that isn't on the list is dead.
test("Codex pre-approves exactly the tools the kite MCP server publishes", async () => {
  const { CodexRunner } = await import("../server/codex-agent");
  const { createToolHandler } = await import("../server/tools");
  const { ScreenshotRegistry } = await import("../server/screenshots");
  const { Store } = await import("../electron/store");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "kite-allowlist-test-"));
  try {
    const store = new Store(join(root, "store"));
    await store.load();
    const handler = createToolHandler({
      store,
      containerId: "desktop-workflows",
    });
    const listed = await handler(
      new Request("http://127.0.0.1/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      }),
      Object.freeze({ id: "run-list", signal: new AbortController().signal }),
    );
    const published = (
      (await listed.json()) as { result: { tools: { name: string }[] } }
    ).result.tools
      .map((tool) => tool.name)
      .sort();
    let approved: string[] = [];
    const runner = new CodexRunner({
      runs: new RunRegistry(),
      statePath: join(root, "agent"),
      screenshots: new ScreenshotRegistry(),
      getConfig: () => ({
        apiKey: "fixture-key",
        model: "gpt-5.4",
        workspace: "/test/one",
        mcpUrl: "http://localhost/mcp",
      }),
      createClient: (options) => {
        const servers = options.config?.mcp_servers as unknown as {
          kite: { tools: Record<string, { approval_mode: string }> };
        };
        approved = Object.entries(servers.kite.tools)
          .filter(([, tool]) => tool.approval_mode === "approve")
          .map(([name]) => name)
          .sort();
        return {
          startThread: () => ({
            runStreamed: async () => ({
              events: (async function* () {
                yield {
                  type: "thread.started" as const,
                  thread_id: "native-1",
                };
              })(),
            }),
          }),
          resumeThread: () => {
            throw new Error("Unexpected resume");
          },
        };
      },
    });
    for await (const event of runner.run(
      runInput("allowlist"),
      new AbortController().signal,
    ))
      assert.equal(event.type, "thread.started");
    assert.deepEqual(approved, published);
    assert.ok(published.includes("click_on_screen"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the instructions describe computer use, and no longer say the agent can't click", async () => {
  const { instructions } = await import("../server/codex-agent");
  assert.match(instructions, /take_screenshot/);
  assert.match(instructions, /control the Mac until the task ends/);
  assert.match(instructions, /before the next click or scroll/);
  assert.match(instructions, /web pages/);
  assert.doesNotMatch(instructions, /cannot click or type/i);
  assert.doesNotMatch(
    instructions,
    /Screenshots come only from user attachments/,
  );
});

test("the instructions never let the agent enter passwords, even where typing is refused", async () => {
  const { instructions } = await import("../server/codex-agent");
  assert.match(instructions, /never type, paste or otherwise enter passwords/);
  assert.match(instructions, /Never type commands into a terminal/);
});

test("codexEvents turns an OpenMuse notice into one AG-UI custom event", () => {
  assert.deepEqual(
    codexEvents({
      type: "kite.notice",
      name: "kite.memory-recalled",
      value: { count: 1, previews: ["How to label spam"] },
    }),
    [
      {
        type: "CUSTOM",
        name: "kite.memory-recalled",
        value: { count: 1, previews: ["How to label spam"] },
      },
    ],
  );
});
