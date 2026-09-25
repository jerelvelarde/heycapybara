# Point Where the Model Looked Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the agent points at something it saw in an attached screenshot, the pointer lands on that thing.

**Architecture:** The main process sizes every capture so Codex passes it through unchanged. It measures the PNG it actually produced and registers the capture's display geometry under a random ID. The Codex adapter adds a note for each image, naming it by position (the Codex SDK joins text parts into one prompt and passes images separately, in order) and giving its screenshot ID and pixel size. `point_on_screen` takes that ID plus x, y in image pixels. The main process converts the point to global screen points and hands it to the existing Swift `--point` command.

**Tech Stack:** Electron 44, TypeScript 6, zod 4, `@openai/codex-sdk` 0.156.1, MCP SDK, Node test runner via `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-09-24-clicky-learnings-design.md` (section 1)

## Global Constraints

- Run every command from the worktree root: `/Users/jerel-cpk/Documents/ChatGPT/Kite-Sprite/.worktrees/clicky-learnings`.
- No new dependencies.
- Codex pass-through limits (codex-rs `PromptImageMode::HIGH_DETAIL`, v0.156.1): longest side ≤ 2048 px, and `ceil(w/32) * ceil(h/32)` ≤ 2500. Captures are capped at 1920 px on the longest side and never upscaled.
- Screenshot IDs match `^shot_[0-9a-f]{8}$`. The registry keeps the 16 most recent captures, and a capture expires after 10 minutes.
- A point's label is 1 to 60 characters after trimming.
- Keep the `kite:` IPC names, the sender checks, and zod validation. No test-only hooks in production code.
- Match the surrounding style: Prettier defaults, sparse comments, zod at boundaries.
- Commit messages use a conventional prefix (`feat:`, `fix:`, `test:`, `docs:`) and have no attribution lines.
- Gates before the PR: `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build:native`, `npm run build`.

---

### Task 1: Screenshot sizing, registry and point conversion

**Files:**

- Create: `server/screenshots.ts`
- Test: `tests/screenshots.test.ts`

**Interfaces:**

- Produces:
  - `type Rect = { x: number; y: number; width: number; height: number }`
  - `type Size = { width: number; height: number }`
  - `type Screenshot = { id: string; displayId: string; label: string; bounds: Rect; width: number; height: number; capturedAt: number }`
  - `fitsPromptBudget(size: Size): boolean`
  - `captureSize(display: Size): Size`
  - `pngSize(png: Uint8Array): Size`
  - `class ScreenshotRegistry { constructor(limit = 16, now = () => Date.now()); add(input: Omit<Screenshot, "id" | "capturedAt">): Screenshot; get(id: string): Screenshot | undefined }`
  - `screenPoint(shot: Screenshot, point: { x: number; y: number }, current: Rect | undefined, now = Date.now()): { x: number; y: number }`
  - `describeScreenshot(shot: Screenshot, imageNumber: number): string`
  - `unreferencedImageNote(imageNumber: number): string`

- [x] **Step 1: Write the failing tests**

Create `tests/screenshots.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ScreenshotRegistry,
  captureSize,
  describeScreenshot,
  fitsPromptBudget,
  pngSize,
  screenPoint,
  unreferencedImageNote,
  type Screenshot,
} from "../server/screenshots";

const display = { x: 0, y: 0, width: 1512, height: 982 };
const shot: Screenshot = {
  id: "shot_0000000a",
  displayId: "1",
  label: "Built-in Retina Display",
  bounds: display,
  width: 1386,
  height: 900,
  capturedAt: 1_000_000,
};

function pngHeader(width: number, height: number) {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

test("the prompt budget matches Codex's high-detail limits", () => {
  assert.equal(fitsPromptBudget({ width: 1920, height: 1200 }), true);
  assert.equal(fitsPromptBudget({ width: 1600, height: 1600 }), true);
  assert.equal(fitsPromptBudget({ width: 1601, height: 1600 }), false);
  assert.equal(fitsPromptBudget({ width: 2049, height: 100 }), false);
  assert.equal(fitsPromptBudget({ width: 2048, height: 1280 }), false);
});

test("captures keep the display's shape and pass through Codex unchanged", () => {
  assert.deepEqual(captureSize({ width: 1512, height: 982 }), {
    width: 1512,
    height: 982,
  });
  assert.deepEqual(captureSize({ width: 2560, height: 1440 }), {
    width: 1920,
    height: 1080,
  });
  assert.deepEqual(captureSize({ width: 1440, height: 2560 }), {
    width: 1080,
    height: 1920,
  });
  for (const source of [
    { width: 3440, height: 1440 },
    { width: 2048, height: 1536 },
    { width: 6016, height: 3384 },
    { width: 800, height: 600 },
  ]) {
    const size = captureSize(source);
    assert.ok(fitsPromptBudget(size), JSON.stringify({ source, size }));
    assert.ok(size.width <= source.width && size.height <= source.height);
    assert.ok(
      Math.abs(size.width / size.height - source.width / source.height) < 0.01,
    );
  }
  assert.throws(() => captureSize({ width: 0, height: 900 }), /display size/);
});

test("PNG size comes from the image header", () => {
  assert.deepEqual(pngSize(pngHeader(1386, 900)), {
    width: 1386,
    height: 900,
  });
  const offset = Buffer.concat([
    Buffer.alloc(7),
    Buffer.from(pngHeader(3, 4)),
  ]).subarray(7);
  assert.deepEqual(pngSize(offset), { width: 3, height: 4 });
  const jpeg = pngHeader(10, 10);
  jpeg[0] = 0xff;
  assert.throws(() => pngSize(jpeg), /not a PNG/);
  assert.throws(() => pngSize(new Uint8Array([1, 2, 3])), /not a PNG/);
});

test("the registry issues unguessable ids and keeps only recent captures", () => {
  const registry = new ScreenshotRegistry(2, () => 42);
  const bounds = { ...display };
  const input = {
    displayId: "1",
    label: "Built-in Retina Display",
    bounds,
    width: 1386,
    height: 900,
  };
  const first = registry.add(input);
  const second = registry.add(input);
  assert.match(first.id, /^shot_[0-9a-f]{8}$/);
  assert.notEqual(first.id, second.id);
  assert.equal(first.capturedAt, 42);
  bounds.x = 500;
  assert.equal(registry.get(first.id)?.bounds.x, 0);
  registry.add(input);
  assert.equal(registry.get(first.id), undefined);
  assert.ok(registry.get(second.id));
  assert.equal(registry.get("shot_00000000"), undefined);
});

test("image pixels map to the centre of the matching screen point", () => {
  const point = screenPoint(shot, { x: 692, y: 449 }, display, 1_000_000);
  assert.ok(Math.abs(point.x - 692.5 * (1512 / 1386)) < 1e-9);
  assert.ok(Math.abs(point.y - 449.5 * (982 / 900)) < 1e-9);
  const secondary: Screenshot = {
    ...shot,
    bounds: { x: -1920, y: -200, width: 1920, height: 1080 },
    width: 1920,
    height: 1080,
  };
  assert.deepEqual(
    screenPoint(secondary, { x: 100, y: 100 }, secondary.bounds, 1_000_000),
    { x: -1819.5, y: -99.5 },
  );
});

test("pointing refuses stale, moved, missing or out-of-range screenshots", () => {
  const now = 1_000_000;
  assert.throws(
    () => screenPoint(shot, { x: 1, y: 1 }, display, now + 10 * 60 * 1000 + 1),
    /more than 10 minutes old/,
  );
  assert.throws(
    () => screenPoint(shot, { x: 1, y: 1 }, undefined, now),
    /no longer connected/,
  );
  assert.throws(
    () => screenPoint(shot, { x: 1, y: 1 }, { ...display, width: 1800 }, now),
    /changed/,
  );
  for (const point of [
    { x: 1386, y: 1 },
    { x: -1, y: 1 },
    { x: 1, y: 900 },
    { x: Number.NaN, y: 1 },
  ])
    assert.throws(() => screenPoint(shot, point, display, now), /outside/);
});

test("the model is told which image is which screenshot, and its pixel size", () => {
  const text = describeScreenshot(shot, 2);
  assert.match(text, /^Image 2 in this message is screenshot shot_0000000a/);
  assert.match(text, /Built-in Retina Display/);
  assert.match(text, /1386×900 pixels/);
  assert.match(text, /point_on_screen/);
  assert.match(
    unreferencedImageNote(3),
    /^Image 3 in this message has no screen reference/,
  );
});
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `npx tsx --test tests/screenshots.test.ts`
Expected: FAIL with `Cannot find module '../server/screenshots'`.

- [x] **Step 3: Write the implementation**

Create `server/screenshots.ts`:

```ts
import { randomBytes } from "node:crypto";

export type Rect = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };
export type Screenshot = {
  id: string;
  displayId: string;
  label: string;
  bounds: Rect;
  width: number;
  height: number;
  capturedAt: number;
};

// Codex re-encodes prompt images outside these limits (codex-rs utils/image,
// PromptImageMode::HIGH_DETAIL). A resized image no longer matches the pixel
// size we give the model, so every capture must fit them.
const MAX_DIMENSION = 2048;
const MAX_PATCHES = 2500;
const PATCH_SIZE = 32;
const CAPTURE_MAX_DIMENSION = 1920;
const MAX_AGE_MS = 10 * 60 * 1000;

export function fitsPromptBudget({ width, height }: Size) {
  return (
    width <= MAX_DIMENSION &&
    height <= MAX_DIMENSION &&
    Math.ceil(width / PATCH_SIZE) * Math.ceil(height / PATCH_SIZE) <=
      MAX_PATCHES
  );
}

export function captureSize(display: Size): Size {
  if (!(display.width > 0 && display.height > 0))
    throw new Error("Invalid display size");
  let scale = Math.min(
    1,
    CAPTURE_MAX_DIMENSION / Math.max(display.width, display.height),
  );
  for (;;) {
    const size = {
      width: Math.max(1, Math.floor(display.width * scale)),
      height: Math.max(1, Math.floor(display.height * scale)),
    };
    if (fitsPromptBudget(size)) return size;
    scale *= 0.98;
  }
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = [0x49, 0x48, 0x44, 0x52];

export function pngSize(png: Uint8Array): Size {
  if (
    png.length < 24 ||
    PNG_SIGNATURE.some((byte, index) => png[index] !== byte) ||
    IHDR.some((byte, index) => png[12 + index] !== byte)
  )
    throw new Error("Screen capture is not a PNG image");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export class ScreenshotRegistry {
  private entries = new Map<string, Screenshot>();
  constructor(
    private readonly limit = 16,
    private readonly now = () => Date.now(),
  ) {}
  add(input: Omit<Screenshot, "id" | "capturedAt">): Screenshot {
    let id: string;
    do id = "shot_" + randomBytes(4).toString("hex");
    while (this.entries.has(id));
    const shot = {
      ...input,
      bounds: { ...input.bounds },
      id,
      capturedAt: this.now(),
    };
    this.entries.set(id, shot);
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.limit) break;
      this.entries.delete(oldest);
    }
    return shot;
  }
  get(id: string) {
    return this.entries.get(id);
  }
}

export function screenPoint(
  shot: Screenshot,
  point: { x: number; y: number },
  current: Rect | undefined,
  now = Date.now(),
) {
  if (now - shot.capturedAt > MAX_AGE_MS)
    throw new Error(
      "That screenshot is more than 10 minutes old. Ask the user to attach a new one.",
    );
  if (!current)
    throw new Error(
      `${shot.label} is no longer connected. Ask the user to attach a new screenshot.`,
    );
  const { bounds } = shot;
  if (
    current.x !== bounds.x ||
    current.y !== bounds.y ||
    current.width !== bounds.width ||
    current.height !== bounds.height
  )
    throw new Error(
      `${shot.label} changed position or resolution since the screenshot. Ask the user to attach a new one.`,
    );
  if (
    !(point.x >= 0 && point.x < shot.width) ||
    !(point.y >= 0 && point.y < shot.height)
  )
    throw new Error(
      `(${point.x}, ${point.y}) is outside the ${shot.width}×${shot.height} screenshot.`,
    );
  // Target the centre of the pixel so edge pixels stay inside the display.
  return {
    x: bounds.x + ((point.x + 0.5) * bounds.width) / shot.width,
    y: bounds.y + ((point.y + 0.5) * bounds.height) / shot.height,
  };
}

// The Codex SDK joins every text part into one prompt and passes images
// separately, in order, so each note names its image by position.
export function describeScreenshot(shot: Screenshot, imageNumber: number) {
  return `Image ${imageNumber} in this message is screenshot ${shot.id} of ${shot.label}, ${shot.width}×${shot.height} pixels. To point at something in it, call point_on_screen with screenshotId "${shot.id}", a short label, and x, y in that image's pixels (origin at the top-left, x rightward, y downward).`;
}

export function unreferencedImageNote(imageNumber: number) {
  return `Image ${imageNumber} in this message has no screen reference, so point_on_screen cannot target it.`;
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test tests/screenshots.test.ts`
Expected: PASS, 7 tests.

- [x] **Step 5: Commit**

```bash
git add server/screenshots.ts tests/screenshots.test.ts
git commit -m "feat: size and register screenshots for pointing"
```

---

### Task 2: Introduce each screenshot to the model

**Files:**

- Modify: `server/codex-agent.ts` (imports, `instructions`, `CodexRunnerOptions`, the `part.type === "binary"` branch of `CodexRunner.run`)
- Modify: `server/runtime.ts` (the `startRuntime` options and the `CodexRunner` construction)
- Test: `tests/codex.test.ts` (append one test)

**Interfaces:**

- Consumes: `describeScreenshot`, `unreferencedImageNote`, `type Screenshot` from Task 1.
- Produces:
  - `CodexRunnerOptions.screenshots?: { get(id: string): Screenshot | undefined }`
  - `startRuntime(store, { ..., screenshots?: { get(id: string): Screenshot | undefined } })`

- [x] **Step 1: Write the failing test**

Append to `tests/codex.test.ts`:

```ts
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
    width: 1512,
    height: 982,
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
  const image = Buffer.from("fixture image").toString("base64");
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
                data: image,
                id: shot.id,
              },
              { type: "binary", mimeType: "image/png", data: image },
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
    assert.match(parts[1].text ?? "", /1512×982 pixels/);
    assert.match(
      parts[3].text ?? "",
      /^Image 2 in this message has no screen reference/,
    );
    assert.match(instructions, /never guess screen coordinates/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test tests/codex.test.ts`
Expected: FAIL. The prompt part types are `["text", "local_image", "local_image"]`, and TypeScript reports the unknown `screenshots` option only under `npm run typecheck`.

- [x] **Step 3: Implement the prompt notes and instructions**

In `server/codex-agent.ts`, add the import under the existing `./codex-events` import:

```ts
import {
  describeScreenshot,
  unreferencedImageNote,
  type Screenshot,
} from "./screenshots";
```

Replace this sentence in `instructions`:

```
Desktop tools can open installed apps or show a pointer after native approval. They cannot click or type. Never use shell,
```

with:

```
Desktop tools can open installed apps or show a pointer after native approval. They cannot click or type. To point, pass the screenshot id and x, y in that screenshot's pixels, as given in the note that describes each attached image; never guess screen coordinates or point without a screenshot. Never use shell,
```

Add the option to `CodexRunnerOptions`, directly after `binaryPath?: string;`:

```ts
  screenshots?: { get(id: string): Screenshot | undefined };
```

Declare `let imageNumber = 0;` on its own line directly before `if (typeof latest.content === "string")`. Then, in the `part.type === "binary"` branch, insert the note immediately after the size/MIME validation `throw` and before `temp ??= ...`:

```ts
imageNumber += 1;
const shot = part.id ? this.options.screenshots?.get(part.id) : undefined;
prompt.push({
  type: "text",
  text: shot
    ? describeScreenshot(shot, imageNumber)
    : unreferencedImageNote(imageNumber),
});
```

In `server/runtime.ts`:

- add `import type { Screenshot } from "./screenshots";`
- extend the `options` parameter type with `screenshots?: { get(id: string): Screenshot | undefined };`
- pass `screenshots: options.screenshots,` in the `new CodexRunner({ ... })` object, after `binaryPath: options.binaryPath,`.

- [x] **Step 4: Run the tests to verify they pass**

Run: `npx tsx --test tests/codex.test.ts && npm run typecheck`
Expected: PASS, and tsc exits 0.

- [x] **Step 5: Commit**

```bash
git add server/codex-agent.ts server/runtime.ts tests/codex.test.ts
git commit -m "feat: tell the model each screenshot's id and pixel size"
```

---

### Task 3: Point with a screenshot reference

**Files:**

- Modify: `src/types.ts` (`DesktopAction`, new `ScreenshotAttachment`, `KiteAPI.screenshot`)
- Modify: `server/tools.ts` (`point_on_screen` registration)
- Modify: `electron/main.ts` (imports, a module-level registry, `approvedAction`, the `screenshot` handler, the `startRuntime` call)
- Modify: `src/Assistant.tsx` (the attachment state, message part and preview)
- Test: `tests/tools.test.ts`

**Interfaces:**

- Consumes: `ScreenshotRegistry`, `captureSize`, `fitsPromptBudget`, `pngSize`, `screenPoint` from Task 1; the `screenshots` option from Task 2.
- Produces:
  - `type ScreenshotAttachment = { id: string; label: string; width: number; height: number; dataUrl: string }`
  - `DesktopAction` point variant `{ type: "point"; screenshotId: string; x: number; y: number; label: string }`
  - `KiteAPI.screenshot(): Promise<ScreenshotAttachment>`

- [x] **Step 1: Write the failing test**

In `tests/tools.test.ts`:

- add `import type { DesktopAction } from "../src/types";`
- replace `let actions = 0;` and its `action` callback with:

```ts
const actions: DesktopAction[] = [];
const handler = createToolHandler({
  store,
  containerId: "desktop-workflows",
  action: async (action) => {
    actions.push(action);
  },
});
```

- change `assert.equal(actions, 0);` to `assert.equal(actions.length, 0);` and `assert.equal(actions, 1);` to `assert.equal(actions.length, 1);`
- before the `finally`, add:

```ts
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
```

- [x] **Step 2: Run the test to verify it fails**

Run: `npx tsx --test tests/tools.test.ts`
Expected: FAIL. The call without a screenshot reference succeeds, because today's schema needs only `x` and `y`.

- [x] **Step 3: Update the types and the tool**

In `src/types.ts`, replace `DesktopAction` and add the attachment type:

```ts
export type ScreenshotAttachment = {
  id: string;
  label: string;
  width: number;
  height: number;
  dataUrl: string;
};
export type DesktopAction =
  | { type: "open-app"; bundleId: string }
  | {
      type: "point";
      screenshotId: string;
      x: number;
      y: number;
      label: string;
    };
```

Change `screenshot(): Promise<string>;` in `KiteAPI` to `screenshot(): Promise<ScreenshotAttachment>;`.

In `server/tools.ts`, replace the whole `point_on_screen` registration with:

```ts
server.registerTool(
  "point_on_screen",
  {
    description:
      "Show a pointer on something visible in a screenshot the user attached, after native approval. Pass that screenshot's id and x, y in its pixels (origin at the top-left). Does not click.",
    inputSchema: {
      screenshotId: z.string().regex(/^shot_[0-9a-f]{8}$/),
      x: z.number().finite(),
      y: z.number().finite(),
      label: z
        .string()
        .trim()
        .min(1)
        .max(60)
        .describe('What you are pointing at, such as "Export button"'),
    },
  },
  async ({ screenshotId, x, y, label }) => {
    if (!options.action) throw new Error("Desktop actions unavailable");
    await options.action({ type: "point", screenshotId, x, y, label });
    return result("Pointer displayed after user approval");
  },
);
```

- [x] **Step 4: Update the main process**

In `electron/main.ts`:

1. Add under the `startRuntime` import:

```ts
import {
  ScreenshotRegistry,
  captureSize,
  fitsPromptBudget,
  pngSize,
  screenPoint,
} from "../server/screenshots";
```

Then change the type import from `../src/types` to:

```ts
import type {
  CompanionTrayMode,
  Permissions,
  ScreenshotAttachment,
  Settings,
} from "../src/types";
```

2. Add under `const exec = promisify(execFile);`:

```ts
const screenshots = new ScreenshotRegistry();
```

3. Replace the whole `approvedAction` function with:

```ts
async function approvedAction(input: unknown) {
  const action = z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("open-app"),
        bundleId: z.string().regex(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/),
      }),
      z.object({
        type: z.literal("point"),
        screenshotId: z.string().regex(/^shot_[0-9a-f]{8}$/),
        x: z.number().finite(),
        y: z.number().finite(),
        label: z.string().trim().min(1).max(60),
      }),
    ])
    .parse(input);
  let detail: string;
  let args: string[];
  if (action.type === "open-app") {
    detail = `Open application ${action.bundleId}`;
    args = ["--open-app", action.bundleId];
  } else {
    const shot = screenshots.get(action.screenshotId);
    if (!shot)
      throw new Error(
        "That screenshot is no longer available. Ask the user to attach a new one.",
      );
    const display = screen
      .getAllDisplays()
      .find((candidate) => String(candidate.id) === shot.displayId);
    // Check the geometry before asking, so the user never approves a point that cannot land.
    const point = screenPoint(shot, action, display?.bounds);
    detail = `Point at “${action.label}” on ${shot.label}`;
    args = ["--point", String(point.x), String(point.y)];
  }
  const result = await dialog.showMessageBox(workspace, {
    type: "question",
    title: "OpenMuse wants to take an action",
    message: detail,
    buttons: ["Cancel", "Allow once"],
    defaultId: 0,
    cancelId: 0,
  });
  if (result.response !== 1) throw new Error("User declined action");
  const { stdout } = await exec(helper, args);
  const events = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const error = events.find((e) => e.kind === "error");
  if (error) throw new Error(error.detail);
}
```

4. Pass the registry to the runtime: in `startRuntime(store, { ... })`, add `screenshots,` after `action: approvedAction,`.

5. Replace the whole `handle("screenshot", ...)` block with:

```ts
handle("screenshot", async (): Promise<ScreenshotAttachment> => {
  if (!(await permissions()).screenCapture)
    throw new Error("Enable Screen Recording permission in Settings.");
  const display = screen.getPrimaryDisplay();
  const target = captureSize(display.size);
  const restoreWorkspace = workspace.isVisible();
  const restoreBuddy = buddy.isVisible();
  const restoreNotch = notch.isVisible();
  const restoreChat = companionChat.isVisible();
  workspace.hide();
  buddy.hide();
  notch.hide();
  companionChat.hide();
  try {
    await new Promise((resolve) => setTimeout(resolve, 200));
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: target,
    });
    // A capture of another display would put the pointer in the wrong place.
    const source = sources.find(
      (candidate) => candidate.display_id === String(display.id),
    );
    if (!source || source.thumbnail.isEmpty())
      throw new Error("Screen capture unavailable");
    let png = source.thumbnail.toPNG();
    if (!fitsPromptBudget(pngSize(png)))
      png = source.thumbnail.resize(target).toPNG();
    const size = pngSize(png);
    if (!fitsPromptBudget(size))
      throw new Error("Screen capture is too large to send without resizing");
    const shot = screenshots.add({
      displayId: String(display.id),
      label: display.label || "the main display",
      bounds: display.bounds,
      ...size,
    });
    return {
      id: shot.id,
      label: shot.label,
      width: size.width,
      height: size.height,
      dataUrl: "data:image/png;base64," + png.toString("base64"),
    };
  } finally {
    if (restoreWorkspace) workspace.show();
    if (restoreBuddy) buddy.showInactive();
    if (restoreNotch) notch.showInactive();
    if (restoreChat) companionChat.showInactive();
  }
});
```

- [x] **Step 5: Send the reference from the composer**

In `src/Assistant.tsx`:

- change `import type { Settings } from "./types";` to `import type { ScreenshotAttachment, Settings } from "./types";`
- change `const [image, setImage] = useState("");` to `const [image, setImage] = useState<ScreenshotAttachment | null>(null);`
- change every `setImage("")` to `setImage(null)`. There are three: the new-conversation effect, after `setInput("")` in `send`, and the remove-attachment button.
- replace the binary part in `agent.addMessage` with:

```ts
            {
              type: "binary",
              mimeType: "image/png",
              data: image.dataUrl.split(",")[1],
              id: image.id,
            },
```

- change the attachment preview to `<img src={image.dataUrl} alt={"Screen capture of " + image.label + " to send"} />`.

- [x] **Step 6: Run the tests and typecheck**

Run: `npx tsx --test tests/tools.test.ts && npm run typecheck`
Expected: the tools test PASSES and `tsc` exits 0.

- [x] **Step 7: Commit**

```bash
git add src/types.ts server/tools.ts electron/main.ts src/Assistant.tsx tests/tools.test.ts
git commit -m "feat: point at a spot in an attached screenshot"
```

---

### Task 4: Document the contract and run every gate

**Files:**

- Modify: `README.md` (Desktop boundaries)

**Interfaces:**

- Consumes: the finished behavior from Tasks 1-3.

- [x] **Step 1: Document the contract**

In `README.md`, under "Desktop boundaries", replace:

```
- Agent tools can open installed applications and display a pointer after a native approval dialog. Codex executes shell and file tasks in the selected workspace. Cross-app execution remains guided; desktop clicking and typing are not implemented.
```

with:

```
- Agent tools can open installed applications and display a pointer after a native approval dialog. The pointer targets a spot in a screenshot you attached: the model gives pixel coordinates in that image, and OpenMuse converts them to screen points. Screenshots are sized so Codex does not resize them, and a point is refused if the screenshot is more than 10 minutes old or its display has moved or changed resolution. Codex executes shell and file tasks in the selected workspace. Cross-app execution remains guided; desktop clicking and typing are not implemented.
```

- [x] **Step 2: Run every gate**

Run: `npm test && npm run typecheck && npm run lint && npm run format:check && npm run build:native && npm run build`
Expected: all pass. If `format:check` fails, run `npx prettier --write` only on the files this plan touched, then rerun.

- [x] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: describe screenshot-based pointing"
```

---

### Task 5: Verify in the running app

**Files:**

- Modify: `docs/verification.md` (new section at the top, written from what was actually observed)

- [ ] **Step 1: Launch and check the capture**

Run: `npm run dev`. If Screen Recording is granted to the development Electron app, attach a screenshot in the workspace and confirm the preview appears. Otherwise record that it could not be checked.

- [ ] **Step 2: Live pointing check (needs an OpenAI session key)**

With a key connected in Settings:

1. Attach a screenshot.
2. Ask: "Point at the Apple menu."
3. Confirm the approval text reads `Point at "…" on <display name>`, approve it, and confirm the red ring lands on the Apple menu.

Without a key or permission, write down exactly which step could not run.

- [ ] **Step 3: Record the results and commit**

Add a `## Pointer screenshot contract — 2026-09-24` section to `docs/verification.md` listing the gates that passed and the live checks run or not run, without claiming unobserved results.

```bash
git add docs/verification.md
git commit -m "docs: record pointer contract verification"
```

## Changes after review

Review found gaps that the code blocks above don't cover. Fixes don't map one commit per fix: a single commit below often bundles several fixes, and a few early fixes are cited by more than one commit. Each bullet cites the commit(s) that made it:

- `0aae2a0`: `screenPoint` maps `Math.floor(point.x) + 0.5` (and the same for y), so a fractional point in the last half-pixel stays inside the display. The same commit makes `captureSize` reject non-finite sizes instead of looping forever.
- `7dc5b1c`, `0525dc8`, `5eb8d54`: `approvedAction` calls `runHelper(() => exec(helper, args))` from `electron/helper-result.ts`. It reports the helper's own JSON error, or a cause built from the exit code or signal. It never reports Node's `Command failed: <path>` message, and it skips unreadable output lines so they can't mask the exit reason.
- `f494a92`, `c0288e2`: both `label` schemas refine the trimmed label to reject control, format, private-use and unassigned characters and line or paragraph separators (`/(?![\u200c\u200d])[\p{C}\p{Zl}\p{Zp}]/u`), while allowing ZWNJ and ZWJ. This means the approval prompt always shows one line. A refine is used instead of `.regex()` because the MCP tool schema would otherwise publish a pattern whose meaning changes without the `u` flag.
- `8b4fdbf`: the screenshot handler resizes whenever the measured PNG `exceeds` the target, for example a 2x thumbnail, and not only when it is over the Codex budget.
- The shipped README wording differs from the block Task 4 shows above, and the screen-capture-unavailable error was reworded from what that task's code block shows; both are expected, since this section reflects what actually shipped, not the numbered tasks above.
- Test counts have also grown well past the numbers stated when each task above was written (for example Task 1's "PASS, 7 tests"); trust the suite's current output, not those figures.

### Code review round 1

- `f2e23c8`: `userContent` builds chat content, and New conversation clears the attachment.
- `d4bc723`: frozen registry entries, limit validation, and PNG 0×0 rejection.
- `37c800e`: one helper runner that confirms the status line, times out, and names any error code.
- `efce5a7`: `resolvePoint` before and after approval, plus refusing clock-shifted captures.
- `ce44f82`: notes only for fresh captures whose PNG matches, plus the stale note.
- `2bc6b45`: shared `screenshotIdSchema`/`pointLabelSchema` with a visible-text rule, and `pointPrompt` puts the label in `detail`.
- `667e1ee`: hide covering OpenMuse windows during the ring.
- `c2450e2`: `fitThumbnail`, `sameBounds`, separate capture errors, and a re-check of the display after capture.
