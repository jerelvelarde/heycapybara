import { test } from "node:test";
import assert from "node:assert/strict";
import type { ApprovalPrompt } from "../electron/approval";
import {
  performPointAction,
  type PointActionDeps,
  type PointWindow,
} from "../electron/point-action";
import type { Rect } from "../server/screenshots";

// resolve() returns the registry's own screenshot object, so a capture that
// is still there is the same object on both resolves.
const shot = { label: "Display A" };
const CANCELLED = "The request was cancelled before the action ran.";

// Bounds and visibility are real inputs: coversPoint and conceal (both from
// window-occlusion) decide what counts as covering and do the actual
// concealing, exactly as in production. Concealment is observed through
// opacity, not visibility. A failure makes setOpacity throw on the way to 0
// (conceal) or back (restore), before the opacity changes.
function fakeWindow(
  bounds: Rect,
  visible: boolean,
  events: string[],
  name: string,
  state: { destroyed: boolean; opacity: number } = {
    destroyed: false,
    opacity: 1,
  },
  failures: { conceal?: Error; restore?: Error } = {},
): PointWindow {
  return {
    isVisible: () => visible,
    getBounds: () => bounds,
    isDestroyed: () => state.destroyed,
    getOpacity: () => state.opacity,
    setOpacity: (next: number) => {
      const failure = next === 0 ? failures.conceal : failures.restore;
      if (failure) throw failure;
      state.opacity = next;
      events.push(`${next === 0 ? "conceal" : "restore"}:${name}`);
    },
    setIgnoreMouseEvents: () => {},
  };
}

test("happy path: resolve, confirm, resolve, conceal, showPointer, restore run in order for every covering window", async () => {
  const events: string[] = [];
  // The two resolves return different points so a bug that shows the
  // pre-approval point, instead of re-resolving after confirm, can't hide
  // behind both calls happening to return equal values.
  const preApprovalPoint = { x: 500, y: 500 };
  const postApprovalPoint = { x: 520, y: 480 };
  const coveringA = fakeWindow(
    { x: 400, y: 400, width: 200, height: 200 },
    true,
    events,
    "coveringA",
  );
  const coveringB = fakeWindow(
    { x: 450, y: 450, width: 100, height: 100 },
    true,
    events,
    "coveringB",
  );
  let resolveCount = 0;
  const deps: PointActionDeps = {
    resolve: () => {
      events.push("resolve");
      resolveCount += 1;
      return {
        shot,
        point: resolveCount === 1 ? preApprovalPoint : postApprovalPoint,
      };
    },
    confirm: async () => {
      events.push("confirm");
      return true;
    },
    windows: () => [coveringA, coveringB],
    showPointer: async (received) => {
      assert.deepEqual(received, postApprovalPoint);
      events.push("showPointer");
    },
  };
  await performPointAction("Save button", deps);
  assert.deepEqual(events, [
    "resolve",
    "confirm",
    "resolve",
    "conceal:coveringA",
    "conceal:coveringB",
    "showPointer",
    "restore:coveringA",
    "restore:coveringB",
  ]);
});

test("confirm receives exactly the point prompt for the label and shot, and the request's signal", async () => {
  let received: ApprovalPrompt | undefined;
  let receivedSignal: AbortSignal | undefined;
  const controller = new AbortController();
  const deps: PointActionDeps = {
    resolve: () => ({ shot, point: { x: 10, y: 10 } }),
    confirm: async (prompt, signal) => {
      received = prompt;
      receivedSignal = signal;
      return true;
    },
    windows: () => [],
    showPointer: async () => {},
  };
  await performPointAction("Save button", deps, controller.signal);
  assert.deepEqual(received, {
    message: "The agent wants to show a pointer on Display A",
    detail: "The agent says it points at: Save button",
  });
  assert.equal(receivedSignal, controller.signal);
});

test("a window that isn't visible, and a visible window that doesn't cover the point, are never concealed or restored", async () => {
  const events: string[] = [];
  const point = { x: 500, y: 500 };
  const invisibleCovering = fakeWindow(
    { x: 400, y: 400, width: 200, height: 200 },
    false,
    events,
    "invisibleCovering",
  );
  const visibleNonCovering = fakeWindow(
    { x: 5000, y: 5000, width: 100, height: 100 },
    true,
    events,
    "visibleNonCovering",
  );
  const deps: PointActionDeps = {
    resolve: () => ({ shot, point }),
    confirm: async () => true,
    windows: () => [invisibleCovering, visibleNonCovering],
    showPointer: async () => {
      events.push("showPointer");
    },
  };
  await performPointAction("Save button", deps);
  assert.deepEqual(events, ["showPointer"]);
});

// The pointer lands where the second resolve says, so a window over only
// the first point is left alone, and one over only the second is cleared.
test("only a window over the post-approval point is concealed, not one over the pre-approval point", async () => {
  const events: string[] = [];
  const preApprovalPoint = { x: 100, y: 100 };
  const postApprovalPoint = { x: 900, y: 900 };
  const overPreApproval = fakeWindow(
    { x: 50, y: 50, width: 100, height: 100 },
    true,
    events,
    "overPreApproval",
  );
  const overPostApproval = fakeWindow(
    { x: 850, y: 850, width: 100, height: 100 },
    true,
    events,
    "overPostApproval",
  );
  let resolveCount = 0;
  const deps: PointActionDeps = {
    resolve: () => {
      resolveCount += 1;
      return {
        shot,
        point: resolveCount === 1 ? preApprovalPoint : postApprovalPoint,
      };
    },
    confirm: async () => true,
    windows: () => [overPreApproval, overPostApproval],
    showPointer: async () => {
      events.push("showPointer");
    },
  };
  await performPointAction("Save button", deps);
  assert.deepEqual(events, [
    "conceal:overPostApproval",
    "showPointer",
    "restore:overPostApproval",
  ]);
});

test("a decline rejects with the exact error, with no second resolve, no conceal and no showPointer", async () => {
  const events: string[] = [];
  let resolveCount = 0;
  const deps: PointActionDeps = {
    resolve: () => {
      resolveCount += 1;
      return { shot, point: { x: 500, y: 500 } };
    },
    confirm: async () => false,
    windows: () => [
      fakeWindow(
        { x: 400, y: 400, width: 200, height: 200 },
        true,
        events,
        "covering",
      ),
    ],
    showPointer: async () => {
      events.push("showPointer");
    },
  };
  let caught: unknown;
  try {
    await performPointAction("Save button", deps);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.message, "User declined action");
  assert.equal(resolveCount, 1);
  assert.deepEqual(events, []);
});

test("a failed prompt propagates its error, with no second resolve, no conceal and no showPointer", async () => {
  const events: string[] = [];
  const original = new Error("dialog failed");
  let resolveCount = 0;
  const deps: PointActionDeps = {
    resolve: () => {
      resolveCount += 1;
      return { shot, point: { x: 500, y: 500 } };
    },
    confirm: async () => {
      throw original;
    },
    windows: () => [
      fakeWindow(
        { x: 400, y: 400, width: 200, height: 200 },
        true,
        events,
        "covering",
      ),
    ],
    showPointer: async () => {
      events.push("showPointer");
    },
  };
  await assert.rejects(
    performPointAction("Save button", deps),
    (error: unknown) => error === original,
  );
  assert.equal(resolveCount, 1);
  assert.deepEqual(events, []);
});

// Stop, or the MCP call timing out, can cancel the request while the
// prompt is open; an "Allow once" that lands at the same moment must not
// show the pointer for a request nobody is waiting on.
test("a request cancelled while the prompt is open rejects, with no second resolve, no conceal and no showPointer", async () => {
  const events: string[] = [];
  const controller = new AbortController();
  let resolveCount = 0;
  const deps: PointActionDeps = {
    resolve: () => {
      resolveCount += 1;
      return { shot, point: { x: 500, y: 500 } };
    },
    confirm: async () => {
      controller.abort();
      return true;
    },
    windows: () => [
      fakeWindow(
        { x: 400, y: 400, width: 200, height: 200 },
        true,
        events,
        "covering",
      ),
    ],
    showPointer: async () => {
      events.push("showPointer");
    },
  };
  await assert.rejects(
    performPointAction("Save button", deps, controller.signal),
    { message: CANCELLED },
  );
  assert.equal(resolveCount, 1);
  assert.deepEqual(events, []);
});

test("a failure in the second resolve propagates, with no conceal and no showPointer", async () => {
  const events: string[] = [];
  let resolveCount = 0;
  const deps: PointActionDeps = {
    resolve: () => {
      resolveCount += 1;
      if (resolveCount === 2) throw new Error("changed");
      return { shot, point: { x: 500, y: 500 } };
    },
    confirm: async () => true,
    windows: () => [
      fakeWindow(
        { x: 400, y: 400, width: 200, height: 200 },
        true,
        events,
        "covering",
      ),
    ],
    showPointer: async () => {
      events.push("showPointer");
    },
  };
  let caught: unknown;
  try {
    await performPointAction("Save button", deps);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.message, "changed");
  assert.equal(resolveCount, 2);
  assert.deepEqual(events, []);
});

// The user approved a pointer on one capture. If its id names a different
// capture by the time the prompt closes, the point would be measured
// against an image the user never saw, even when the display name matches.
test("a screenshot replaced while the prompt was open is refused, with no conceal and no showPointer", async () => {
  const events: string[] = [];
  const replacement = { label: "Display A" };
  let resolveCount = 0;
  const deps: PointActionDeps = {
    resolve: () => {
      resolveCount += 1;
      return {
        shot: resolveCount === 1 ? shot : replacement,
        point: { x: 500, y: 500 },
      };
    },
    confirm: async () => true,
    windows: () => [
      fakeWindow(
        { x: 400, y: 400, width: 200, height: 200 },
        true,
        events,
        "covering",
      ),
    ],
    showPointer: async () => {
      events.push("showPointer");
    },
  };
  await assert.rejects(performPointAction("Save button", deps), {
    message:
      "That screenshot was replaced while the prompt was open. Ask the user to attach a new one.",
  });
  assert.equal(resolveCount, 2);
  assert.deepEqual(events, []);
});

test("a failure in the first resolve propagates without ever asking to confirm", async () => {
  let confirmCalled = false;
  const deps: PointActionDeps = {
    resolve: () => {
      throw new Error("no screenshot");
    },
    confirm: async () => {
      confirmCalled = true;
      return true;
    },
    windows: () => [],
    showPointer: async () => {},
  };
  let caught: unknown;
  try {
    await performPointAction("Save button", deps);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.message, "no screenshot");
  assert.equal(confirmCalled, false);
});

test("a conceal that throws propagates, and the pointer never shows", async () => {
  const events: string[] = [];
  const failure = new Error("setOpacity failed");
  const deps: PointActionDeps = {
    resolve: () => ({ shot, point: { x: 500, y: 500 } }),
    confirm: async () => true,
    windows: () => [
      fakeWindow(
        { x: 400, y: 400, width: 200, height: 200 },
        true,
        events,
        "covering",
        undefined,
        { conceal: failure },
      ),
    ],
    showPointer: async () => {
      events.push("showPointer");
    },
  };
  await assert.rejects(
    performPointAction("Save button", deps),
    (error: unknown) => error === failure,
  );
  assert.deepEqual(events, []);
});

test("a showPointer failure still restores every concealed window, and the failure propagates", async () => {
  const events: string[] = [];
  const point = { x: 500, y: 500 };
  const coveringA = fakeWindow(
    { x: 400, y: 400, width: 200, height: 200 },
    true,
    events,
    "coveringA",
  );
  const coveringB = fakeWindow(
    { x: 450, y: 450, width: 100, height: 100 },
    true,
    events,
    "coveringB",
  );
  const deps: PointActionDeps = {
    resolve: () => ({ shot, point }),
    confirm: async () => true,
    windows: () => [coveringA, coveringB],
    showPointer: async () => {
      throw new Error("helper failed");
    },
  };
  let caught: unknown;
  try {
    await performPointAction("Save button", deps);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.message, "helper failed");
  assert.deepEqual(events, [
    "conceal:coveringA",
    "conceal:coveringB",
    "restore:coveringA",
    "restore:coveringB",
  ]);
});

// The helper's failure says why no pointer appeared; a restore failure on
// top of it must not replace that.
test("a restore that throws after a showPointer failure keeps the showPointer error", async () => {
  const events: string[] = [];
  const helperFailure = new Error("helper failed");
  const deps: PointActionDeps = {
    resolve: () => ({ shot, point: { x: 500, y: 500 } }),
    confirm: async () => true,
    windows: () => [
      fakeWindow(
        { x: 400, y: 400, width: 200, height: 200 },
        true,
        events,
        "covering",
        undefined,
        { restore: new Error("restore failed") },
      ),
    ],
    showPointer: async () => {
      throw helperFailure;
    },
  };
  await assert.rejects(
    performPointAction("Save button", deps),
    (error: unknown) => error === helperFailure,
  );
  assert.deepEqual(events, ["conceal:covering"]);
});

// The user already saw the pointer once showPointer succeeds, so a restore
// failure after that must not fail the action: retrying would show it again
// for something already seen, and prompt the user again for nothing. The
// window's fade record survives the failed restore (window-occlusion.ts's
// undoFade), so a later conceal()/restore() cycle still retries it.
test("a restore that throws after the pointer showed is swallowed, not propagated", async () => {
  const events: string[] = [];
  const restoreFailure = new Error("restore failed");
  const deps: PointActionDeps = {
    resolve: () => ({ shot, point: { x: 500, y: 500 } }),
    confirm: async () => true,
    windows: () => [
      fakeWindow(
        { x: 400, y: 400, width: 200, height: 200 },
        true,
        events,
        "covering",
        undefined,
        { restore: restoreFailure },
      ),
    ],
    showPointer: async () => {
      events.push("showPointer");
    },
  };
  await performPointAction("Save button", deps);
  assert.deepEqual(events, ["conceal:covering", "showPointer"]);
});

test("a window destroyed while the pointer is showing is skipped on restore, without throwing", async () => {
  const events: string[] = [];
  const point = { x: 500, y: 500 };
  const state = { destroyed: false, opacity: 1 };
  const covering = fakeWindow(
    { x: 400, y: 400, width: 200, height: 200 },
    true,
    events,
    "covering",
    state,
  );
  const deps: PointActionDeps = {
    resolve: () => ({ shot, point }),
    confirm: async () => true,
    windows: () => [covering],
    showPointer: async () => {
      // Windows are created once and only ever hidden or shown again; a
      // placement change never destroys and recreates one. This simulates
      // the one case that does: the app quitting destroys the window while
      // the ring is up. Either way, restore must not throw on a window
      // that's gone by the time it runs.
      state.destroyed = true;
      events.push("showPointer");
    },
  };
  await performPointAction("Save button", deps);
  assert.deepEqual(events, ["conceal:covering", "showPointer"]);
});
