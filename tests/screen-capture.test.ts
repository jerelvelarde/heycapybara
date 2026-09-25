import { test, mock } from "node:test";
import assert from "node:assert/strict";
import {
  captureScreenshot,
  singleFlight,
  withTimeout,
  type CaptureDeps,
} from "../electron/screen-capture";
import { pngHeader } from "./png-fixture";

const displayId = 7;
const displayLabel = "Built-in Retina Display";
// Chosen so captureSize() passes it through unchanged (see
// tests/screenshots.test.ts), keeping the default fixture's target size
// equal to the display's own size.
const displaySize = { width: 1512, height: 982 };
const displayBounds = { x: 0, y: 0, width: 1512, height: 982 };

// A fully-wired happy-path CaptureDeps. Every step pushes its name onto the
// shared `events` log (in the order captureScreenshot actually calls them),
// so a test can assert both the outcome and exactly what ran.
function makeDeps(
  events: string[],
  overrides: Partial<CaptureDeps> = {},
): CaptureDeps {
  const base: CaptureDeps = {
    screenCaptureAllowed: async () => {
      events.push("screenCaptureAllowed");
      return true;
    },
    primaryDisplay: () => {
      events.push("primaryDisplay");
      return {
        id: displayId,
        label: displayLabel,
        size: displaySize,
        bounds: displayBounds,
      };
    },
    displays: () => {
      events.push("displays");
      return [{ id: displayId, bounds: displayBounds }];
    },
    conceal: () => {
      events.push("conceal");
      return () => {
        events.push("restore");
      };
    },
    wait: async (ms) => {
      events.push(`wait:${ms}`);
    },
    sources: async (target) => {
      events.push("sources");
      return [
        {
          display_id: String(displayId),
          thumbnail: {
            isEmpty: () => false,
            toPNG: () => Buffer.from(pngHeader(target.width, target.height)),
          },
        },
      ];
    },
    rebuild: (_png, size) => {
      events.push("rebuild");
      return Buffer.from(pngHeader(size.width, size.height));
    },
    register: (input) => {
      events.push("register");
      return { ...input, id: "shot_deadbeef", capturedAt: 123 };
    },
    sourcesTimeoutMs: 10_000,
  };
  return { ...base, ...overrides };
}

test("the happy path checks permission, conceals, waits 200ms, fetches sources, restores, re-reads the display, then registers, in that order", async () => {
  const events: string[] = [];
  const deps = makeDeps(events);
  const result = await captureScreenshot(deps);
  assert.deepEqual(events, [
    "screenCaptureAllowed",
    "primaryDisplay",
    "conceal",
    "wait:200",
    "sources",
    "restore",
    "displays",
    "register",
  ]);
  // Restated explicitly, independent of the exact full sequence above: the
  // display is re-read only after the pixels are captured, and only before
  // the capture is registered.
  assert.ok(events.indexOf("sources") < events.indexOf("displays"));
  assert.ok(events.indexOf("displays") < events.indexOf("register"));
  // The windows come back as soon as the pixels are captured, not after the
  // PNG work and the display re-check that follow.
  assert.ok(events.indexOf("restore") < events.indexOf("displays"));
  assert.equal(result.id, "shot_deadbeef");
  assert.equal(result.label, displayLabel);
  assert.equal(result.width, displaySize.width);
  assert.equal(result.height, displaySize.height);
  assert.equal(
    result.dataUrl,
    "data:image/png;base64," +
      Buffer.from(pngHeader(displaySize.width, displaySize.height)).toString(
        "base64",
      ),
  );
});

test("a denied permission throws before anything is concealed or captured", async () => {
  const events: string[] = [];
  const deps = makeDeps(events, {
    screenCaptureAllowed: async () => false,
  });
  let caught: unknown;
  try {
    await captureScreenshot(deps);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.equal(
    caught.message,
    "Enable Screen Recording permission in Settings.",
  );
  assert.deepEqual(events, []);
});

test("a rejection from sources propagates and still restores exactly once", async () => {
  const events: string[] = [];
  const deps = makeDeps(events, {
    sources: async () => {
      throw new Error("desktopCapturer boom");
    },
  });
  let caught: unknown;
  try {
    await captureScreenshot(deps);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.message, "desktopCapturer boom");
  assert.equal(events.filter((e) => e === "restore").length, 1);
});

test("a sources call that never settles is refused once the timeout elapses, and still restores exactly once", async () => {
  const events: string[] = [];
  const deps = makeDeps(events, {
    sourcesTimeoutMs: 20,
    sources: () => new Promise(() => {}),
  });
  let caught: unknown;
  try {
    await captureScreenshot(deps);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.equal(
    caught.message,
    "Screen capture didn't respond. Try again, or quit and reopen OpenMuse Desktop.",
  );
  assert.equal(events.filter((e) => e === "restore").length, 1);
});

test("sources for other displays only fail the capture without touching their images or registering anything", async () => {
  const events: string[] = [];
  const poisonThumbnail = {
    isEmpty: (): boolean => {
      throw new Error("must not inspect another display's thumbnail");
    },
    toPNG: (): Buffer => {
      throw new Error("must not read another display's image");
    },
  };
  const deps = makeDeps(events, {
    sources: async () => {
      events.push("sources");
      return [
        { display_id: "101", thumbnail: poisonThumbnail },
        { display_id: "202", thumbnail: poisonThumbnail },
      ];
    },
  });
  let caught: unknown;
  try {
    await captureScreenshot(deps);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.equal(
    caught.message,
    `Couldn't find a screen source for ${displayLabel}. Try again, or reconnect the display.`,
  );
  assert.equal(events.filter((e) => e === "register").length, 0);
  assert.equal(events.filter((e) => e === "restore").length, 1);
});

test("an empty thumbnail is refused without ever encoding it, and still restores exactly once", async () => {
  const events: string[] = [];
  const deps = makeDeps(events, {
    sources: async () => [
      {
        display_id: String(displayId),
        thumbnail: {
          isEmpty: () => true,
          toPNG: (): Buffer => {
            throw new Error("must not encode an empty thumbnail");
          },
        },
      },
    ],
  });
  let caught: unknown;
  try {
    await captureScreenshot(deps);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.equal(
    caught.message,
    "Screen capture came back empty. If you just granted Screen Recording, quit and reopen OpenMuse Desktop.",
  );
  assert.equal(events.filter((e) => e === "register").length, 0);
  assert.equal(events.filter((e) => e === "restore").length, 1);
});

test("a display that changed bounds, or vanished, between capture and re-read is refused without registering", async () => {
  const variants: { name: string; displays: CaptureDeps["displays"] }[] = [
    {
      name: "bounds changed",
      displays: () => [
        { id: displayId, bounds: { ...displayBounds, width: 1600 } },
      ],
    },
    {
      name: "display removed",
      displays: () => [],
    },
  ];
  for (const variant of variants) {
    const events: string[] = [];
    const deps = makeDeps(events, { displays: variant.displays });
    let caught: unknown;
    try {
      await captureScreenshot(deps);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof Error, variant.name);
    assert.equal(
      caught.message,
      "The display changed during the capture. Try again.",
      variant.name,
    );
    assert.equal(
      events.filter((e) => e === "register").length,
      0,
      variant.name,
    );
    assert.equal(events.filter((e) => e === "restore").length, 1, variant.name);
  }
});

test("a failure in register propagates and still restores exactly once", async () => {
  const events: string[] = [];
  const deps = makeDeps(events, {
    register: () => {
      throw new Error("registry is full");
    },
  });
  let caught: unknown;
  try {
    await captureScreenshot(deps);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.message, "registry is full");
  assert.equal(events.filter((e) => e === "restore").length, 1);
});

test("a thumbnail larger than the target is rebuilt at the target size, and the measured PNG size is what gets registered", async () => {
  const events: string[] = [];
  const rebuildCalls: { width: number; height: number }[] = [];
  const registered: { width: number; height: number }[] = [];
  const deps = makeDeps(events, {
    sources: async () => [
      {
        display_id: String(displayId),
        thumbnail: {
          isEmpty: () => false,
          toPNG: () => Buffer.from(pngHeader(3024, 1964)),
        },
      },
    ],
    rebuild: (_png, size) => {
      rebuildCalls.push(size);
      // Returns a size different from the one requested, so an assertion
      // that trusted the requested size instead of measuring the rebuilt
      // PNG would miss a bug that skips the real measurement.
      return Buffer.from(pngHeader(1511, 982));
    },
    register: (input) => {
      registered.push({ width: input.width, height: input.height });
      return { ...input, id: "shot_deadbeef", capturedAt: 123 };
    },
  });
  const result = await captureScreenshot(deps);
  assert.deepEqual(rebuildCalls, [{ width: 1512, height: 982 }]);
  assert.deepEqual(registered, [{ width: 1511, height: 982 }]);
  assert.equal(result.width, 1511);
  assert.equal(result.height, 982);
  assert.equal(
    result.dataUrl,
    "data:image/png;base64," +
      Buffer.from(pngHeader(1511, 982)).toString("base64"),
  );
});

test('an empty display label falls back to "Main display" when registering', async () => {
  const events: string[] = [];
  let registeredLabel: string | undefined;
  const deps = makeDeps(events, {
    primaryDisplay: () => ({
      id: displayId,
      label: "",
      size: displaySize,
      bounds: displayBounds,
    }),
    register: (input) => {
      registeredLabel = input.label;
      return { ...input, id: "shot_deadbeef", capturedAt: 123 };
    },
  });
  const result = await captureScreenshot(deps);
  assert.equal(registeredLabel, "Main display");
  assert.equal(result.label, "Main display");
});

test("register receives exactly the display's id, label and bounds, plus the measured pixel size", async () => {
  const events: string[] = [];
  const captured: unknown[] = [];
  const deps = makeDeps(events, {
    register: (input) => {
      events.push("register");
      captured.push(input);
      return { ...input, id: "shot_deadbeef", capturedAt: 123 };
    },
  });
  await captureScreenshot(deps);
  assert.deepEqual(captured, [
    {
      displayId: String(displayId),
      label: displayLabel,
      bounds: displayBounds,
      width: displaySize.width,
      height: displaySize.height,
    },
  ]);
});

test("a display larger than the capture cap is requested at the scaled-down target, not passed through at its own size", async () => {
  const events: string[] = [];
  const largeSize = { width: 2560, height: 1440 };
  const largeBounds = { x: 0, y: 0, width: 2560, height: 1440 };
  let requestedTarget: { width: number; height: number } | undefined;
  const deps = makeDeps(events, {
    primaryDisplay: () => {
      events.push("primaryDisplay");
      return {
        id: displayId,
        label: displayLabel,
        size: largeSize,
        bounds: largeBounds,
      };
    },
    displays: () => {
      events.push("displays");
      return [{ id: displayId, bounds: largeBounds }];
    },
    sources: async (target) => {
      events.push("sources");
      requestedTarget = target;
      return [
        {
          display_id: String(displayId),
          thumbnail: {
            isEmpty: () => false,
            toPNG: () => Buffer.from(pngHeader(target.width, target.height)),
          },
        },
      ];
    },
  });
  const result = await captureScreenshot(deps);
  // 2560x1440 is small enough that a version which passed display.size
  // straight to sources() instead of captureSize(display.size) would still
  // produce a valid, if oversized, capture -- this pins the actual target.
  assert.deepEqual(requestedTarget, { width: 1920, height: 1080 });
  assert.equal(result.width, 1920);
  assert.equal(result.height, 1080);
});

test("singleFlight shares one in-flight run across concurrent callers and resolves both to the same result", async () => {
  let calls = 0;
  let resolveRun: (value: string) => void;
  const wrapped = singleFlight(
    () =>
      new Promise<string>((resolve) => {
        calls += 1;
        resolveRun = resolve;
      }),
  );
  const first = wrapped();
  const second = wrapped();
  assert.equal(calls, 1);
  resolveRun!("done");
  assert.equal(await first, "done");
  assert.equal(await second, "done");
  assert.equal(calls, 1);
});

test("singleFlight starts a fresh run after the previous one rejects", async () => {
  let calls = 0;
  const wrapped = singleFlight(() => {
    calls += 1;
    return calls === 1
      ? Promise.reject(new Error("first run failed"))
      : Promise.resolve("second run");
  });
  let caught: unknown;
  try {
    await wrapped();
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.message, "first run failed");
  assert.equal(await wrapped(), "second run");
  assert.equal(calls, 2);
});

test("singleFlight starts a fresh run for a later call after a SUCCESSFUL one, not just after a rejection", async () => {
  // A version that only cleared `inFlight` in the rejection branch (not in
  // a `finally`) would pass the two tests above -- overlapping callers
  // still share one run, and a run that rejects still clears -- while
  // leaving every later call after a successful run replaying the first
  // result forever instead of capturing again.
  let calls = 0;
  const wrapped = singleFlight(() => {
    calls += 1;
    return Promise.resolve(`run ${calls}`);
  });
  assert.equal(await wrapped(), "run 1");
  assert.equal(await wrapped(), "run 2");
  assert.equal(calls, 2);
});

test("withTimeout resolves with the value and clears its timer when the promise wins", async () => {
  const timeoutSpy = mock.method(global, "setTimeout");
  const clearSpy = mock.method(global, "clearTimeout");
  try {
    // A short timeout paired with an already-resolved promise: if the timer
    // were not cleared, it would still be harmless here since the process
    // exits once every test finishes, but a leaked handle would keep this
    // test process alive past that point instead of exiting promptly.
    const result = await withTimeout(Promise.resolve("value"), 20, "timed out");
    assert.equal(result, "value");
    // Pins the actual clear, not just the absence of a crash: a version
    // that dropped the clearTimeout call would still resolve correctly
    // above, and the two assertions below would fail instead.
    assert.equal(timeoutSpy.mock.calls.length, 1);
    assert.equal(clearSpy.mock.calls.length, 1);
    assert.equal(
      clearSpy.mock.calls[0].arguments[0],
      timeoutSpy.mock.calls[0].result,
    );
  } finally {
    mock.restoreAll();
  }
});

test("withTimeout rejects with the given message when the promise never settles before the timer", async () => {
  let caught: unknown;
  try {
    await withTimeout(new Promise(() => {}), 10, "took too long");
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.message, "took too long");
});

test("withTimeout propagates a rejection from the promise and still clears its timer", async () => {
  const timeoutSpy = mock.method(global, "setTimeout");
  const clearSpy = mock.method(global, "clearTimeout");
  let caught: unknown;
  try {
    await withTimeout(Promise.reject(new Error("boom")), 20, "took too long");
  } catch (error) {
    caught = error;
  } finally {
    mock.restoreAll();
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.message, "boom");
  // Pins the actual clear, the same way the resolve-wins test above does.
  assert.equal(timeoutSpy.mock.calls.length, 1);
  assert.equal(clearSpy.mock.calls.length, 1);
  assert.equal(
    clearSpy.mock.calls[0].arguments[0],
    timeoutSpy.mock.calls[0].result,
  );
});
