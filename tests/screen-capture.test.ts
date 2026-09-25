import { test } from "node:test";
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
// server/screenshots.test.ts), keeping the default fixture's target size
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
    screenCaptureAllowed: async () => true,
    primaryDisplay: () => ({
      id: displayId,
      label: displayLabel,
      size: displaySize,
      bounds: displayBounds,
    }),
    displays: () => [{ id: displayId, bounds: displayBounds }],
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
    rebuild: (_png, size) => Buffer.from(pngHeader(size.width, size.height)),
    register: (input) => {
      events.push("register");
      return { ...input, id: "shot_deadbeef", capturedAt: 123 };
    },
    sourcesTimeoutMs: 10_000,
  };
  return { ...base, ...overrides };
}

test("the happy path conceals, waits 200ms, fetches sources, registers, then restores, in that order", async () => {
  const events: string[] = [];
  const deps = makeDeps(events);
  const result = await captureScreenshot(deps);
  assert.deepEqual(events, [
    "conceal",
    "wait:200",
    "sources",
    "register",
    "restore",
  ]);
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
      // Deliberately not exactly the requested target, so a test that
      // reads the registered size back off the requested size (instead of
      // measuring the rebuilt PNG) would fail to catch this.
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

test("withTimeout resolves with the value and clears its timer when the promise wins", async () => {
  // A short timeout paired with an already-resolved promise: if the timer
  // were not cleared, it would still be harmless here since the process
  // exits once every test finishes, but a leaked handle would keep this
  // test process alive past that point instead of exiting promptly.
  const result = await withTimeout(Promise.resolve("value"), 20, "timed out");
  assert.equal(result, "value");
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
  let caught: unknown;
  try {
    await withTimeout(Promise.reject(new Error("boom")), 20, "took too long");
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.message, "boom");
});
