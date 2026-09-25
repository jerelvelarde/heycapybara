import { test } from "node:test";
import assert from "node:assert/strict";
import { coversPoint } from "../electron/window-occlusion";

const workspaceBounds = { x: 100, y: 100, width: 1240, height: 820 };

test("point inside the window is covered", () => {
  assert.equal(coversPoint(workspaceBounds, { x: 500, y: 500 }), true);
});

test("point outside the window but within the ring margin of the right edge is covered", () => {
  // The right edge is at 100 + 1240 = 1340, and 1340 + 32 = 1372, so 1360 is
  // outside the window but still within the margin.
  assert.equal(coversPoint(workspaceBounds, { x: 1360, y: 500 }), true);
});

test("point at exactly the margin past the right edge is not covered, the edge is exclusive", () => {
  assert.equal(coversPoint(workspaceBounds, { x: 1372, y: 500 }), false);
});

test("point at exactly the margin before the left edge is covered, the edge is inclusive", () => {
  assert.equal(coversPoint(workspaceBounds, { x: 100 - 32, y: 500 }), true);
});

test("point at exactly the margin past the bottom edge is not covered, the edge is exclusive", () => {
  // The bottom edge is at 100 + 820 + 32 = 952.
  assert.equal(coversPoint(workspaceBounds, { x: 500, y: 952 }), false);
});

test("a point far away from the window is not covered", () => {
  assert.equal(coversPoint(workspaceBounds, { x: 5000, y: 5000 }), false);
});

test("a window at negative coordinates still covers points near it", () => {
  const bounds = { x: -1920, y: 0, width: 800, height: 600 };
  assert.equal(coversPoint(bounds, { x: -1500, y: 300 }), true);
});
