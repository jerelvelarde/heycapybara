import { test } from "node:test";
import assert from "node:assert/strict";
import { codexEvents } from "../server/codex-events";

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

test("conversations resume their own native thread and reject workspace changes", async () => {
  const { CodexRunner } = await import("../server/codex-agent");
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
    statePath: root,
    getConfig: () => ({
      apiKey: "fixture-key",
      model: "gpt-5.4",
      workspace,
      mcpUrl: "http://localhost/mcp",
      mcpToken: "fixture-token",
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
