import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  askApproval,
  type ApprovalDeps,
  type ApprovalDialogOptions,
} from "../electron/approval";
import {
  performPointAction,
  type PointActionDeps,
} from "../electron/point-action";
import {
  captureScreenshot,
  type CaptureDeps,
} from "../electron/screen-capture";
import { RING_MARGIN } from "../electron/window-occlusion";
import { pointPrompt } from "../server/point-schema";
import * as shots from "../server/screenshots";
import { otherId } from "./test-ids";

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

// Splits the spec into its **Messages.** section, the **Tests.** section
// that follows it, and the rest of the spec, which picks up again at
// **Verification.**.
function splitSpec(spec: string) {
  const messages = spec.indexOf("**Messages.**");
  const tests = spec.indexOf("**Tests.**", messages);
  const verification = spec.indexOf("**Verification.**", tests);
  assert.ok(
    messages >= 0 && tests > messages && verification > tests,
    "The spec must have **Messages.**, **Tests.** and **Verification.** sections, in that order",
  );
  return {
    messages: spec.slice(messages, tests),
    rest: spec.slice(0, messages) + spec.slice(verification),
  };
}

// The message of the Error that `promise` rejects with.
async function rejection(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof Error, `Expected an Error, got ${error}`);
    return error.message;
  }
  assert.fail("Expected a rejection");
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

// askApproval's own errors, with a message box that closes as Cancel: a
// request cancelled before the user answered, and a prompt whose host window
// hid before they did.
async function approvalErrors() {
  const deps: ApprovalDeps = {
    activate: () => {},
    showMessageBox: async () => ({ response: 0 }),
  };
  const prompt = pointPrompt("Save button", label);
  return [
    await rejection(askApproval(prompt, deps, AbortSignal.abort())),
    await rejection(askApproval(prompt, { ...deps, hostHidden: () => true })),
  ];
}

// performPointAction's own errors: a decline, a request cancelled after
// "Allow once", and a second resolve that returns a different screenshot
// from the one the user was shown.
async function pointErrors() {
  const approved = { label };
  const replacement = { label };
  const point = { x: 1, y: 1 };
  const deps = (change: Partial<PointActionDeps>): PointActionDeps => ({
    resolve: () => ({ shot: approved, point }),
    confirm: async () => true,
    windows: () => [],
    showPointer: async () => {},
    ...change,
  });
  const cancelling = new AbortController();
  let resolves = 0;
  return [
    await rejection(
      performPointAction("Save button", deps({ confirm: async () => false })),
    ),
    await rejection(
      performPointAction(
        "Save button",
        deps({
          confirm: async () => {
            cancelling.abort();
            return true;
          },
        }),
        cancelling.signal,
      ),
    ),
    await rejection(
      performPointAction(
        "Save button",
        deps({
          resolve: () => {
            resolves += 1;
            return { shot: resolves === 1 ? approved : replacement, point };
          },
        }),
      ),
    ),
  ];
}

// captureScreenshot's timeout, from a getSources that never answers.
function captureTimeout() {
  const deps: CaptureDeps = {
    screenCaptureAllowed: async () => true,
    primaryDisplay: () => ({
      id: 1,
      label,
      size: { width: bounds.width, height: bounds.height },
      bounds,
    }),
    displays: () => [{ id: 1, bounds }],
    conceal: () => () => {},
    wait: async () => {},
    sources: () => new Promise(() => {}),
    rebuild: (png) => png,
    register: () => assert.fail("A capture that timed out must not register"),
    sourcesTimeoutMs: 1,
  };
  return rejection(captureScreenshot(deps));
}

// electron/main.ts imports Electron, which doesn't load under the Node test
// runner, so the open-app prompt it builds can't be captured through a fake.
// These are checked against its source text instead: the message as it is,
// and the detail up to the bundle id it ends with.
const OPEN_APP_MESSAGE = "The agent wants to open an app";
const OPEN_APP_DETAIL = "The agent says the app is: ";

// src/Assistant.tsx is a React component that needs CopilotKit's providers
// to render, so its footer is read from its source text instead. Prettier
// wraps the footer's JSX text over two lines, and JSX joins them with one
// space, so the whitespace is collapsed the same way before the check.
const FOOTER = "Screenshots shared when sent";
async function footerText() {
  const footer = /<footer\b[^>]*>([\s\S]*?)<\/footer>/.exec(
    await read("../src/Assistant.tsx"),
  );
  assert.ok(footer, "src/Assistant.tsx must render a <footer>");
  return footer[1].replace(/\s+/g, " ");
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
  const { messages } = splitSpec(await read(SPEC));
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

test("the spec quotes the approval, pointer and capture errors, the open-app prompt and the footer as the code has them", async () => {
  const main = await read("../electron/main.ts");
  assert.ok(
    main.includes(`message: "${OPEN_APP_MESSAGE}"`),
    `electron/main.ts no longer asks "${OPEN_APP_MESSAGE}"; update this test and the spec`,
  );
  assert.ok(
    main.includes("detail: `" + OPEN_APP_DETAIL + "${action.bundleId}`"),
    `electron/main.ts no longer details "${OPEN_APP_DETAIL}<bundle id>"; update this test and the spec`,
  );
  assert.ok(
    (await footerText()).includes(FOOTER),
    `src/Assistant.tsx's footer no longer reads "${FOOTER}"; update this test and the spec`,
  );
  const texts = [
    await captureTimeout(),
    ...(await approvalErrors()),
    ...(await pointErrors()),
    OPEN_APP_MESSAGE,
    OPEN_APP_DETAIL + "<bundle id>",
    FOOTER,
  ];
  assertQuotes(await read(SPEC), "The spec", texts.map(code));
});

test("the README and the spec state the limits the code enforces", async () => {
  const age = `more than ${shots.MAX_AGE_MS / 60_000} minutes`;
  // The Messages section quotes the age refusal, and the Tests section names
  // the limits its tests check, so either could satisfy these checks by
  // itself; the spec is checked without both.
  const { rest } = splitSpec(await read(SPEC));
  assertQuotes(rest, "The spec outside its Messages and Tests sections", [
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
