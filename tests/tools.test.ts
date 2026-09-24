import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../electron/store";
import { createToolHandler } from "../server/tools";

test("MCP exposes real skill tools and validates native action arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "kite-mcp-test-"));
  const store = new Store(root);
  await store.load();
  let actions = 0;
  const handler = createToolHandler({
    store,
    containerId: "desktop-workflows",
    action: async () => {
      actions++;
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
    assert.equal(actions, 0);
    const valid = await request("tools/call", {
      name: "open_application",
      arguments: { bundleId: "com.apple.TextEdit" },
    });
    assert.ok(!valid.result.isError);
    assert.equal(actions, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
