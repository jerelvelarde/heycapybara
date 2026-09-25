import { test } from "node:test";
import assert from "node:assert/strict";
import { codexEvents } from "../server/codex-events";
import { pngHeader } from "./png-fixture";

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
    screenshots: undefined,
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
    statePath: root,
    screenshots,
    getConfig: () => ({
      apiKey: "fixture-key",
      model: "gpt-5.4",
      workspace: "/test/one",
      mcpUrl: "http://localhost/mcp",
      mcpToken: "fixture-token",
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
    statePath: root,
    screenshots,
    getConfig: () => ({
      apiKey: "fixture-key",
      model: "gpt-5.4",
      workspace: "/test/one",
      mcpUrl: "http://localhost/mcp",
      mcpToken: "fixture-token",
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
    statePath: root,
    screenshots,
    getConfig: () => ({
      apiKey: "fixture-key",
      model: "gpt-5.4",
      workspace: "/test/one",
      mcpUrl: "http://localhost/mcp",
      mcpToken: "fixture-token",
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
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "kite-prompt-badpng-test-"));
  const runner = new CodexRunner({
    statePath: root,
    screenshots: undefined,
    getConfig: () => ({
      apiKey: "fixture-key",
      model: "gpt-5.4",
      workspace: "/test/one",
      mcpUrl: "http://localhost/mcp",
      mcpToken: "fixture-token",
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

test("a recovered conversation keeps the text a user typed alongside an earlier image", async () => {
  const { CodexRunner } = await import("../server/codex-agent");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "kite-history-test-"));
  let prompt: unknown;
  const runner = new CodexRunner({
    statePath: root,
    screenshots: undefined,
    getConfig: () => ({
      apiKey: "fixture-key",
      model: "gpt-5.4",
      workspace: "/test/one",
      mcpUrl: "http://localhost/mcp",
      mcpToken: "fixture-token",
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
    statePath: root,
    screenshots,
    getConfig: () => ({
      apiKey: "fixture-key",
      model: "gpt-5.4",
      workspace: "/test/one",
      mcpUrl: "http://localhost/mcp",
      mcpToken: "fixture-token",
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
      id: "shot_test",
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
  assert.equal(binaryPart?.id, "shot_test");
});

type NoteRow = {
  name: string;
  hasRegistry: boolean;
  registryNow?: () => number;
  imageSize: { width: number; height: number };
  referenceId: "valid" | "unknown" | "none";
  opening: string;
};

// Shared setup for the note-state matrix below: registers one fresh capture
// (unless the row omits the registry entirely), attaches a single image
// referencing it (or not), and returns the first prompt part's text -- the
// note codex-agent.ts chose for that state.
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
    statePath: root,
    screenshots: row.hasRegistry ? registry : undefined,
    getConfig: () => ({
      apiKey: "fixture-key",
      model: "gpt-5.4",
      workspace: "/test/one",
      mcpUrl: "http://localhost/mcp",
      mcpToken: "fixture-token",
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
        ? "shot_ffffffff"
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
      hasRegistry: true,
      imageSize: { width: 1386, height: 900 },
      referenceId: "valid",
      opening: "Image 1 in this message is screenshot",
    },
    {
      name: "stale",
      hasRegistry: true,
      registryNow: () => Date.now() - 11 * 60 * 1000,
      imageSize: { width: 1386, height: 900 },
      referenceId: "valid",
      opening:
        "Image 1 in this message is a screenshot that is too old to point at, or whose capture time is unknown.",
    },
    {
      name: "wrong size",
      hasRegistry: true,
      imageSize: { width: 100, height: 100 },
      referenceId: "valid",
      opening: "Image 1 in this message doesn't match the screenshot it names",
    },
    {
      name: "stale and wrong size (must be mismatched)",
      hasRegistry: true,
      registryNow: () => Date.now() - 11 * 60 * 1000,
      imageSize: { width: 100, height: 100 },
      referenceId: "valid",
      opening: "Image 1 in this message doesn't match the screenshot it names",
    },
    {
      name: "unknown id",
      hasRegistry: true,
      imageSize: { width: 1386, height: 900 },
      referenceId: "unknown",
      opening:
        "Image 1 in this message names a screenshot OpenMuse no longer has",
    },
    {
      name: "no id",
      hasRegistry: true,
      imageSize: { width: 1386, height: 900 },
      referenceId: "none",
      opening: "Image 1 in this message has no screen reference",
    },
    {
      name: "runner with screenshots: undefined and an id (must be unknown)",
      hasRegistry: false,
      imageSize: { width: 1386, height: 900 },
      referenceId: "valid",
      opening:
        "Image 1 in this message names a screenshot OpenMuse no longer has",
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
