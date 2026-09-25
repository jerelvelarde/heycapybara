import { test } from "node:test";
import assert from "node:assert/strict";
import {
  performPointAction,
  type PointActionDeps,
  type PointWindow,
} from "../electron/point-action";
import type { Rect } from "../server/screenshots";

// Bounds and visibility are real inputs: coversPoint and conceal (both from
// window-occlusion) decide what counts as covering and do the actual
// concealing, exactly as in production. Concealment is observed through
// opacity, not visibility.
function fakeWindow(
  bounds: Rect,
  visible: boolean,
  events: string[],
  name: string,
  state: { destroyed: boolean; opacity: number } = {
    destroyed: false,
    opacity: 1,
  },
): PointWindow {
  return {
    isVisible: () => visible,
    getBounds: () => bounds,
    isDestroyed: () => state.destroyed,
    getOpacity: () => state.opacity,
    setOpacity: (next: number) => {
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
        shot: { label: "Display A" },
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

test("confirm receives exactly the point prompt for the label and shot", async () => {
  let received: { message: string; detail?: string } | undefined;
  const deps: PointActionDeps = {
    resolve: () => ({ shot: { label: "Display A" }, point: { x: 10, y: 10 } }),
    confirm: async (prompt) => {
      received = prompt;
      return true;
    },
    windows: () => [],
    showPointer: async () => {},
  };
  await performPointAction("Save button", deps);
  assert.deepEqual(received, {
    message: "Show a pointer on Display A",
    detail: "The agent says it points at: Save button",
  });
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
    resolve: () => ({ shot: { label: "Display A" }, point }),
    confirm: async () => true,
    windows: () => [invisibleCovering, visibleNonCovering],
    showPointer: async () => {
      events.push("showPointer");
    },
  };
  await performPointAction("Save button", deps);
  assert.deepEqual(events, ["showPointer"]);
});

test("a decline rejects with the exact error, with no second resolve, no conceal and no showPointer", async () => {
  const events: string[] = [];
  let resolveCount = 0;
  const deps: PointActionDeps = {
    resolve: () => {
      resolveCount += 1;
      return { shot: { label: "Display A" }, point: { x: 500, y: 500 } };
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

test("a failure in the second resolve propagates, with no conceal and no showPointer", async () => {
  const events: string[] = [];
  let resolveCount = 0;
  const deps: PointActionDeps = {
    resolve: () => {
      resolveCount += 1;
      if (resolveCount === 2) throw new Error("changed");
      return { shot: { label: "Display A" }, point: { x: 500, y: 500 } };
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
    resolve: () => ({ shot: { label: "Display A" }, point }),
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
    resolve: () => ({ shot: { label: "Display A" }, point }),
    confirm: async () => true,
    windows: () => [covering],
    showPointer: async () => {
      // Only quitting destroys a window outright (a placement change just
      // hides and recreates it); either way, restore must not throw on a
      // window that's gone by the time it runs.
      state.destroyed = true;
      events.push("showPointer");
    },
  };
  await performPointAction("Save button", deps);
  assert.deepEqual(events, ["conceal:covering", "showPointer"]);
});
