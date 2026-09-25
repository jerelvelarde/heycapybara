# Point Where the Model Looked Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the agent points at something it saw in an attached screenshot, the pointer lands on that thing.

**Architecture:** The main process sizes every capture so Codex passes it through unchanged. It measures the PNG it actually produced and registers the capture's display geometry under a random ID. The Codex adapter adds a note for each image, naming it by position (the Codex SDK joins text parts into one prompt and passes images separately, in order) and giving its screenshot ID and pixel size. `point_on_screen` takes that ID plus x, y in image pixels. The main process converts the point to global screen points and hands it to the existing Swift `--point` command.

**Tech Stack:** Electron 44, TypeScript 6, zod 4, `@openai/codex-sdk` 0.156.1, MCP SDK, Node test runner via `tsx --test`.

**Spec:** `docs/superpowers/specs/2026-09-24-clicky-learnings-design.md` (section 1)

**As shipped:** the task steps and code blocks below show the plan as written. The shipped code differs where [Changes after review](#changes-after-review) says so.

## Global Constraints

- Run every command from the repository root.
- No new dependencies.
- Codex pass-through limits (codex-rs `PromptImageMode::HIGH_DETAIL`, v0.156.1): longest side ≤ 2048 px, and `ceil(w/32) * ceil(h/32)` ≤ 2500. Captures are capped at 1920 px on the longest side and never upscaled.
- Screenshot IDs match `^shot_[0-9a-f]{8}$`. The registry keeps the 16 most recent captures, and a capture expires after 10 minutes.
- A point's label is 1 to 60 characters after trimming.
- Keep the `kite:` IPC names, the sender checks, and zod validation. No test-only code paths in production code; some constants are exported so tests read the real values.
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
2. Ask the agent to point at something far from the display's top-left corner, such as a Dock icon at the bottom-right or the menu-bar clock at the top-right. A scale error grows with the distance from that corner, so a target near it, such as the Apple menu, would hide one.
3. Confirm OpenMuse comes to the front and the approval appears as a sheet on the companion chat if it is open, or otherwise on the workspace, which is shown first if it was hidden. Its message reads `The agent wants to show a pointer on <display>`, its detail reads `The agent says it points at: <label>` with the label the agent chose, and Cancel is the default button.
4. Press Escape, and confirm the sheet closes and no ring appears.
5. Ask again, choose "Allow once", and confirm the red ring lands on the target.
6. The built-in 1512×982 display is captured 1:1, which doesn't exercise the scaling. If an external display wider than 1920 points is available, for example one set to 2560×1440, make it the main display and repeat steps 1 to 5 there, because its capture is scaled.

Without a key or permission, write down exactly which step could not run.

- [ ] **Step 3: Record the results and commit**

Add a `## Pointer screenshot contract — 2026-09-24` section to `docs/verification.md` listing the gates that passed and the live checks run or not run, without claiming unobserved results.

```bash
git add docs/verification.md
git commit -m "docs: record pointer contract verification"
```

## Changes after review

The shipped code differs from the tasks above in the ways listed here, and the shipped README text differs from Task 4's block. Section 1 of the spec describes the shipped contract in full.

**Capture**

- The screenshot handler makes the visible workspace, pet, notch and companion chat windows transparent with `conceal()` from `electron/window-occlusion.ts` instead of hiding them: it sets each window's opacity to 0 at once, with no animation. Only the opaque workspace also ignores the mouse while concealed. The transparent pet, notch and companion chat windows change only their opacity, because calling `setIgnoreMouseEvents` on a transparent window even once loses AppKit's click-through of its clear pixels for good, and Electron never calls it when it creates the window.
- The `restore()` that `conceal()` returns runs in `finally`. Fades nest per window, so restoring puts back a window's opacity, and the workspace's mouse handling, only when the last overlapping fade on that window ends, whether that fade came from a capture or from the pointer. It skips a window destroyed in the meantime. A failure while fading undoes the fades already made, a failure while restoring still restores the other windows, and either way the error is rethrown. A sheet is a separate window and isn't faded, which is a known limitation.
- `desktopCapturer.getSources` gets 10 s to answer. After that the capture fails with "Screen capture didn't respond. Try again, or quit and reopen OpenMuse Desktop.", and the windows are restored.
- `fitThumbnail` measures the PNG and resizes it whenever it exceeds the target, for example a 2x thumbnail, not only when it is over the Codex budget. The handler rebuilds the image from its own PNG pixels before resizing, because a 2x `NativeImage` keeps its scale factor through `resize()`. An image still over the budget is an error.
- A missing source and an empty thumbnail get separate errors instead of one "Screen capture unavailable". After the capture the display is read again, and a missing or changed display is an error.
- Concurrent capture calls share one in-flight capture, so a burst of clicks makes one capture and one registry entry.
- A display without a label is called "Main display".
- `captureSize` rejects a non-finite or non-positive size with an error naming it; Task 1's check let an infinite size loop forever. `pngSize` rejects a zero width or height.

**Registry**

- `Screenshot` is `Readonly`, and `add` freezes each entry and its bounds.
- The constructor rejects a limit that isn't a positive integer. `add` rejects dimensions that aren't whole, positive and within the Codex budget, and bounds whose origin isn't finite or whose size isn't finite and positive.
- The runner and the runtime take a `ScreenshotLookup`, which is `Pick<ScreenshotRegistry, "get">`. `screenshots` is a required key in both `startRuntime`'s options and `CodexRunnerOptions`, though its value may be `undefined`, so leaving the wiring out of either call fails the typecheck. Task 2 made it optional in both.
- The default limit is the exported `REGISTRY_LIMIT` (16). It, `MAX_AGE_MS` and `CAPTURE_MAX_DIMENSION` are exported so `tests/doc-contract.test.ts` can check the docs against them.

**Notes**

- The note is chosen in this order: no ID gives the unreferenced note; an ID that isn't registered, the unknown note; a PNG whose size differs from the registered size, the mismatched note; a capture that isn't fresh, the stale note; otherwise the describing note. Task 2 had only the describing and unreferenced notes.
- Each image problem fails the run with its own error naming the image number: not a PNG, no data, over 12 MB, or an invalid PNG. Task 2 kept one existing error for the first three and didn't check the PNG itself. The PNG check reads only the header, and the size in that header is the one that must match the registered size.
- The instructions also ask for a short label naming the target.
- A prompt rebuilt from history keeps the text of earlier messages, with `[image omitted]` in place of each image and `[attachment omitted]` in place of any other attachment (audio, video, a document, or a binary part that isn't an image), instead of replacing the whole message.

**Refusals**

- `resolvePoint` looks up the screenshot and its display, then calls `screenPoint`. It runs when the model asks and again after approval, so a display change, an expiry or an eviction by newer captures while the prompt is open is caught.
- An unknown ID's refusal names the ID and suggests checking it.
- `isFresh` accepts an age from 0 to 10 minutes. A negative age, meaning a capture time in the future, gets its own refusal, which `screenPoint` checks before the age. That catches only a clock that moved back to before the capture time; other clock shifts go unnoticed and only change the capture's apparent age.
- The point snaps to its pixel before taking the pixel's center (`Math.floor(point.x) + 0.5`, and the same for y), so a fractional point in the last pixel stays inside the display.
- The age refusal takes its number of minutes from `MAX_AGE_MS`.

**Label**

- `server/tools.ts` and `approvedAction` share `screenshotIdSchema` and `pointLabelSchema` from `server/point-schema.ts` instead of each defining its own.
- After trimming and the 1-to-60 length check, in which zod counts code points, the label must pass six refinements, in order, each with its own message: no `\p{C}`, `Zl` or `Zp` character except ZWNJ and ZWJ; no known blank character; no other default-ignorable character except ZWNJ, ZWJ, U+FE0E and U+FE0F; no run of two or more ZWNJ/ZWJ, and no three marks from the combining accent blocks on one letter, even with other marks or joiners between them; no two spaces with only marks or joiners between them; at least one letter or number. Marks outside the accent blocks aren't limited, so real words in scripts such as Hindi, Tibetan and pointed Hebrew pass. They are refinements rather than `.regex()` because a published JSON Schema pattern has no `u` flag.
- x and y are plain `z.number()`, which in zod 4 already rejects infinite numbers and NaN.
- The label's tool description says the user sees it in the approval dialog, as one line of visible text of up to 60 characters with at least one letter or number.

**Approval**

- `askApproval` in `electron/approval.ts` activates OpenMuse with `app.focus({ steal: true })` and bounces its Dock icon until it is active. `approve` in `electron/main.ts` then shows the prompt as a sheet on a visible OpenMuse window: `approvalHost` picks the companion chat if it is visible, and otherwise the workspace, which is shown first if it is hidden. Task 3 always attached it to the workspace. A parentless message box on macOS runs synchronously and would block the main process, with the runtime server, MCP, IPC and timers, so one is used only if the chosen host is somehow still hidden.
- The title, the buttons, and Cancel as both the default and the cancel button are as in Task 3, so Escape declines and Return does nothing; Return never allows.
- macOS doesn't show the title, so each message says who is asking. For a point, the message is `The agent wants to show a pointer on <display>`, and the model's label goes in the detail, `The agent says it points at: <label>`, built by `pointPrompt`. Task 3 put the label in the message itself. To open an app, the message is `The agent wants to open <bundle id>` instead of Task 3's `Open application <bundle id>`.

**Pointer and windows**

- `performPointAction` in `electron/point-action.ts` runs the steps in order: resolve, prompt, confirm (a decline fails with "User declined action"), and resolve again. It then conceals each visible OpenMuse window whose bounds, grown by `RING_MARGIN` (32 pt: half the helper's 48 pt ring panel plus 8 pt of slack), contain the point, runs `--point`, and restores those windows in `finally`. The ring itself reaches about 21 pt from the point: `native/Recorder.swift` insets its oval 5 pt inside the panel and strokes it 4 pt wide. The helper draws the ring at screen-saver level, above our windows, so only the target needs clearing. Task 3 left covering windows alone.
- The pointer's conceal nests with a capture's, so a window covered by both comes back only when both have ended.

**Helper**

- Every `exec(helper` call in `electron/main.ts`, not only the two actions, goes through `runHelper` in `electron/helper-result.ts`, and `tests/helper-result.test.ts` scans `main.ts` to enforce it. `runHelper` reports the helper's own error line, skipping unreadable lines, or else names the cause of the failure, instead of Node's `Command failed` message, which holds the helper's path, arguments and stderr.
- The rarer spawn failures that Node reports synchronously, with no output attached, are named too.
- The error `runHelper` throws keeps no `cause`, because Electron logs a failed IPC handler together with its cause, which would print the helper's path, arguments and stderr again.
- Only `--point` and `--open-app` must also confirm success with a status line: "Point displayed" and "Application opened". The strings live in `helperStatus` in `electron/helper-result.ts`, which `electron/main.ts` uses, and `tests/helper-result.test.ts` checks them against the Swift helper's status events.
- Calls time out after 15 s, except `--open-app` at 60 s, because a first launch can wait on Gatekeeper.

**Composer**

- `userContent` in `src/message-content.ts` builds the message content and rejects an attachment that isn't a PNG data URL; the composer then shows the error and drops the attachment.
- The ID survives because `KiteCodexAgent` reports AG-UI 0.0.59; the 0.0.47 compatibility middleware would drop it. `tests/message-content.test.ts` (`RunAgentInputSchema`) and `tests/codex.test.ts` (a real `KiteCodexAgent.runAgent` round trip) pin this.
- A new conversation clears the attachment, and fresh requests don't send it.
- A capture that finishes after a message is sent or a new conversation starts is dropped, and so is its error.
- `ipcErrorMessage` in `src/message-content.ts` strips the `Error invoking remote method 'kite:screenshot': Error:` prefix that Electron adds, so a capture error reads as the main process wrote it.
- The footer reads "Screenshots shared when sent".
