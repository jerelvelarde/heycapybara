import { test } from "node:test";
import assert from "node:assert/strict";
import {
  performPointAction,
  type PointActionDeps,
  type PointWindow,
} from "../electron/point-action";
import type { Rect } from "../server/screenshots";

// Bounds and visibility are real: coversPoint (from window-occlusion) decides
// whether a given window counts as covering, exactly as it does in main.ts.
function fakeWindow(
  bounds: Rect,
  visible: boolean,
  events: string[],
  name: string,
): PointWindow {
  return {
    isVisible: () => visible,
    getBounds: () => bounds,
    hide: () => {
      events.push(`hide:${name}`);
    },
    showInactive: () => {
      events.push(`showInactive:${name}`);
    },
  };
}

test("happy path: resolve, confirm, resolve, hide, showPointer, showInactive run in order for every covering window", async () => {
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
    resolve: () => {
      events.push("resolve");
      return { shot: { label: "Display A" }, point };
    },
    confirm: async () => {
      events.push("confirm");
      return true;
    },
    windows: () => [coveringA, coveringB],
    showPointer: async (received) => {
      assert.deepEqual(received, point);
      events.push("showPointer");
    },
  };
  await performPointAction("Save button", deps);
  assert.deepEqual(events, [
    "resolve",
    "confirm",
    "resolve",
    "hide:coveringA",
    "hide:coveringB",
    "showPointer",
    "showInactive:coveringA",
    "showInactive:coveringB",
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

test("a window that isn't visible, and a visible window that doesn't cover the point, are never hidden or shown", async () => {
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

test("a decline rejects with the exact error, with no second resolve, no hide and no showPointer", async () => {
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

test("a failure in the second resolve propagates, with no hide and no showPointer", async () => {
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

test("a showPointer failure still restores every hidden window, and the failure propagates", async () => {
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
    "hide:coveringA",
    "hide:coveringB",
    "showInactive:coveringA",
    "showInactive:coveringB",
  ]);
});
