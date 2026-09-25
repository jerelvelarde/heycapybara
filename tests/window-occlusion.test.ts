import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coversPoint,
  conceal,
  RING_MARGIN,
} from "../electron/window-occlusion";

const workspaceBounds = { x: 100, y: 100, width: 1240, height: 820 };

test("point inside the window is covered", () => {
  assert.equal(coversPoint(workspaceBounds, { x: 500, y: 500 }), true);
});

test("point outside the window but within the ring margin of the right edge is covered", () => {
  // The right edge is at 100 + 1240 = 1340; anything up to RING_MARGIN past
  // it is still covered.
  const rightEdge = workspaceBounds.x + workspaceBounds.width;
  assert.equal(
    coversPoint(workspaceBounds, { x: rightEdge + RING_MARGIN - 1, y: 500 }),
    true,
  );
});

test("point at exactly the margin past the right edge is not covered, the edge is exclusive", () => {
  const rightEdge = workspaceBounds.x + workspaceBounds.width;
  assert.equal(
    coversPoint(workspaceBounds, { x: rightEdge + RING_MARGIN, y: 500 }),
    false,
  );
});

test("point at exactly the margin before the left edge is covered, the edge is inclusive", () => {
  assert.equal(
    coversPoint(workspaceBounds, {
      x: workspaceBounds.x - RING_MARGIN,
      y: 500,
    }),
    true,
  );
});

test("point at exactly the margin past the bottom edge is not covered, the edge is exclusive", () => {
  // The bottom edge is at 100 + 820 = 920, not 952: 952 is the bottom edge
  // plus the margin (920 + RING_MARGIN), which is where coverage ends.
  const bottomEdge = workspaceBounds.y + workspaceBounds.height;
  assert.equal(
    coversPoint(workspaceBounds, { x: 500, y: bottomEdge + RING_MARGIN }),
    false,
  );
});

test("point at exactly the margin before the top edge is covered, the edge is inclusive", () => {
  assert.equal(
    coversPoint(workspaceBounds, {
      x: 500,
      y: workspaceBounds.y - RING_MARGIN,
    }),
    true,
  );
});

test("point one pixel above the top margin is not covered", () => {
  assert.equal(
    coversPoint(workspaceBounds, {
      x: 500,
      y: workspaceBounds.y - RING_MARGIN - 1,
    }),
    false,
  );
});

test("a point far away from the window is not covered", () => {
  assert.equal(coversPoint(workspaceBounds, { x: 5000, y: 5000 }), false);
});

test("a window at negative coordinates still covers points near it", () => {
  const bounds = { x: -1920, y: 0, width: 800, height: 600 };
  assert.equal(coversPoint(bounds, { x: -1500, y: 300 }), true);
});

// A minimal stand-in for a BrowserWindow: tracks opacity, ignored-mouse-event
// state and destruction exactly the way conceal() reads and writes them.
function fakeConcealable(startOpacity: number) {
  let opacity = startOpacity;
  let destroyed = false;
  let ignoringMouseEvents = false;
  return {
    isDestroyed: () => destroyed,
    getOpacity: () => opacity,
    setOpacity: (next: number) => {
      opacity = next;
    },
    setIgnoreMouseEvents: (ignore: boolean) => {
      ignoringMouseEvents = ignore;
    },
    destroy: () => {
      destroyed = true;
    },
    opacity: () => opacity,
    isIgnoringMouseEvents: () => ignoringMouseEvents,
  };
}

test("conceal sets every window's opacity to 0 and makes it ignore mouse events", () => {
  const a = fakeConcealable(1);
  const b = fakeConcealable(0.8);
  conceal([a, b]);
  assert.equal(a.opacity(), 0);
  assert.equal(a.isIgnoringMouseEvents(), true);
  assert.equal(b.opacity(), 0);
  assert.equal(b.isIgnoringMouseEvents(), true);
});

test("conceal's restore puts back each window's previous opacity and stops ignoring mouse events", () => {
  const a = fakeConcealable(1);
  const b = fakeConcealable(0.8);
  const restore = conceal([a, b]);
  restore();
  assert.equal(a.opacity(), 1);
  assert.equal(a.isIgnoringMouseEvents(), false);
  assert.equal(b.opacity(), 0.8);
  assert.equal(b.isIgnoringMouseEvents(), false);
});

test("conceal's restore skips a window destroyed in the meantime, without throwing", () => {
  const a = fakeConcealable(1);
  const restore = conceal([a]);
  a.destroy();
  assert.doesNotThrow(() => restore());
  // The destroyed window's opacity is left untouched: still concealed.
  assert.equal(a.opacity(), 0);
});
