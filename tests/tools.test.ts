import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../electron/store";
import { createToolHandler, type DesktopActionHandler } from "../server/tools";
import type { AgentRun } from "../server/run-registry";
import type { DesktopAction } from "../src/types";
import {
  BLOCKED_CHORD_MESSAGE,
  KEY_NAMES,
  MODIFIERS,
} from "../server/computer-schema";

type Handler = (request: Request, run: AgentRun) => Promise<Response>;

// A run that never ends, for calls whose run doesn't matter to the test.
const liveRun = (id = "run-test"): AgentRun =>
  Object.freeze({ id, signal: new AbortController().signal });

// A promise this test controls the settling of, so an action fake can pause
// mid-call until the test says to continue - used to keep a tool call
// genuinely in flight while the test inspects it, instead of timing that
// inspection against garbage collection (see the signal-forwarding test
// below).
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

// Builds a fresh store, temp dir and MCP handler for one test, and removes
// the temp dir afterward however the test finishes. Each test also creates
// its own `actions` array, so an early failure in one test never hides or
// pollutes another.
async function withHandler(
  options: {
    action?: DesktopActionHandler;
  },
  run: (handler: Handler) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "kite-mcp-test-"));
  try {
    const store = new Store(root);
    await store.load();
    const handler = createToolHandler({
      store,
      containerId: "desktop-workflows",
      action: options.action,
    });
    await run(handler);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// Sends one MCP JSON-RPC call through a handler from withHandler(). `init`
// carries extra Request options a test needs to control, such as its own
// AbortSignal.
async function requestTo(
  handler: Handler,
  method: string,
  params: unknown,
  init: { signal?: AbortSignal; run?: AgentRun } = {},
) {
  const { run = liveRun(), ...requestInit } = init;
  const response = await handler(
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      ...requestInit,
    }),
    run,
  );
  assert.equal(response.status, 200);
  return response.json();
}

const validPoint = {
  screenshotId: "shot_1a2b3c4d",
  x: 10,
  y: 20,
};

test("lists learned-skill tools and calls a real no-op tool", async () => {
  await withHandler({}, async (handler) => {
    const list = await requestTo(handler, "tools/list", {});
    assert.ok(
      list.result.tools.some(
        (tool: { name: string }) => tool.name === "list_learned_skills",
      ),
    );
    const result = await requestTo(handler, "tools/call", {
      name: "list_local_skills",
      arguments: {},
    });
    assert.equal(result.result.content[0].text, "[]");
  });
});

test("open_application rejects a malformed bundle id without invoking the action", async () => {
  const actions: DesktopAction[] = [];
  await withHandler(
    { action: async (action) => void actions.push(action) },
    async (handler) => {
      const invalid = await requestTo(handler, "tools/call", {
        name: "open_application",
        arguments: { bundleId: "bad shell string" },
      });
      assert.equal(invalid.result.isError, true);
      assert.equal(actions.length, 0);
    },
  );
});

test("open_application invokes the action for a valid bundle id", async () => {
  const actions: DesktopAction[] = [];
  await withHandler(
    { action: async (action) => void actions.push(action) },
    async (handler) => {
      const valid = await requestTo(handler, "tools/call", {
        name: "open_application",
        arguments: { bundleId: "com.apple.TextEdit" },
      });
      assert.ok(!valid.result.isError);
      assert.equal(actions.length, 1);
      assert.deepEqual(actions.at(-1), {
        type: "open-app",
        bundleId: "com.apple.TextEdit",
      });
    },
  );
});

// bundleIdSchema is tighter than the pattern this replaced: a hyphen may no
// longer start the segment right after a dot (it may still end one, as in
// "com.a-"), and a trailing dot with nothing after it is still refused.
// Without this, the user could approve an app launch that
// native/Recorder.swift's own, always-stricter check then rejects anyway.
test("open_application rejects a hyphen-adjacent-to-dot or trailing-dot bundle id, but still accepts a real one", async () => {
  const actions: DesktopAction[] = [];
  await withHandler(
    { action: async (action) => void actions.push(action) },
    async (handler) => {
      for (const bundleId of ["com.-x", "-a.b", "com."]) {
        const rejected = await requestTo(handler, "tools/call", {
          name: "open_application",
          arguments: { bundleId },
        });
        assert.equal(
          rejected.result.isError,
          true,
          `"${bundleId}" must be rejected`,
        );
      }
      assert.equal(actions.length, 0);

      for (const bundleId of ["com.apple.TextEdit", "com.a-"]) {
        const accepted = await requestTo(handler, "tools/call", {
          name: "open_application",
          arguments: { bundleId },
        });
        assert.ok(!accepted.result.isError, `"${bundleId}" must be accepted`);
      }
      assert.equal(actions.length, 2);
    },
  );
});

// Guards against the schema and the helper drifting apart again: the user
// could otherwise approve an app launch that native/Recorder.swift's
// --open-app check then refuses anyway (or the reverse, silently loosening
// what the user is asked to approve).
test("open_application's published bundle-id pattern matches native/Recorder.swift's --open-app check", async () => {
  await withHandler({}, async (handler) => {
    const list = await requestTo(handler, "tools/list", {});
    const openApplicationTool = list.result.tools.find(
      (tool: { name: string }) => tool.name === "open_application",
    );
    assert.ok(openApplicationTool, "open_application must be published");
    const pattern: string | undefined =
      openApplicationTool.inputSchema.properties.bundleId.pattern;
    assert.ok(pattern, "open_application's bundleId must publish a pattern");

    // Swift needs `\\.` where the JS regex source only needs `\.` (Swift
    // string literals double a backslash to escape it), and this file's
    // style prefers a non-capturing group where native/Recorder.swift's
    // pattern, written before this schema existed, uses a plain one -
    // neither difference changes what either pattern matches, so both are
    // normalized away before comparing.
    const swiftStyle = pattern.replaceAll("(?:", "(").replace(/\\/g, "\\\\");
    const swiftSource = await readFile(
      new URL("../native/Recorder.swift", import.meta.url),
      "utf8",
    );
    assert.ok(
      swiftSource.includes(swiftStyle),
      `native/Recorder.swift's --open-app pattern no longer matches bundleIdSchema.\nExpected native/Recorder.swift to contain:\n${swiftStyle}`,
    );
  });
});

test("point_on_screen requires a screenshot id", async () => {
  const actions: DesktopAction[] = [];
  await withHandler(
    { action: async (action) => void actions.push(action) },
    async (handler) => {
      const unanchored = await requestTo(handler, "tools/call", {
        name: "point_on_screen",
        arguments: { x: 10, y: 20, label: "Save button" },
      });
      assert.equal(unanchored.result.isError, true);
      assert.equal(actions.length, 0);
    },
  );
});

test("point_on_screen rejects a label that trims to nothing", async () => {
  const actions: DesktopAction[] = [];
  await withHandler(
    { action: async (action) => void actions.push(action) },
    async (handler) => {
      const unlabeled = await requestTo(handler, "tools/call", {
        name: "point_on_screen",
        arguments: { ...validPoint, label: " " },
      });
      assert.equal(unlabeled.result.isError, true);
      assert.equal(actions.length, 0);
    },
  );
});

test("point_on_screen succeeds and forwards the exact point to the action", async () => {
  const actions: DesktopAction[] = [];
  await withHandler(
    { action: async (action) => void actions.push(action) },
    async (handler) => {
      const pointed = await requestTo(handler, "tools/call", {
        name: "point_on_screen",
        arguments: { ...validPoint, label: "Save button" },
      });
      assert.ok(!pointed.result.isError);
      assert.deepEqual(actions.at(-1), {
        type: "point",
        ...validPoint,
        label: "Save button",
      });
    },
  );
});

test("point_on_screen rejects labels with newlines, bidi overrides, or line or paragraph separators", async () => {
  const actions: DesktopAction[] = [];
  // Spelled as code points so no raw control, bidi or separator character
  // appears in this file - see server/point-schema.ts for what each rule
  // denies.
  const bidiOverride = String.fromCodePoint(0x202e);
  const lineSeparator = String.fromCodePoint(0x2028);
  const paragraphSeparator = String.fromCodePoint(0x2029);
  await withHandler(
    { action: async (action) => void actions.push(action) },
    async (handler) => {
      const newlineLabel = await requestTo(handler, "tools/call", {
        name: "point_on_screen",
        arguments: { ...validPoint, label: "Save\nApproved by OpenMuse" },
      });
      assert.equal(newlineLabel.result.isError, true);

      const bidiOverrideLabel = await requestTo(handler, "tools/call", {
        name: "point_on_screen",
        arguments: { ...validPoint, label: "Save" + bidiOverride + "button" },
      });
      assert.equal(bidiOverrideLabel.result.isError, true);

      const lineSeparatorLabel = await requestTo(handler, "tools/call", {
        name: "point_on_screen",
        arguments: {
          ...validPoint,
          label: "Save" + lineSeparator + "Approved by OpenMuse",
        },
      });
      assert.equal(lineSeparatorLabel.result.isError, true);

      const paragraphSeparatorLabel = await requestTo(handler, "tools/call", {
        name: "point_on_screen",
        arguments: {
          ...validPoint,
          label: "Save" + paragraphSeparator + "Approved",
        },
      });
      assert.equal(paragraphSeparatorLabel.result.isError, true);

      assert.equal(actions.length, 0);
    },
  );
});

test("point_on_screen accepts unicode text and emoji joined by a ZWJ", async () => {
  const actions: DesktopAction[] = [];
  // Spelled as code points so no raw joiner, emoji or other non-ASCII
  // character appears in this file.
  const accentedLabel =
    "Export" +
    String.fromCodePoint(0xe9) +
    "r " +
    String.fromCodePoint(0x2713) +
    " button";
  const emojiLabel =
    "Save " + String.fromCodePoint(0x1f469, 0x200d, 0x1f4bb) + " button";
  await withHandler(
    { action: async (action) => void actions.push(action) },
    async (handler) => {
      const unicodeLabel = await requestTo(handler, "tools/call", {
        name: "point_on_screen",
        arguments: { ...validPoint, label: accentedLabel },
      });
      assert.ok(!unicodeLabel.result.isError);
      assert.deepEqual(actions.at(-1), {
        type: "point",
        ...validPoint,
        label: accentedLabel,
      });

      const zwjLabel = await requestTo(handler, "tools/call", {
        name: "point_on_screen",
        arguments: { ...validPoint, label: emojiLabel },
      });
      assert.ok(!zwjLabel.result.isError);
      assert.deepEqual(actions.at(-1), {
        type: "point",
        ...validPoint,
        label: emojiLabel,
      });

      assert.equal(actions.length, 2);
    },
  );
});

test("point_on_screen rejects a label over the length limit", async () => {
  const actions: DesktopAction[] = [];
  await withHandler(
    { action: async (action) => void actions.push(action) },
    async (handler) => {
      const overLongLabel = await requestTo(handler, "tools/call", {
        name: "point_on_screen",
        arguments: { ...validPoint, label: "a".repeat(61) },
      });
      assert.equal(overLongLabel.result.isError, true);
      assert.equal(actions.length, 0);
    },
  );
});

test("point_on_screen validates that x and y are numbers", async () => {
  const actions: DesktopAction[] = [];
  await withHandler(
    { action: async (action) => void actions.push(action) },
    async (handler) => {
      const stringX = await requestTo(handler, "tools/call", {
        name: "point_on_screen",
        arguments: { ...validPoint, x: "10", label: "Save button" },
      });
      assert.equal(stringX.result.isError, true);

      const stringY = await requestTo(handler, "tools/call", {
        name: "point_on_screen",
        arguments: { ...validPoint, y: "20", label: "Save button" },
      });
      assert.equal(stringY.result.isError, true);

      assert.equal(actions.length, 0);
    },
  );
});

test("point_on_screen validates the screenshot id format", async () => {
  const actions: DesktopAction[] = [];
  await withHandler(
    { action: async (action) => void actions.push(action) },
    async (handler) => {
      const malformedScreenshotId = await requestTo(handler, "tools/call", {
        name: "point_on_screen",
        arguments: {
          ...validPoint,
          screenshotId: "shot_XYZ12345",
          label: "Save button",
        },
      });
      assert.equal(malformedScreenshotId.result.isError, true);
      assert.equal(actions.length, 0);
    },
  );
});

test("point_on_screen's published schema has no pattern for the label but keeps one for the screenshot id", async () => {
  await withHandler({}, async (handler) => {
    const list = await requestTo(handler, "tools/list", {});
    const pointOnScreenTool = list.result.tools.find(
      (tool: { name: string }) => tool.name === "point_on_screen",
    );
    assert.ok(pointOnScreenTool);
    assert.equal(
      pointOnScreenTool.inputSchema.properties.label.pattern,
      undefined,
    );
    assert.equal(
      pointOnScreenTool.inputSchema.properties.screenshotId.pattern,
      "^shot_[0-9a-f]{8}$",
    );
  });
});

test("an action that throws reaches the model as an error result with its message", async () => {
  const refusal =
    "That screenshot is more than 10 minutes old. Ask the user to attach a new one.";
  await withHandler(
    {
      action: async () => {
        throw new Error(refusal);
      },
    },
    async (handler) => {
      const result = await requestTo(handler, "tools/call", {
        name: "point_on_screen",
        arguments: { ...validPoint, label: "Save button" },
      });
      assert.equal(result.result.isError, true);
      assert.ok(result.result.content[0].text.includes(refusal));
    },
  );
});

// The other point_on_screen refusal tests above only check isError, not
// that the model actually receives the schema's own wording (a caller that
// only sees "isError: true" can't tell the model what to fix). This checks
// one schema-level refusal end to end: a real double space, run through
// pointLabelSchema's own refine, not a fake.
test("point_on_screen's single-spaces refusal reaches the model with its exact message", async () => {
  const actions: DesktopAction[] = [];
  await withHandler(
    { action: async (action) => void actions.push(action) },
    async (handler) => {
      const result = await requestTo(handler, "tools/call", {
        name: "point_on_screen",
        arguments: { ...validPoint, label: "Save  button" },
      });
      assert.equal(result.result.isError, true);
      assert.ok(
        result.result.content[0].text.includes(
          "Use single spaces between words",
        ),
      );
      assert.equal(actions.length, 0);
    },
  );
});

// resolvePoint's own "outside the screenshot" refusal is exercised in
// tests/screenshots.test.ts; this only checks that server/tools.ts passes a
// refusal like it - not a generic one - through to the model with its exact
// text intact, the same way the action's own decline and cancellation
// errors must.
test("an outside-image refusal thrown by the action reaches the model with its exact message", async () => {
  const times = String.fromCodePoint(0xd7); // U+00D7, spelled out per this
  // file's convention of keeping non-ASCII characters out of its source.
  const refusal = `(2222, 3333) is outside the 1386${times}900 screenshot.`;
  await withHandler(
    {
      action: async () => {
        throw new Error(refusal);
      },
    },
    async (handler) => {
      const result = await requestTo(handler, "tools/call", {
        name: "point_on_screen",
        arguments: { ...validPoint, label: "Save button" },
      });
      assert.equal(result.result.isError, true);
      assert.ok(result.result.content[0].text.includes(refusal));
    },
  );
});

test("the label reaches the action trimmed of surrounding whitespace", async () => {
  const actions: DesktopAction[] = [];
  await withHandler(
    { action: async (action) => void actions.push(action) },
    async (handler) => {
      const result = await requestTo(handler, "tools/call", {
        name: "point_on_screen",
        arguments: { ...validPoint, label: "  Save  " },
      });
      assert.ok(!result.result.isError);
      assert.deepEqual(actions.at(-1), {
        type: "point",
        ...validPoint,
        label: "Save",
      });
    },
  );
});

test('returns "Desktop actions unavailable" when no action is configured', async () => {
  await withHandler({}, async (handler) => {
    const opened = await requestTo(handler, "tools/call", {
      name: "open_application",
      arguments: { bundleId: "com.apple.TextEdit" },
    });
    assert.equal(opened.result.isError, true);
    assert.equal(opened.result.content[0].text, "Desktop actions unavailable");

    const pointed = await requestTo(handler, "tools/call", {
      name: "point_on_screen",
      arguments: { ...validPoint, label: "Save button" },
    });
    assert.equal(pointed.result.isError, true);
    assert.equal(pointed.result.content[0].text, "Desktop actions unavailable");
  });
});

// Each call gets its own AbortController, aborted while that call is still
// in flight - not after both calls have already finished. By then the
// Request driving a finished call is unreferenced, and Node only keeps
// request.signal following the caller's AbortSignal through a weak
// reference, so a GC between the calls finishing and the later abort() can
// silently sever it (reproduced: a forced full GC right before that abort()
// made the old version of this test fail). Checking signal.aborted inside
// the action itself, while it is paused on `gate` and the call has
// therefore not resolved yet, means the Request and whatever keeps its
// signal linked to the controller are still reachable through this same
// call stack - so the assertion can't depend on when, or whether, garbage
// collection runs.
async function checkLiveSignalForwarding(
  handler: Handler,
  seen: { signal?: AbortSignal },
  gate: ReturnType<typeof deferred>,
  name: "open_application" | "point_on_screen",
  args: Record<string, unknown>,
) {
  const controller = new AbortController();
  const inFlight = requestTo(
    handler,
    "tools/call",
    { name, arguments: args },
    { signal: controller.signal },
  );
  controller.abort();
  gate.resolve();
  const result = await inFlight;
  assert.ok(!result.result.isError, `${name} must still succeed`);
  assert.equal(
    seen.signal?.aborted,
    true,
    `${name}'s action must see its request's own signal already aborted`,
  );
}

test("open_application and point_on_screen each forward the request's own, still-live AbortSignal to the action", async () => {
  const seen: { signal?: AbortSignal } = {};
  let gate = deferred();
  await withHandler(
    {
      action: async (_action, signal) => {
        // Reached while its request is still in flight (nothing here has
        // been awaited to completion yet) - see the comment above.
        await gate.promise;
        seen.signal = signal;
      },
    },
    async (handler) => {
      await checkLiveSignalForwarding(handler, seen, gate, "open_application", {
        bundleId: "com.apple.TextEdit",
      });

      gate = deferred();
      await checkLiveSignalForwarding(handler, seen, gate, "point_on_screen", {
        ...validPoint,
        label: "Save button",
      });
    },
  );
});

test("open_application's bundle-id length boundary: 255 characters passes, 256 is rejected", async () => {
  const actions: DesktopAction[] = [];
  await withHandler(
    { action: async (action) => void actions.push(action) },
    async (handler) => {
      const atLimit = "a".repeat(127) + "." + "a".repeat(127);
      assert.equal(atLimit.length, 255);
      const ok = await requestTo(handler, "tools/call", {
        name: "open_application",
        arguments: { bundleId: atLimit },
      });
      assert.ok(!ok.result.isError);
      assert.equal(actions.length, 1);

      const overLimit = "a".repeat(127) + "." + "a".repeat(128);
      assert.equal(overLimit.length, 256);
      const rejected = await requestTo(handler, "tools/call", {
        name: "open_application",
        arguments: { bundleId: overLimit },
      });
      assert.equal(rejected.result.isError, true);
      assert.equal(actions.length, 1);
    },
  );
});

test("open_application and point_on_screen hand the action the run the call came from", async () => {
  const seen: AgentRun[] = [];
  await withHandler(
    {
      action: async (_action, _signal, run) => {
        seen.push(run);
      },
    },
    async (handler) => {
      const run = liveRun("run-a");
      await requestTo(
        handler,
        "tools/call",
        {
          name: "open_application",
          arguments: { bundleId: "com.apple.TextEdit" },
        },
        { run },
      );
      await requestTo(
        handler,
        "tools/call",
        {
          name: "point_on_screen",
          arguments: { ...validPoint, label: "Save button" },
        },
        { run },
      );
      assert.equal(seen.length, 2);
      assert.equal(seen[0], run);
      assert.equal(seen[1], run);
    },
  );
});

const shotResult = {
  id: "shot_5e6f7a8b",
  label: "Test display",
  width: 1512,
  height: 982,
  png: "iVBORw0KGgo=",
};

test("take_screenshot returns the action's note, then its screenshot as a PNG image", async () => {
  const actions: DesktopAction[] = [];
  await withHandler(
    {
      action: async (action) => {
        actions.push(action);
        return { text: "note", screenshot: shotResult };
      },
    },
    async (handler) => {
      const result = await requestTo(handler, "tools/call", {
        name: "take_screenshot",
        arguments: {},
      });
      assert.ok(!result.result.isError);
      assert.deepEqual(result.result.content, [
        { type: "text", text: "note" },
        { type: "image", data: shotResult.png, mimeType: "image/png" },
      ]);
      assert.deepEqual(actions, [{ type: "screenshot" }]);
    },
  );
});

test("a computer-use action that returns nothing is an error, not a silent success", async () => {
  await withHandler({ action: async () => {} }, async (handler) => {
    const result = await requestTo(handler, "tools/call", {
      name: "take_screenshot",
      arguments: {},
    });
    assert.equal(result.result.isError, true);
    assert.equal(
      result.result.content[0].text,
      "The desktop action returned no result",
    );
  });
});

test("click_on_screen fills in one left click and forwards the target; without a screenshot the result is text alone", async () => {
  const actions: DesktopAction[] = [];
  await withHandler(
    {
      action: async (action) => {
        actions.push(action);
        return { text: "sent" };
      },
    },
    async (handler) => {
      const result = await requestTo(handler, "tools/call", {
        name: "click_on_screen",
        arguments: { ...validPoint, label: "Report spam" },
      });
      assert.deepEqual(result.result.content, [{ type: "text", text: "sent" }]);
      assert.deepEqual(actions, [
        {
          type: "click",
          ...validPoint,
          label: "Report spam",
          button: "left",
          clicks: 1,
        },
      ]);
    },
  );
});

test("click_on_screen refuses a fourth click, a middle button, a missing label and a malformed screenshot id", async () => {
  const actions: DesktopAction[] = [];
  await withHandler(
    { action: async (action) => void actions.push(action) },
    async (handler) => {
      for (const args of [
        { ...validPoint, label: "Inbox", clicks: 4 },
        { ...validPoint, label: "Inbox", button: "middle" },
        { ...validPoint },
        { ...validPoint, label: "Inbox", screenshotId: "shot_XYZ12345" },
      ]) {
        const result = await requestTo(handler, "tools/call", {
          name: "click_on_screen",
          arguments: args,
        });
        assert.equal(result.result.isError, true, JSON.stringify(args));
      }
      assert.equal(actions.length, 0);
    },
  );
});

test("scroll_on_screen takes 1 to 10 whole notches in one of four directions", async () => {
  const actions: DesktopAction[] = [];
  await withHandler(
    {
      action: async (action) => {
        actions.push(action);
        return { text: "scrolled" };
      },
    },
    async (handler) => {
      const call = (direction: unknown, amount: unknown) =>
        requestTo(handler, "tools/call", {
          name: "scroll_on_screen",
          arguments: { ...validPoint, label: "Inbox", direction, amount },
        });
      assert.ok(!(await call("down", 10)).result.isError);
      for (const [direction, amount] of [
        ["down", 0],
        ["down", 11],
        ["down", 1.5],
        ["sideways", 3],
      ])
        assert.equal((await call(direction, amount)).result.isError, true);
      assert.deepEqual(actions, [
        {
          type: "scroll",
          ...validPoint,
          label: "Inbox",
          direction: "down",
          amount: 10,
        },
      ]);
    },
  );
});

test("type_text refuses line breaks and text over the limit with the schema's message", async () => {
  const actions: DesktopAction[] = [];
  await withHandler(
    {
      action: async (action) => {
        actions.push(action);
        return { text: "typed" };
      },
    },
    async (handler) => {
      const typeText = (text: string) =>
        requestTo(handler, "tools/call", {
          name: "type_text",
          arguments: { text },
        });
      const broken = await typeText("a\nb");
      assert.equal(broken.result.isError, true);
      assert.ok(
        broken.result.content[0].text.includes("Use press_keys for Return"),
      );
      assert.equal((await typeText("a".repeat(1001))).result.isError, true);
      assert.ok(!(await typeText("a".repeat(1000))).result.isError);
      assert.deepEqual(actions, [{ type: "type", text: "a".repeat(1000) }]);
    },
  );
});

test("press_keys forwards a key with its modifiers, which default to none", async () => {
  const actions: DesktopAction[] = [];
  await withHandler(
    {
      action: async (action) => {
        actions.push(action);
        return { text: "pressed" };
      },
    },
    async (handler) => {
      await requestTo(handler, "tools/call", {
        name: "press_keys",
        arguments: { key: "l", modifiers: ["command"] },
      });
      await requestTo(handler, "tools/call", {
        name: "press_keys",
        arguments: { key: "return" },
      });
      assert.deepEqual(actions, [
        { type: "keys", key: "l", modifiers: ["command"] },
        { type: "keys", key: "return", modifiers: [] },
      ]);
    },
  );
});

test("press_keys refuses unknown keys, repeated modifiers and blocked shortcuts without calling the action", async () => {
  const actions: DesktopAction[] = [];
  await withHandler(
    { action: async (action) => void actions.push(action) },
    async (handler) => {
      for (const args of [
        { key: "enter" },
        { key: "l", modifiers: ["command", "command"] },
        { key: "l", modifiers: ["fn"] },
      ]) {
        const result = await requestTo(handler, "tools/call", {
          name: "press_keys",
          arguments: args,
        });
        assert.equal(result.result.isError, true, JSON.stringify(args));
      }
      const blocked = await requestTo(handler, "tools/call", {
        name: "press_keys",
        arguments: { key: "q", modifiers: ["command", "shift"] },
      });
      assert.equal(blocked.result.isError, true);
      assert.equal(blocked.result.content[0].text, BLOCKED_CHORD_MESSAGE);
      assert.equal(actions.length, 0);
    },
  );
});

test("press_keys publishes its key names and modifiers as enums the model can read", async () => {
  await withHandler({}, async (handler) => {
    const list = await requestTo(handler, "tools/list", {});
    const pressKeys = list.result.tools.find(
      (tool: { name: string }) => tool.name === "press_keys",
    );
    assert.deepEqual(pressKeys.inputSchema.properties.key.enum, [...KEY_NAMES]);
    assert.deepEqual(pressKeys.inputSchema.properties.modifiers.items.enum, [
      ...MODIFIERS,
    ]);
  });
});

test("open_url takes only an https address, and forwards it with the app", async () => {
  const actions: DesktopAction[] = [];
  await withHandler(
    {
      action: async (action) => {
        actions.push(action);
        return { text: "opened" };
      },
    },
    async (handler) => {
      const open = (url: string) =>
        requestTo(handler, "tools/call", {
          name: "open_url",
          arguments: { url, bundleId: "com.google.Chrome" },
        });
      for (const url of [
        "http://mail.google.com",
        "javascript:alert(1)",
        "https://exa mple.com",
        "https://user:pw@mail.google.com",
      ])
        assert.equal((await open(url)).result.isError, true, url);
      assert.ok(!(await open("https://mail.google.com")).result.isError);
      assert.deepEqual(actions, [
        {
          type: "open-url",
          url: "https://mail.google.com",
          bundleId: "com.google.Chrome",
        },
      ]);
    },
  );
});
