import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coversPoint,
  conceal,
  isMarkedTransparent,
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

test("if the opacity rollback also fails after setIgnoreMouseEvents(true) throws, the window is left at 0 with a retry record instead of none, and a later clean cycle restores the TRUE original", () => {
  let opacity = 0.9;
  let ignoring = false;
  let failSetIgnore = true;
  let failRollback = true;
  const win: ConcealableWindow = {
    isDestroyed: () => false,
    getOpacity: () => opacity,
    setOpacity: (next: number) => {
      // The initial fade to 0 always succeeds, so setIgnoreMouseEvents(true)
      // is reached; only the rollback call (back to the original) can fail.
      if (next !== 0 && failRollback) throw new Error("rollback boom");
      opacity = next;
    },
    setIgnoreMouseEvents: (ignore: boolean) => {
      if (ignore && failSetIgnore) throw new Error("setIgnoreMouseEvents boom");
      ignoring = ignore;
    },
  };

  // Both setOpacity(0) and the setIgnoreMouseEvents(true) after it run; the
  // rollback fadeOut() then attempts also fails, so unlike the old bug, the
  // record must survive rather than being deleted with the window stuck at
  // opacity 0 and nothing on record of its true original.
  assert.throws(() => conceal([win]), /setIgnoreMouseEvents boom/);
  assert.equal(opacity, 0);
  assert.equal(ignoring, false);

  // A later, fully working cycle must still land on 0.9, not the stuck 0.
  failSetIgnore = false;
  failRollback = false;
  const restore = conceal([win]);
  assert.equal(opacity, 0);
  assert.equal(ignoring, true);
  restore();
  assert.equal(opacity, 0.9);
  assert.equal(ignoring, false);
});

test("a retry conceal whose own setOpacity(0) also fails puts the stale record back, preserving the TRUE original for a later clean cycle", () => {
  let opacity = 0.7;
  let ignoring = false;
  let failRestoreOpacity = false;
  let failFadeZero = false;
  const win: ConcealableWindow = {
    isDestroyed: () => false,
    getOpacity: () => opacity,
    setOpacity: (next: number) => {
      if (next === 0 && failFadeZero) throw new Error("fade boom");
      if (next !== 0 && failRestoreOpacity) throw new Error("restore boom");
      opacity = next;
    },
    setIgnoreMouseEvents: (ignore: boolean) => {
      ignoring = ignore;
    },
  };

  // First cycle: the fade succeeds, but the restore's opacity write fails.
  // Per undoFade, that leaves the window invisible and still click-through
  // (never un-ignored), with a count-0 record kept for retry.
  const restore = conceal([win]);
  assert.equal(opacity, 0);
  assert.equal(ignoring, true);
  failRestoreOpacity = true;
  assert.throws(() => restore(), /restore boom/);
  assert.equal(opacity, 0);
  assert.equal(ignoring, true);

  // Retry, but make even this attempt's own setOpacity(0) fail too. The
  // stale record (holding the TRUE original, 0.7) must be put back exactly
  // as it was, not deleted, or a later cycle would lose it for good.
  failFadeZero = true;
  assert.throws(() => conceal([win]), /fade boom/);
  assert.equal(opacity, 0);
  assert.equal(ignoring, true);

  // A fully clean cycle from here must still land on 0.7, not the stuck 0.
  failFadeZero = false;
  failRestoreOpacity = false;
  const restoreAgain = conceal([win]);
  assert.equal(opacity, 0);
  assert.equal(ignoring, true);
  restoreAgain();
  assert.equal(opacity, 0.7);
  assert.equal(ignoring, false);
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

test("a failing restore does not un-ignore the mouse -- invisible and click-through beats invisible and clickable -- and a later successful cycle restores the TRUE original opacity, not the stuck 0", () => {
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

  // The opacity restore fails, so setIgnoreMouseEvents(false) must never
  // run: un-ignoring a window that's stuck invisible would leave it invisible
  // AND clickable, worse than invisible and click-through.
  assert.throws(() => restore(), /restore boom/);
  assert.equal(opacity, 0);
  assert.equal(ignoring, true);

  // A fresh cycle must still restore to 0.85, the window's true original
  // opacity from before it was ever faded, not the stuck 0 a fadeOut() that
  // read the window's current opacity back would have recorded instead.
  failRestore = false;
  const restoreAgain = conceal([win]);
  restoreAgain();
  assert.equal(opacity, 0.85);
  assert.equal(ignoring, false);
});

test("if setIgnoreMouseEvents(false) fails after the opacity restore already succeeded, the window is visible but stuck ignoring clicks, and a later cycle retries the un-ignore", () => {
  let opacity = 0.6;
  let ignoring = false;
  let failUnignore = false;
  const win: ConcealableWindow = {
    isDestroyed: () => false,
    getOpacity: () => opacity,
    setOpacity: (next: number) => {
      opacity = next;
    },
    setIgnoreMouseEvents: (ignore: boolean) => {
      if (!ignore && failUnignore) throw new Error("unignore boom");
      ignoring = ignore;
    },
  };

  const restore = conceal([win]);
  assert.equal(opacity, 0);
  assert.equal(ignoring, true);

  failUnignore = true;
  assert.throws(() => restore(), /unignore boom/);
  // Opacity already landed -- the window is visible -- but the un-ignore
  // failed, so it's stuck catching clicks instead of not. The record
  // survives so a later cycle retries the un-ignore, rather than there being
  // no record left to catch it.
  assert.equal(opacity, 0.6);
  assert.equal(ignoring, true);

  failUnignore = false;
  const restoreAgain = conceal([win]);
  assert.equal(opacity, 0);
  restoreAgain();
  assert.equal(opacity, 0.6);
  assert.equal(ignoring, false);
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
  // The retry state left behind by the failed restore: still invisible, and
  // still ignoring the mouse -- click-through, not clickable, while stuck
  // invisible.
  assert.equal(opacity, 0);
  assert.equal(ignoring, true);

  // A fresh conceal() on this window must re-apply the fade -- not just
  // increment a stale count -- so a later successful restore can still bring
  // it all the way back.
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

  // Marked only now, while still concealed. This is hypothetical today --
  // every call site marks a window in the factory that creates it, before
  // conceal() ever sees it -- but if main.ts ever did call markTransparent()
  // on a window after conceal() had already started fading it, restore must
  // still undo what fadeOut actually did (it did call
  // setIgnoreMouseEvents(true)), not re-check transparentWindows'
  // membership as of restore time.
  markTransparent(win);

  restore();
  assert.equal(win.opacity(), 1);
  assert.equal(win.isIgnoringMouseEvents(), false);
});

test("isMarkedTransparent reports exactly the windows markTransparent was called on", () => {
  const marked: ConcealableWindow = {
    isDestroyed: () => false,
    getOpacity: () => 1,
    setOpacity: () => {},
    setIgnoreMouseEvents: () => {},
  };
  const unmarked: ConcealableWindow = { ...marked };
  markTransparent(marked);
  assert.equal(isMarkedTransparent(marked), true);
  assert.equal(isMarkedTransparent(unmarked), false);
});
