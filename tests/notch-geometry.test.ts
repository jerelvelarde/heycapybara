import { test } from "node:test";
import assert from "node:assert/strict";
import { notchPosition } from "../electron/notch-geometry";

test("notch window centers in display bounds and clears the work area", () => {
  assert.deepEqual(
    notchPosition(
      {
        bounds: { x: 0, y: 0, width: 1512, height: 982 },
        workArea: { x: 0, y: 38, width: 1512, height: 944 },
      },
      12,
      { width: 360, height: 180 },
    ),
    { x: 576, y: 38 },
  );
});

test("larger safe top inset takes precedence over work area", () => {
  assert.deepEqual(
    notchPosition(
      {
        bounds: { x: -1512, y: -982, width: 1512, height: 982 },
        workArea: { x: -1512, y: -944, width: 1512, height: 944 },
      },
      45,
      { width: 360, height: 180 },
    ),
    { x: -936, y: -937 },
  );
});

test("display without top inset uses work area and preserves negative coordinates", () => {
  assert.deepEqual(
    notchPosition(
      {
        bounds: { x: -1920, y: -1080, width: 1920, height: 1080 },
        workArea: { x: -1920, y: -1056, width: 1920, height: 1056 },
      },
      0,
      { width: 400, height: 160 },
    ),
    { x: -1160, y: -1056 },
  );
});

test("oversized window starts at display edge and invalid insets fall back", () => {
  const display = {
    bounds: { x: 100, y: 50, width: 300, height: 300 },
    workArea: { x: 100, y: 80, width: 300, height: 270 },
  };
  assert.deepEqual(
    notchPosition(display, Number.NaN, { width: 400, height: 100 }),
    {
      x: 100,
      y: 80,
    },
  );
});
