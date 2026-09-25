import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { askApproval, type ApprovalDialogOptions } from "../electron/approval";
import { RING_MARGIN } from "../electron/window-occlusion";
import { pointPrompt } from "../server/point-schema";
import * as shots from "../server/screenshots";

// The docs quote what the code says. Each message below comes from the real
// code with sample values, which are then swapped for the docs' placeholders,
// so a reworded message fails naming the exact text the docs must now quote.
const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
const SPEC = "../docs/superpowers/specs/2026-09-24-clicky-learnings-design.md";
const code = (text: string) => "`" + text + "`";

function assertQuotes(doc: string, name: string, texts: string[]) {
  const missing = texts.filter((text) => !doc.includes(text));
  assert.deepEqual(missing, [], `${name} must quote:\n${missing.join("\n")}`);
}

// Splits the spec into its **Messages.** section, which runs up to its
// **Tests.** section, and the rest of the spec.
function splitMessages(spec: string) {
  const start = spec.indexOf("**Messages.**");
  const end = spec.indexOf("**Tests.**", start);
  assert.ok(
    start >= 0 && end > start,
    "The spec must have a **Messages.** section followed by **Tests.**",
  );
  return {
    messages: spec.slice(start, end),
    rest: spec.slice(0, start) + spec.slice(end),
  };
}

// A well-formed id that can never be the registered one: the same id with
// its last hex digit changed.
function otherId(id: string) {
  const last = Number.parseInt(id.slice(-1), 16);
  return id.slice(0, -1) + ((last + 1) % 16).toString(16);
}

const now = 1_000_000;
const bounds = { x: 0, y: 0, width: 1512, height: 982 };
const registry = new shots.ScreenshotRegistry(shots.REGISTRY_LIMIT, () => now);
const label = "Built-in Retina Display";
const size = { width: 1386, height: 900 };
const shot = registry.add({ displayId: "1", label, bounds, ...size });
const unknownId = otherId(shot.id);
const outside = { x: 2222, y: 3333 };
const n = 7;
const placeholders = (text: string) =>
  text
    .replaceAll(shot.id, "<id>")
    .replaceAll(unknownId, "<id>")
    .replaceAll(label, "<display>")
    .replaceAll(`Image ${n} `, "Image <n> ")
    .replaceAll(`${shot.width}×${shot.height}`, "<width>×<height>")
    .replaceAll(`(${outside.x}, ${outside.y})`, "(<x>, <y>)");

type Displays = Parameters<typeof shots.resolvePoint>[1];
type Query = Parameters<typeof shots.resolvePoint>[2];
function refusal(displays: Displays, change: Partial<Query> = {}, at = now) {
  const request = { screenshotId: shot.id, x: 10, y: 10, ...change };
  let thrown: unknown;
  try {
    shots.resolvePoint(registry, displays, request, at);
  } catch (error) {
    thrown = error;
  }
  assert.ok(
    thrown instanceof Error,
    `Expected resolvePoint to throw an Error for ${JSON.stringify(request)} at ${at}`,
  );
  return thrown.message;
}

// Every refusal, in the order resolvePoint and screenPoint check them: the
// id, a capture time in the future, the age, the display's presence, its
// bounds, and last the point.
function refusals() {
  const live = [{ id: 1, bounds }];
  const moved = [{ id: 1, bounds: { ...bounds, x: 1 } }];
  return [
    refusal(live, { screenshotId: unknownId }),
    refusal(live, {}, now - 1),
    refusal(live, {}, now + shots.MAX_AGE_MS + 1),
    refusal([]),
    refusal(moved),
    refusal(live, outside),
  ];
}

test("the spec quotes every refusal and image note the code produces", async () => {
  const messages = [
    ...refusals(),
    shots.unreferencedImageNote(n),
    shots.unknownImageNote(n),
    shots.mismatchedImageNote(n),
    shots.staleImageNote(n),
    shots.describeScreenshot(shot, n),
  ];
  const quoted = messages.map((message) => code(placeholders(message)));
  assertQuotes(await read(SPEC), "The spec", quoted);
});

test("the spec's Messages section lists the refusals in the order the code checks them", async () => {
  const { messages } = splitMessages(await read(SPEC));
  const misplaced: string[] = [];
  let from = 0;
  for (const text of refusals().map((message) => code(placeholders(message)))) {
    const at = messages.indexOf(text, from);
    if (at < 0) misplaced.push(text);
    else from = at + text.length;
  }
  assert.deepEqual(
    misplaced,
    [],
    `The Messages section must list the refusals in the order the code checks them. Missing or out of order:\n${misplaced.join("\n")}`,
  );
});

test("the spec quotes the point approval prompt and dialog text", async () => {
  const prompt = pointPrompt("<label>", "<display>");
  const dialogs: ApprovalDialogOptions[] = [];
  const showMessageBox = async (options: ApprovalDialogOptions) => {
    dialogs.push(options);
    return { response: 0 };
  };
  await askApproval(prompt, { activate: () => {}, showMessageBox });
  const [{ title, buttons }] = dialogs;
  const texts = [prompt.message, prompt.detail, title, ...buttons];
  assertQuotes(await read(SPEC), "The spec", texts.map(code));
});

test("the README and the spec state the limits the code enforces", async () => {
  const age = `more than ${shots.MAX_AGE_MS / 60_000} minutes`;
  // The Messages section quotes the age refusal, which would satisfy the age
  // check by itself, so the spec is checked without it.
  const { rest } = splitMessages(await read(SPEC));
  assertQuotes(rest, "The spec outside its Messages section", [
    age,
    `the ${shots.REGISTRY_LIMIT} most recent captures`,
    `Longest side at most ${shots.CAPTURE_MAX_DIMENSION} px`,
  ]);
  assertQuotes(await read("../README.md"), "The README", [
    age,
    `${shots.REGISTRY_LIMIT} newer captures`,
  ]);
});

test("the spec states the ring margin the code uses", async () => {
  assertQuotes(await read(SPEC), "The spec", [
    `\`RING_MARGIN\` (${RING_MARGIN} pt`,
  ]);
});
