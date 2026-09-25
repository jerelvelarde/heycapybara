import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ScreenshotRegistry,
  captureSize,
  describeScreenshot,
  describeToolScreenshot,
  exceeds,
  fitsPromptBudget,
  fitThumbnail,
  isFresh,
  pngSize,
  resolvePoint,
  sameBounds,
  screenPoint,
  unreferencedImageNote,
  type Rect,
  type Screenshot,
  type ScreenshotLookup,
  type Size,
  type Thumbnail,
} from "../server/screenshots";
import { pngHeader } from "./png-fixture";

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

// A fake Electron NativeImage thumbnail. `resizeResult` lets a test force
// what the resized image reports back, independent of the size requested.
function fakeThumbnail(initial: Size, resizeResult?: Size) {
  const resizeCalls: Size[] = [];
  const thumbnail: Thumbnail = {
    toPNG: () => Buffer.from(pngHeader(initial.width, initial.height)),
    resize: (size: Size) => {
      resizeCalls.push(size);
      const result = resizeResult ?? size;
      return {
        toPNG: () => Buffer.from(pngHeader(result.width, result.height)),
      };
    },
  };
  return { thumbnail, resizeCalls };
}

test("enforces the image limits copied from Codex 0.156.1", () => {
  assert.equal(fitsPromptBudget({ width: 1920, height: 1200 }), true);
  assert.equal(fitsPromptBudget({ width: 1600, height: 1600 }), true);
  assert.equal(fitsPromptBudget({ width: 1601, height: 1600 }), false);
  assert.equal(fitsPromptBudget({ width: 2049, height: 100 }), false);
  assert.equal(fitsPromptBudget({ width: 2048, height: 1280 }), false);
  assert.equal(fitsPromptBudget({ width: 100, height: 2049 }), false);
  // At the MAX_DIMENSION edge (2048) with a low enough patch count.
  assert.equal(fitsPromptBudget({ width: 2048, height: 32 }), true);
});

test("captures keep the display's shape within the copied Codex limits", () => {
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
  assert.throws(
    () => captureSize({ width: Number.POSITIVE_INFINITY, height: 900 }),
    /display size/,
  );
});

test("captureSize is pinned for a 2048×1536 display", () => {
  // Locks the exact shrink-loop result so a change to any of the four values
  // it depends on -- CAPTURE_MAX_DIMENSION, MAX_PATCHES, PATCH_SIZE, or the
  // 0.98 per-iteration shrink step -- is caught here instead of surfacing as
  // a subtly mis-sized capture. Recompute this if one of them changes on
  // purpose.
  assert.deepEqual(captureSize({ width: 2048, height: 1536 }), {
    width: 1807,
    height: 1355,
  });
});

test("captureSize's error names the invalid size", () => {
  assert.throws(() => captureSize({ width: 0, height: 900 }), /0×900/);
});

test("a capture larger than its target is detected in either dimension", () => {
  assert.equal(
    exceeds({ width: 1512, height: 982 }, { width: 1512, height: 982 }),
    false,
  );
  assert.equal(
    exceeds({ width: 3024, height: 1964 }, { width: 1512, height: 982 }),
    true,
  );
  assert.equal(
    exceeds({ width: 1512, height: 983 }, { width: 1512, height: 982 }),
    true,
  );
  assert.equal(
    exceeds({ width: 1513, height: 900 }, { width: 1512, height: 982 }),
    true,
  );
  assert.equal(
    exceeds({ width: 1000, height: 600 }, { width: 1512, height: 982 }),
    false,
  );
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
  assert.throws(() => pngSize(pngHeader(0, 5)), /not a PNG/);
  const badChunkType = pngHeader(10, 10);
  badChunkType.set([0x49, 0x48, 0x44, 0x58], 12); // "IHDX"
  assert.throws(() => pngSize(badChunkType), /not a PNG/);
  assert.throws(() => pngSize(pngHeader(10, 10).subarray(0, 23)), /not a PNG/);
});

test("fitThumbnail leaves an already-fitting thumbnail alone", () => {
  const { thumbnail, resizeCalls } = fakeThumbnail({
    width: 1512,
    height: 982,
  });
  const result = fitThumbnail(thumbnail, { width: 1512, height: 982 });
  assert.equal(resizeCalls.length, 0);
  assert.deepEqual(result.size, { width: 1512, height: 982 });
});

test("fitThumbnail resizes a 2x thumbnail down to the target exactly once", () => {
  const { thumbnail, resizeCalls } = fakeThumbnail({
    width: 3024,
    height: 1964,
  });
  const result = fitThumbnail(thumbnail, { width: 1512, height: 982 });
  assert.equal(resizeCalls.length, 1);
  assert.deepEqual(resizeCalls[0], { width: 1512, height: 982 });
  assert.deepEqual(result.size, { width: 1512, height: 982 });
});

test("fitThumbnail throws when the resized image is still too large for the model", () => {
  const { thumbnail } = fakeThumbnail(
    { width: 3024, height: 1964 },
    { width: 4000, height: 4000 },
  );
  assert.throws(
    () => fitThumbnail(thumbnail, { width: 1512, height: 982 }),
    /too large for the model/,
  );
});

test("fitThumbnail reports the resized image's measured size, not the requested target", () => {
  const { thumbnail, resizeCalls } = fakeThumbnail(
    { width: 3024, height: 1964 },
    { width: 1511, height: 982 },
  );
  const result = fitThumbnail(thumbnail, { width: 1512, height: 982 });
  assert.equal(resizeCalls.length, 1);
  assert.deepEqual(resizeCalls[0], { width: 1512, height: 982 });
  assert.deepEqual(result.size, { width: 1511, height: 982 });
});

test("the registry issues random ids and keeps only recent captures", () => {
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
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.bounds));
  bounds.x = 500;
  const stored = registry.get(first.id);
  assert.equal(stored?.bounds.x, 0);
  assert.ok(stored && Object.isFrozen(stored));
  assert.ok(stored && Object.isFrozen(stored.bounds));
  registry.add(input);
  assert.equal(registry.get(first.id), undefined);
  assert.ok(registry.get(second.id));
  assert.equal(registry.get("shot_missing"), undefined);
});

test("the registry keeps the documented default of 16 captures", () => {
  const registry = new ScreenshotRegistry();
  const input = {
    displayId: "1",
    label: "Built-in Retina Display",
    bounds: { ...display },
    width: 1386,
    height: 900,
  };
  const captures = Array.from({ length: 17 }, () => registry.add(input));
  assert.equal(registry.get(captures[0].id), undefined);
  assert.ok(registry.get(captures[1].id));
});

test("the registry requires a positive integer limit", () => {
  assert.throws(() => new ScreenshotRegistry(0), /at least one capture/);
  assert.throws(() => new ScreenshotRegistry(1.5), /at least one capture/);
});

test("the registry validates screenshot dimensions before storing them", () => {
  const registry = new ScreenshotRegistry(16, () => 1_000_000);
  const validInput = {
    displayId: "1",
    label: "Built-in Retina Display",
    bounds: { ...display },
    width: 1386,
    height: 900,
  };
  // assert.throws tests a RegExp against String(error) ("Error: <message>"),
  // so the pattern is anchored only at the end.
  const invalidReason =
    /A screen capture needs whole-pixel positive dimensions within the model's image budget$/;
  for (const bad of [
    { ...validInput, width: 1.5 },
    { ...validInput, width: 0 },
    { ...validInput, width: -5 },
    { ...validInput, width: Number.NaN },
    { ...validInput, height: 1.5 },
    { ...validInput, height: 0 },
    { ...validInput, width: 99999, height: 99999 },
    { ...validInput, bounds: { ...validInput.bounds, width: 0 } },
    { ...validInput, bounds: { ...validInput.bounds, height: 0 } },
    { ...validInput, bounds: { ...validInput.bounds, x: Number.NaN } },
    {
      ...validInput,
      bounds: { ...validInput.bounds, y: Number.POSITIVE_INFINITY },
    },
  ])
    assert.throws(() => registry.add(bad), invalidReason, JSON.stringify(bad));
  assert.ok(registry.add(validInput));
});

test("sameBounds compares all four fields", () => {
  const bounds = { x: 0, y: 0, width: 1512, height: 982 };
  assert.equal(sameBounds(bounds, { ...bounds }), true);
  assert.equal(sameBounds(bounds, { ...bounds, x: 100 }), false);
  assert.equal(sameBounds(bounds, { ...bounds, y: -50 }), false);
  assert.equal(sameBounds(bounds, { ...bounds, width: 1800 }), false);
  assert.equal(sameBounds(bounds, { ...bounds, height: 1000 }), false);
});

test("image pixels map to the centre of the screen area they cover, and fractional points snap to their pixel", () => {
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
  const edge = screenPoint(shot, { x: 1385.9, y: 899.9 }, display, 1_000_000);
  assert.deepEqual(
    edge,
    screenPoint(shot, { x: 1385, y: 899 }, display, 1_000_000),
  );
  assert.ok(edge.x < 1512);
  assert.ok(edge.y < 982);
});

test("pointing refuses stale, moved, missing or out-of-range screenshots", () => {
  const now = 1_000_000;
  assert.throws(
    () => screenPoint(shot, { x: 1, y: 1 }, display, now + 10 * 60 * 1000 + 1),
    /more than 10 minutes old/,
  );
  assert.throws(
    () => screenPoint(shot, { x: 1, y: 1 }, display, now - 1),
    /clock changed/,
  );
  assert.throws(
    () => screenPoint(shot, { x: 1, y: 1 }, undefined, now),
    /no longer connected/,
  );
  for (const moved of [
    { ...display, width: 1800 },
    { ...display, x: 100 },
    { ...display, y: -50 },
    { ...display, height: 1000 },
  ])
    assert.throws(
      () => screenPoint(shot, { x: 1, y: 1 }, moved, now),
      /changed position or resolution/,
    );
  for (const point of [
    { x: 1386, y: 1 },
    { x: -1, y: 1 },
    { x: 1, y: 900 },
    { x: Number.NaN, y: 1 },
  ])
    assert.throws(() => screenPoint(shot, point, display, now), /outside/);
});

test("pointing succeeds exactly at the 10 minute boundary", () => {
  const atLimit = screenPoint(
    shot,
    { x: 1, y: 1 },
    display,
    1_000_000 + 10 * 60 * 1000,
  );
  assert.deepEqual(
    atLimit,
    screenPoint(shot, { x: 1, y: 1 }, display, 1_000_000),
  );
});

test("isFresh treats exactly 10 minutes as fresh and a clock rewind as stale", () => {
  assert.equal(isFresh(shot, shot.capturedAt), true);
  assert.equal(isFresh(shot, shot.capturedAt + 10 * 60 * 1000), true);
  assert.equal(isFresh(shot, shot.capturedAt + 10 * 60 * 1000 + 1), false);
  assert.equal(isFresh(shot, shot.capturedAt - 1), false);
});

test("resolvePoint looks up the screenshot and its live display before pointing", () => {
  const registry = new ScreenshotRegistry(16, () => 1_000_000);
  const bounds = { x: 0, y: 0, width: 1512, height: 982 };
  const stored = registry.add({
    displayId: "7",
    label: "Built-in Retina Display",
    bounds,
    width: 1386,
    height: 900,
  });
  const request = { screenshotId: stored.id, x: 692, y: 449 };
  assert.throws(
    () =>
      resolvePoint(
        registry,
        [{ id: 7, bounds }],
        { ...request, screenshotId: "shot_missing" },
        1_000_000,
      ),
    /No screenshot shot_missing is available; it may have been replaced by newer captures or the app restarted\. Check the id, or ask the user to attach a new screenshot\.$/,
  );
  const resolved = resolvePoint(
    registry,
    [{ id: 7, bounds }],
    request,
    1_000_000,
  );
  assert.equal(resolved.shot, stored);
  assert.deepEqual(
    resolved.point,
    screenPoint(stored, request, bounds, 1_000_000),
  );
  assert.throws(
    () => resolvePoint(registry, [{ id: 8, bounds }], request, 1_000_000),
    /no longer connected/,
  );
  assert.throws(
    () =>
      resolvePoint(
        registry,
        [{ id: 7, bounds: { ...bounds, x: 50 } }],
        request,
        1_000_000,
      ),
    /changed position or resolution/,
  );
});

// One state table drives both resolvePoint and screenPoint so every cause of
// refusal keeps a distinct, exact message: a regression here should fail on
// the specific cause, not just on "some error was thrown". Each `expect`
// regex is anchored only at `$`: assert.throws matches against
// String(error), which Node prepends with "Error: ".
test("resolvePoint and screenPoint name each refusal cause precisely", () => {
  const now = shot.capturedAt;
  const lookup: ScreenshotLookup = {
    get: (id) => (id === shot.id ? shot : undefined),
  };
  const basePoint = { x: 692, y: 449 };

  const states: {
    name: string;
    now?: number;
    current?: Rect;
    point?: { x: number; y: number };
    screenshotId?: string;
    resolvePointOnly?: boolean;
    expect: RegExp | "success";
  }[] = [
    { name: "fresh", expect: "success" },
    {
      name: "stale by age",
      now: now + 10 * 60 * 1000 + 1,
      expect:
        /That screenshot is more than 10 minutes old\. Ask the user to attach a new one\.$/,
    },
    {
      name: "negative age",
      now: now - 1,
      expect:
        /That screenshot's capture time is in the future, so the clock changed since it was taken\. Ask the user to attach a new one\.$/,
    },
    {
      name: "unknown id",
      screenshotId: "shot_missing",
      resolvePointOnly: true,
      expect:
        /No screenshot shot_missing is available; it may have been replaced by newer captures or the app restarted\. Check the id, or ask the user to attach a new screenshot\.$/,
    },
    {
      name: "display gone",
      current: undefined,
      expect:
        /Built-in Retina Display is no longer connected\. Ask the user to attach a new screenshot\.$/,
    },
    {
      name: "display moved on x",
      current: { ...display, x: display.x + 100 },
      expect:
        /Built-in Retina Display changed position or resolution since the screenshot\. Ask the user to attach a new one\.$/,
    },
    {
      name: "display moved on y",
      current: { ...display, y: display.y - 50 },
      expect:
        /Built-in Retina Display changed position or resolution since the screenshot\. Ask the user to attach a new one\.$/,
    },
    {
      name: "resized height",
      current: { ...display, height: display.height + 1 },
      expect:
        /Built-in Retina Display changed position or resolution since the screenshot\. Ask the user to attach a new one\.$/,
    },
    {
      name: "point outside",
      point: { x: -1, y: 449 },
      expect: /\(-1, 449\) is outside the 1386×900 screenshot\.$/,
    },
    {
      // Freshness is checked before the display's presence, so a capture
      // that is both stale and missing its display reports staleness, not
      // "no longer connected".
      name: "stale and display gone (staleness is checked first)",
      now: now + 10 * 60 * 1000 + 1,
      current: undefined,
      expect:
        /That screenshot is more than 10 minutes old\. Ask the user to attach a new one\.$/,
    },
  ];

  for (const state of states) {
    const current = "current" in state ? state.current : display;
    const point = state.point ?? basePoint;
    const at = state.now ?? now;

    if (!state.resolvePointOnly) {
      const run = () => screenPoint(shot, point, current, at);
      if (state.expect === "success")
        assert.equal(Number.isFinite(run().x), true, state.name);
      else assert.throws(run, state.expect, state.name);
    }

    const displays = current ? [{ id: 1, bounds: current }] : [];
    const run = () =>
      resolvePoint(
        lookup,
        displays,
        { screenshotId: state.screenshotId ?? shot.id, ...point },
        at,
      );
    if (state.expect === "success")
      assert.equal(Number.isFinite(run().point.x), true, state.name);
    else assert.throws(run, state.expect, state.name);
  }
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

test("a screenshot returned by a tool is described with its id, display and pixel size", () => {
  const text = describeToolScreenshot(shot);
  assert.match(text, /^The image in this result is screenshot shot_0000000a/);
  assert.match(text, /Built-in Retina Display/);
  assert.match(text, new RegExp(`${shot.width}.${shot.height} pixels`));
  assert.match(text, /screenshotId "shot_0000000a"/);
  assert.match(text, /origin at the top-left/);
});

test("the pinned Codex SDK version matches what the image limits were checked against", async () => {
  const packageJsonPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "node_modules",
    "@openai",
    "codex-sdk",
    "package.json",
  );
  const pkg = JSON.parse(await readFile(packageJsonPath, "utf8"));
  assert.equal(
    pkg.version,
    "0.156.1",
    "Codex SDK changed: recheck the image limits in server/screenshots.ts",
  );
});
