import { test } from "node:test";
import assert from "node:assert/strict";
import { RunAgentInputSchema } from "@ag-ui/core";
import { userContent } from "../src/message-content";
import type { ScreenshotAttachment } from "../src/types";

const image: ScreenshotAttachment = {
  id: "shot_1a2b3c4d",
  label: "Built-in Retina Display",
  width: 2,
  height: 2,
  dataUrl: "data:image/png;base64,AAAA",
};

test("no image sends the prompt as plain text", () => {
  assert.equal(userContent("hi", null), "hi");
});

test("an attached image rides alongside the prompt with its id", () => {
  const content = userContent("hi", image);
  assert.deepEqual(content, [
    { type: "text", text: "hi" },
    {
      type: "binary",
      mimeType: "image/png",
      data: "AAAA",
      id: "shot_1a2b3c4d",
    },
  ]);
});

test("a non-PNG or malformed data URL is rejected rather than sent as undefined data", () => {
  assert.throws(
    () =>
      userContent("hi", { ...image, dataUrl: "data:image/jpeg;base64,AAAA" }),
    /not a PNG data URL/,
  );
  assert.throws(
    () => userContent("hi", { ...image, dataUrl: "data:image/png;base64," }),
    /not a PNG data URL/,
  );
});

test("AG-UI's own schema keeps the screenshot id on the parsed binary part", () => {
  const parsed = RunAgentInputSchema.parse({
    threadId: "t",
    runId: "r",
    state: {},
    messages: [{ id: "m", role: "user", content: userContent("hi", image) }],
    tools: [],
    context: [],
    forwardedProps: {},
  });
  const message = parsed.messages[0];
  assert.ok(Array.isArray(message.content));
  const content = message.content as Array<{ id?: string }>;
  assert.equal(content[1].id, "shot_1a2b3c4d");
});
