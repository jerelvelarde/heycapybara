import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { askApproval, type ApprovalDialogOptions } from "../electron/approval";
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

const now = 1_000_000;
const bounds = { x: 0, y: 0, width: 1512, height: 982 };
const registry = new shots.ScreenshotRegistry(shots.REGISTRY_LIMIT, () => now);
const label = "Built-in Retina Display";
const size = { width: 1386, height: 900 };
const shot = registry.add({ displayId: "1", label, bounds, ...size });
const unknownId = "shot_ffffffff";
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
  try {
    shots.resolvePoint(registry, displays, request, at);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error(`Expected a refusal for ${JSON.stringify(request)}`);
}

test("the spec quotes every refusal and image note the code produces", async () => {
  const live = [{ id: 1, bounds }];
  const moved = [{ id: 1, bounds: { ...bounds, x: 1 } }];
  const messages = [
    refusal(live, { screenshotId: unknownId }),
    refusal(live, {}, now + shots.MAX_AGE_MS + 1),
    refusal(live, {}, now - 1),
    refusal([]),
    refusal(moved),
    refusal(live, outside),
    shots.unreferencedImageNote(n),
    shots.unknownImageNote(n),
    shots.mismatchedImageNote(n),
    shots.staleImageNote(n),
    shots.describeScreenshot(shot, n),
  ];
  const quoted = messages.map((message) => code(placeholders(message)));
  assertQuotes(await read(SPEC), "The spec", quoted);
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
  assertQuotes(await read(SPEC), "The spec", [
    age,
    `the ${shots.REGISTRY_LIMIT} most recent captures`,
    `Longest side at most ${shots.CAPTURE_MAX_DIMENSION} px`,
  ]);
  assertQuotes(await read("../README.md"), "The README", [
    age,
    `${shots.REGISTRY_LIMIT} newer captures`,
  ]);
});
