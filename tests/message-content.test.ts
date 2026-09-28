import { test } from "node:test";
import assert from "node:assert/strict";
import { RunAgentInputSchema } from "@ag-ui/core";
import {
  createEpoch,
  displayText,
  ipcErrorMessage,
  requestAttachment,
  userContent,
} from "../src/message-content";
import type { ScreenshotAttachment } from "../src/types";

const image: ScreenshotAttachment = {
  id: "shot_1a2b3c4d",
  label: "Built-in Retina Display",
  width: 2,
  height: 2,
  dataUrl: "data:image/png;base64,AAAA",
};

test("requestAttachment drops a pending image for a fresh request", () => {
  assert.equal(requestAttachment(true, image), null);
});

test("requestAttachment keeps a pending image for a request that continues the thread", () => {
  assert.equal(requestAttachment(false, image), image);
});

test("requestAttachment stays null for a continuing request with nothing attached", () => {
  assert.equal(requestAttachment(false, null), null);
});

test("createEpoch: a capture taken before advance() reads as stale afterwards", () => {
  const epoch = createEpoch();
  const isCurrent = epoch.capture();
  epoch.advance();
  assert.equal(isCurrent(), false);
});

test("createEpoch: a capture taken after advance() reads as current", () => {
  const epoch = createEpoch();
  epoch.advance();
  const isCurrent = epoch.capture();
  assert.equal(isCurrent(), true);
});

test("createEpoch: a capture stays current until the next advance()", () => {
  const epoch = createEpoch();
  const isCurrent = epoch.capture();
  assert.equal(isCurrent(), true);
  epoch.advance();
  assert.equal(isCurrent(), false);
});

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

test("a data URL with an extra comma is rejected instead of silently truncated", () => {
  assert.throws(
    () =>
      userContent("hi", {
        ...image,
        dataUrl: "data:image/png;base64,AAAA,BBBB",
      }),
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

test("ipcErrorMessage strips Electron's remote-method prefix and the nested Error label", () => {
  const error = new Error(
    "Error invoking remote method 'kite:screenshot': Error: Couldn't find a screen source for Main display. Try again, or reconnect the display.",
  );
  assert.equal(
    ipcErrorMessage(error, "Screenshot failed"),
    "Couldn't find a screen source for Main display. Try again, or reconnect the display.",
  );
});

test("ipcErrorMessage strips the prefix even without a nested Error label", () => {
  const error = new Error(
    "Error invoking remote method 'kite:screenshot': Allow Screen Recording for OpenMuse Desktop in System Settings > Privacy & Security > Screen & System Audio Recording, then quit and reopen OpenMuse Desktop.",
  );
  assert.equal(
    ipcErrorMessage(error, "Screenshot failed"),
    "Allow Screen Recording for OpenMuse Desktop in System Settings > Privacy & Security > Screen & System Audio Recording, then quit and reopen OpenMuse Desktop.",
  );
});

test("ipcErrorMessage leaves an unprefixed message unchanged", () => {
  const error = new Error("The display changed during the capture. Try again.");
  assert.equal(
    ipcErrorMessage(error, "Screenshot failed"),
    "The display changed during the capture. Try again.",
  );
});

test("ipcErrorMessage strips a SyntaxError label after the Electron prefix", () => {
  const error = new Error(
    "Error invoking remote method 'kite:screenshot': SyntaxError: Unexpected token in JSON",
  );
  assert.equal(
    ipcErrorMessage(error, "Screenshot failed"),
    "Unexpected token in JSON",
  );
});

test("ipcErrorMessage strips a TypeError label after the Electron prefix", () => {
  const error = new Error(
    "Error invoking remote method 'kite:screenshot': TypeError: Cannot read properties of undefined",
  );
  assert.equal(
    ipcErrorMessage(error, "Screenshot failed"),
    "Cannot read properties of undefined",
  );
});

test("ipcErrorMessage strips a ZodError label after the Electron prefix", () => {
  const error = new Error(
    "Error invoking remote method 'kite:screenshot': ZodError: Invalid input",
  );
  assert.equal(ipcErrorMessage(error, "Screenshot failed"), "Invalid input");
});

test("ipcErrorMessage strips the Error label from an otherwise unprefixed message", () => {
  const error = new Error("Error: x");
  assert.equal(ipcErrorMessage(error, "Screenshot failed"), "x");
});

test("ipcErrorMessage falls back for a non-Error value", () => {
  assert.equal(
    ipcErrorMessage("boom", "Screenshot failed"),
    "Screenshot failed",
  );
  assert.equal(
    ipcErrorMessage(undefined, "Screenshot failed"),
    "Screenshot failed",
  );
});

test("displayText shows text, abridges recording prompts and hides tool-call-only replies", () => {
  assert.equal(displayText({ role: "assistant", content: "Done" }), "Done");
  assert.equal(displayText({ role: "assistant", content: "" }), null);
  assert.equal(displayText({ role: "assistant" }), null);
  assert.equal(
    displayText({ role: "user", content: [{ type: "text", text: "hi" }] }),
    "Screen context attached",
  );
  assert.equal(
    displayText({ role: "user", content: "x".repeat(2401) }),
    "x".repeat(240) + "\n[Reviewed recording attached]",
  );
});
