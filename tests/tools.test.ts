import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../electron/store";
import { createToolHandler } from "../server/tools";
import type { DesktopAction } from "../src/types";

type Handler = (request: Request) => Promise<Response>;

// Builds a fresh store, temp dir and MCP handler for one test, and cleans up
// the temp dir afterward regardless of how the test finishes. Each test gets
// its own handler and its own `actions` array, so an early failure in one
// test never hides or pollutes another.
async function withHandler(
  options: { action?: (action: DesktopAction) => Promise<void> },
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

// Sends one MCP JSON-RPC call through a handler from withHandler().
async function requestTo(handler: Handler, method: string, params: unknown) {
  const response = await handler(
    new Request("http://127.0.0.1/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
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
  // Built from code points rather than typed as \u escapes, so this file
  // never has to hold a raw control, bidi or line/paragraph-separator
  // character - see server/point-schema.ts for what each one denies.
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
  // The joiner between the two emoji is built from its code point rather
  // than typed as a \u escape, so this file never has to hold a raw ZWJ.
  const zwj = String.fromCodePoint(0x200d);
  const emojiLabel = "Save 👩" + zwj + "💻 button";
  await withHandler(
    { action: async (action) => void actions.push(action) },
    async (handler) => {
      const unicodeLabel = await requestTo(handler, "tools/call", {
        name: "point_on_screen",
        arguments: { ...validPoint, label: "Exportér ✓ button" },
      });
      assert.ok(!unicodeLabel.result.isError);
      assert.deepEqual(actions.at(-1), {
        type: "point",
        ...validPoint,
        label: "Exportér ✓ button",
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
      const stringCoordinate = await requestTo(handler, "tools/call", {
        name: "point_on_screen",
        arguments: { ...validPoint, x: "10", label: "Save button" },
      });
      assert.equal(stringCoordinate.result.isError, true);
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
