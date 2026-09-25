import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../electron/store";
import { createToolHandler } from "../server/tools";
import type { DesktopAction } from "../src/types";

test("MCP exposes real skill tools and validates native action arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "kite-mcp-test-"));
  const store = new Store(root);
  await store.load();
  const actions: DesktopAction[] = [];
  const handler = createToolHandler({
    store,
    containerId: "desktop-workflows",
    action: async (action) => {
      actions.push(action);
    },
  });
  const request = async (method: string, params: unknown) => {
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
  };
  try {
    const list = await request("tools/list", {});
    assert.ok(
      list.result.tools.some(
        (tool: { name: string }) => tool.name === "list_learned_skills",
      ),
    );
    const result = await request("tools/call", {
      name: "list_local_skills",
      arguments: {},
    });
    assert.equal(result.result.content[0].text, "[]");
    const invalid = await request("tools/call", {
      name: "open_application",
      arguments: { bundleId: "bad shell string" },
    });
    assert.equal(invalid.result.isError, true);
    assert.equal(actions.length, 0);
    const valid = await request("tools/call", {
      name: "open_application",
      arguments: { bundleId: "com.apple.TextEdit" },
    });
    assert.ok(!valid.result.isError);
    assert.equal(actions.length, 1);
    const unanchored = await request("tools/call", {
      name: "point_on_screen",
      arguments: { x: 10, y: 20, label: "Save button" },
    });
    assert.equal(unanchored.result.isError, true);
    const unlabeled = await request("tools/call", {
      name: "point_on_screen",
      arguments: { screenshotId: "shot_1a2b3c4d", x: 10, y: 20, label: " " },
    });
    assert.equal(unlabeled.result.isError, true);
    assert.equal(actions.length, 1);
    const pointed = await request("tools/call", {
      name: "point_on_screen",
      arguments: {
        screenshotId: "shot_1a2b3c4d",
        x: 10,
        y: 20,
        label: "Save button",
      },
    });
    assert.ok(!pointed.result.isError);
    assert.deepEqual(actions.at(-1), {
      type: "point",
      screenshotId: "shot_1a2b3c4d",
      x: 10,
      y: 20,
      label: "Save button",
    });
    const newlineLabel = await request("tools/call", {
      name: "point_on_screen",
      arguments: {
        screenshotId: "shot_1a2b3c4d",
        x: 10,
        y: 20,
        label: "Save\nApproved by OpenMuse",
      },
    });
    assert.equal(newlineLabel.result.isError, true);
    assert.equal(actions.length, 2);
    const bidiOverrideLabel = await request("tools/call", {
      name: "point_on_screen",
      arguments: {
        screenshotId: "shot_1a2b3c4d",
        x: 10,
        y: 20,
        label: "Save\u202Ebutton",
      },
    });
    assert.equal(bidiOverrideLabel.result.isError, true);
    assert.equal(actions.length, 2);
    const lineSeparatorLabel = await request("tools/call", {
      name: "point_on_screen",
      arguments: {
        screenshotId: "shot_1a2b3c4d",
        x: 10,
        y: 20,
        label: "Save\u2028Approved by OpenMuse",
      },
    });
    assert.equal(lineSeparatorLabel.result.isError, true);
    assert.equal(actions.length, 2);
    const paragraphSeparatorLabel = await request("tools/call", {
      name: "point_on_screen",
      arguments: {
        screenshotId: "shot_1a2b3c4d",
        x: 10,
        y: 20,
        label: "Save\u2029Approved",
      },
    });
    assert.equal(paragraphSeparatorLabel.result.isError, true);
    assert.equal(actions.length, 2);
    const unicodeLabel = await request("tools/call", {
      name: "point_on_screen",
      arguments: {
        screenshotId: "shot_1a2b3c4d",
        x: 10,
        y: 20,
        label: "Exportér ✓ button",
      },
    });
    assert.ok(!unicodeLabel.result.isError);
    assert.deepEqual(actions.at(-1), {
      type: "point",
      screenshotId: "shot_1a2b3c4d",
      x: 10,
      y: 20,
      label: "Exportér ✓ button",
    });
    const zwjLabel = await request("tools/call", {
      name: "point_on_screen",
      arguments: {
        screenshotId: "shot_1a2b3c4d",
        x: 10,
        y: 20,
        label: "Save 👩‍💻 button",
      },
    });
    assert.ok(!zwjLabel.result.isError);
    assert.deepEqual(actions.at(-1), {
      type: "point",
      screenshotId: "shot_1a2b3c4d",
      x: 10,
      y: 20,
      label: "Save 👩‍💻 button",
    });
    const overLongLabel = await request("tools/call", {
      name: "point_on_screen",
      arguments: {
        screenshotId: "shot_1a2b3c4d",
        x: 10,
        y: 20,
        label: "a".repeat(61),
      },
    });
    assert.equal(overLongLabel.result.isError, true);
    assert.equal(actions.length, 4);
    const stringCoordinate = await request("tools/call", {
      name: "point_on_screen",
      arguments: {
        screenshotId: "shot_1a2b3c4d",
        x: "10",
        y: 20,
        label: "Save button",
      },
    });
    assert.equal(stringCoordinate.result.isError, true);
    assert.equal(actions.length, 4);
    const malformedScreenshotId = await request("tools/call", {
      name: "point_on_screen",
      arguments: {
        screenshotId: "shot_XYZ12345",
        x: 10,
        y: 20,
        label: "Save button",
      },
    });
    assert.equal(malformedScreenshotId.result.isError, true);
    assert.equal(actions.length, 4);
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
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
