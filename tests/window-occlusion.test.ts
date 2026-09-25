import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coversPoint,
  conceal,
  markTransparent,
  RING_MARGIN,
  type ConcealableWindow,
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

test("point one point beyond the left margin is not covered", () => {
  // Mirrors the right edge's exclusive-boundary check above, but for the
  // left edge, so a regression that widens the left margin gets caught too.
  assert.equal(
    coversPoint(workspaceBounds, {
      x: workspaceBounds.x - RING_MARGIN - 1,
      y: 500,
    }),
    false,
  );
});

test("point at exactly the margin past the bottom edge is not covered, the edge is exclusive", () => {
  // Coverage ends at the bottom edge plus the margin: a point exactly there
  // is already outside, matching the right edge's exclusive boundary above.
  const bottomEdge = workspaceBounds.y + workspaceBounds.height;
  assert.equal(
    coversPoint(workspaceBounds, { x: 500, y: bottomEdge + RING_MARGIN }),
    false,
  );
});

test("point one point inside the bottom margin is covered", () => {
  // Mirrors the right edge's inside-the-margin check above, but for the
  // bottom edge, so a regression that narrows the bottom margin gets caught.
  const bottomEdge = workspaceBounds.y + workspaceBounds.height;
  assert.equal(
    coversPoint(workspaceBounds, { x: 500, y: bottomEdge + RING_MARGIN - 1 }),
    true,
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

test("point one point above the top margin is not covered", () => {
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
// state and destruction exactly the way conceal() reads and writes them, plus
// a call count so a test can assert setIgnoreMouseEvents was never invoked
// rather than only inspecting its final value.
function fakeConcealable(startOpacity: number) {
  let opacity = startOpacity;
  let destroyed = false;
  let ignoringMouseEvents = false;
  let ignoreMouseEventsCalls = 0;
  return {
    isDestroyed: () => destroyed,
    getOpacity: () => opacity,
    setOpacity: (next: number) => {
      opacity = next;
    },
    setIgnoreMouseEvents: (ignore: boolean) => {
      ignoringMouseEvents = ignore;
      ignoreMouseEventsCalls += 1;
    },
    destroy: () => {
      destroyed = true;
    },
    opacity: () => opacity,
    isIgnoringMouseEvents: () => ignoringMouseEvents,
    ignoreMouseEventsCallCount: () => ignoreMouseEventsCalls,
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

test("two overlapping conceals of the same window: restoring the first leaves it concealed, restoring the second brings it back", () => {
  const a = fakeConcealable(0.9);
  const restoreFirst = conceal([a]);
  const restoreSecond = conceal([a]);
  restoreFirst();
  // The second fade still covers it.
  assert.equal(a.opacity(), 0);
  assert.equal(a.isIgnoringMouseEvents(), true);
  restoreSecond();
  assert.equal(a.opacity(), 0.9);
  assert.equal(a.isIgnoringMouseEvents(), false);
});

test("two overlapping conceals of the same window: restoring in the opposite order still only restores once the last one ends", () => {
  const a = fakeConcealable(0.9);
  const restoreFirst = conceal([a]);
  const restoreSecond = conceal([a]);
  restoreSecond();
  // The first fade still covers it.
  assert.equal(a.opacity(), 0);
  assert.equal(a.isIgnoringMouseEvents(), true);
  restoreFirst();
  assert.equal(a.opacity(), 0.9);
  assert.equal(a.isIgnoringMouseEvents(), false);
});

test("calling the same restore twice does not restore early while another overlapping fade is still active", () => {
  const a = fakeConcealable(0.9);
  const restoreFirst = conceal([a]);
  conceal([a]); // a second, overlapping fade whose own restore is never called here
  restoreFirst();
  restoreFirst(); // calling it again must not decrement a second time
  assert.equal(a.opacity(), 0);
  assert.equal(a.isIgnoringMouseEvents(), true);
});

test("a conceal over two windows, one already concealed elsewhere, only restores the window no longer covered by any fade", () => {
  const a = fakeConcealable(0.9);
  const b = fakeConcealable(0.7);
  const restoreOuter = conceal([a]); // a is already concealed by this outer call
  const restoreBoth = conceal([a, b]);
  restoreBoth();
  // a is still covered by restoreOuter's fade.
  assert.equal(a.opacity(), 0);
  assert.equal(a.isIgnoringMouseEvents(), true);
  // b had only this one fade, so it comes back.
  assert.equal(b.opacity(), 0.7);
  assert.equal(b.isIgnoringMouseEvents(), false);
  restoreOuter();
  assert.equal(a.opacity(), 0.9);
  assert.equal(a.isIgnoringMouseEvents(), false);
});

test("a marked window never gets setIgnoreMouseEvents on conceal or restore, but still fades to opacity 0 and back", () => {
  const a = fakeConcealable(1);
  markTransparent(a);
  const restore = conceal([a]);
  assert.equal(a.opacity(), 0);
  assert.equal(a.ignoreMouseEventsCallCount(), 0);
  restore();
  assert.equal(a.opacity(), 1);
  assert.equal(a.ignoreMouseEventsCallCount(), 0);
});

test("an unmarked window still fades and ignores mouse events even when concealed alongside a marked one", () => {
  const marked = fakeConcealable(1);
  const unmarked = fakeConcealable(0.8);
  markTransparent(marked);
  const restore = conceal([marked, unmarked]);
  assert.equal(unmarked.opacity(), 0);
  assert.equal(unmarked.isIgnoringMouseEvents(), true);
  assert.equal(marked.ignoreMouseEventsCallCount(), 0);
  restore();
  assert.equal(unmarked.opacity(), 0.8);
  assert.equal(unmarked.isIgnoringMouseEvents(), false);
  assert.equal(marked.ignoreMouseEventsCallCount(), 0);
});

test("if the second window's setOpacity throws during conceal, the first window is restored and the error propagates", () => {
  const a = fakeConcealable(1);
  const b: ConcealableWindow = {
    isDestroyed: () => false,
    getOpacity: () => 0.8,
    setOpacity: () => {
      throw new Error("setOpacity boom");
    },
    setIgnoreMouseEvents: () => {},
  };
  assert.throws(() => conceal([a, b]), /setOpacity boom/);
  assert.equal(a.opacity(), 1);
  assert.equal(a.isIgnoringMouseEvents(), false);
});

test("if one undo throws during restore, the other windows are still restored and the error is rethrown", () => {
  const a = fakeConcealable(1);
  const b: ConcealableWindow = {
    isDestroyed: () => false,
    getOpacity: () => 0.8,
    setOpacity: (next: number) => {
      // Succeeds while fading out (next is 0); fails while restoring.
      if (next !== 0) throw new Error("restore boom");
    },
    setIgnoreMouseEvents: () => {},
  };
  // b is concealed first, so its undo runs first and throws; a's undo must
  // still run afterwards rather than being skipped.
  const restore = conceal([b, a]);
  assert.throws(() => restore(), /restore boom/);
  assert.equal(a.opacity(), 1);
  assert.equal(a.isIgnoringMouseEvents(), false);
});

test("if setIgnoreMouseEvents throws after setOpacity(0) already landed, the window's opacity is put back and no fade is left behind", () => {
  let shouldThrow = true;
  let opacity = 1;
  let ignoringMouseEvents = false;
  const win: ConcealableWindow = {
    isDestroyed: () => false,
    getOpacity: () => opacity,
    setOpacity: (next: number) => {
      opacity = next;
    },
    setIgnoreMouseEvents: (ignore: boolean) => {
      if (shouldThrow) throw new Error("setIgnoreMouseEvents boom");
      ignoringMouseEvents = ignore;
    },
  };

  assert.throws(() => conceal([win]), /setIgnoreMouseEvents boom/);
  // setOpacity(0) already succeeded before setIgnoreMouseEvents threw; the
  // window must be left exactly as fadeOut found it, not stuck invisible.
  assert.equal(opacity, 1);

  // A later conceal on the very same window, now with a working fake, must
  // behave like a brand new fade rather than a nested one: if the earlier
  // failure had left a stale fade entry, or had recorded 0 (the stuck
  // opacity) as the "original" to restore to, this would fail to fade, or
  // would restore to 0 instead of 1.
  shouldThrow = false;
  const restore = conceal([win]);
  assert.equal(opacity, 0);
  assert.equal(ignoringMouseEvents, true);
  restore();
  assert.equal(opacity, 1);
  assert.equal(ignoringMouseEvents, false);
});

test("if the second window's setIgnoreMouseEvents throws during conceal, both windows end restored and the error propagates", () => {
  const a = fakeConcealable(1);
  let bOpacity = 0.8;
  const b: ConcealableWindow = {
    isDestroyed: () => false,
    getOpacity: () => bOpacity,
    setOpacity: (next: number) => {
      bOpacity = next;
    },
    setIgnoreMouseEvents: () => {
      throw new Error("setIgnoreMouseEvents boom");
    },
  };
  assert.throws(() => conceal([a, b]), /setIgnoreMouseEvents boom/);
  // a fully faded and was then undone by conceal()'s own cleanup.
  assert.equal(a.opacity(), 1);
  assert.equal(a.isIgnoringMouseEvents(), false);
  // b's own fadeOut call must have put its opacity back before rethrowing.
  assert.equal(bOpacity, 0.8);
});

test("a failing restore still un-ignores mouse events, and a later successful cycle restores the TRUE original opacity, not the stuck 0", () => {
  let opacity = 0.85;
  let ignoring = false;
  let failRestore = true;
  const win: ConcealableWindow = {
    isDestroyed: () => false,
    getOpacity: () => opacity,
    setOpacity: (next: number) => {
      if (next !== 0 && failRestore) throw new Error("restore boom");
      opacity = next;
    },
    setIgnoreMouseEvents: (ignore: boolean) => {
      ignoring = ignore;
    },
  };

  const restore = conceal([win]);
  assert.equal(opacity, 0);
  assert.equal(ignoring, true);

  // The opacity restore fails, but the window must not stay click-through
  // forever because of it: setIgnoreMouseEvents(false) still runs even
  // though setOpacity threw.
  assert.throws(() => restore(), /restore boom/);
  assert.equal(opacity, 0);
  assert.equal(ignoring, false);

  // A fresh cycle must still restore to 0.85, the window's true original
  // opacity from before it was ever faded. The old bug deleted the fade
  // entry before attempting the restore, so a failure here would have left
  // fadeOut() reading back the stuck opacity (0) on the next cycle and
  // recording that as "original" instead.
  failRestore = false;
  const restoreAgain = conceal([win]);
  restoreAgain();
  assert.equal(opacity, 0.85);
});

test("conceal() after a failed restore re-fades the window instead of just bumping the stale count", () => {
  let opacity = 0.85;
  let ignoring = false;
  let failRestore = true;
  const win: ConcealableWindow = {
    isDestroyed: () => false,
    getOpacity: () => opacity,
    setOpacity: (next: number) => {
      if (next !== 0 && failRestore) throw new Error("restore boom");
      opacity = next;
    },
    setIgnoreMouseEvents: (ignore: boolean) => {
      ignoring = ignore;
    },
  };

  const restore = conceal([win]);
  assert.throws(() => restore(), /restore boom/);
  // The retry state left behind by the failed restore: still invisible, but
  // no longer ignoring mouse events, so it would catch clicks if left here.
  assert.equal(opacity, 0);
  assert.equal(ignoring, false);

  // A fresh conceal() on this window must re-apply the fade -- not just
  // increment a stale count -- so it goes back to ignoring mouse events
  // (it's unmarked) instead of staying invisible and clickable.
  const restoreAgain = conceal([win]);
  assert.equal(opacity, 0);
  assert.equal(ignoring, true);

  // A successful restore from there returns the TRUE original opacity, not
  // the stuck 0, with ignore back to false.
  failRestore = false;
  restoreAgain();
  assert.equal(opacity, 0.85);
  assert.equal(ignoring, false);
});

test("marking a window transparent while it is still faded does not stop restore from un-ignoring it", () => {
  const win = fakeConcealable(1);
  const restore = conceal([win]);
  assert.equal(win.opacity(), 0);
  assert.equal(win.isIgnoringMouseEvents(), true);

  // Marked only now, while still concealed -- for example, main.ts calling
  // markTransparent() on a window it just created, after conceal() had
  // already started fading it. Restore must undo what fadeOut actually did
  // (it did call setIgnoreMouseEvents(true)), not re-check
  // transparentWindows' membership as of restore time.
  markTransparent(win);

  restore();
  assert.equal(win.opacity(), 1);
  assert.equal(win.isIgnoringMouseEvents(), false);
});
