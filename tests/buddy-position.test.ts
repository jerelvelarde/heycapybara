import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clampBuddyPosition,
  beginBuddyGesture,
  advanceBuddyGesture,
  loadBuddyPosition,
  saveBuddyPosition,
} from "../electron/buddy-position";
import { crossedDragThreshold } from "../src/buddy-drag";
const primary = { x: 0, y: 25, width: 1440, height: 875 };
test("drag threshold separates small click motion from dragging", () => {
  assert.equal(crossedDragThreshold({ x: 10, y: 10 }, { x: 12, y: 12 }), false);
  assert.equal(crossedDragThreshold({ x: 10, y: 10 }, { x: 13, y: 14 }), true);
});
test("companion stays within work area including menu and dock insets", () => {
  assert.deepEqual(clampBuddyPosition({ x: 1500, y: -20 }, [primary]), {
    x: 1200,
    y: 25,
  });
  assert.deepEqual(clampBuddyPosition({ x: 1300, y: 900 }, [primary]), {
    x: 1200,
    y: 730,
  });
});
test("negative display coordinates are preserved and removed monitors recover", () => {
  const secondary = { x: -1920, y: -100, width: 1920, height: 1080 };
  assert.deepEqual(
    clampBuddyPosition({ x: -1200, y: 300 }, [primary, secondary]),
    { x: -1200, y: 300 },
  );
  assert.deepEqual(clampBuddyPosition({ x: -1200, y: 300 }, [primary]), {
    x: 0,
    y: 300,
  });
});
test("small display anchors companion inside available area", () => {
  assert.deepEqual(
    clampBuddyPosition({ x: 500, y: 500 }, [
      { x: 30, y: 40, width: 200, height: 120 },
    ]),
    { x: 30, y: 40 },
  );
});
test("position persists privately, missing file defaults, invalid data fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kite-buddy-test-"));
  const path = join(dir, "position.json");
  try {
    assert.equal(await loadBuddyPosition(path), undefined);
    await saveBuddyPosition(path, { x: -500, y: 70 });
    assert.deepEqual(await loadBuddyPosition(path), { x: -500, y: 70 });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await writeFile(path, '{"x":"bad","y":70}');
    await assert.rejects(
      loadBuddyPosition(path),
      /Invalid saved companion position/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("delayed begin preserves pointerdown origin for a short completed drag", () => {
  // IPC may arrive after the physical cursor has already moved six pixels.
  const gesture = beginBuddyGesture(
    { x: 150, y: 150 },
    { x: 100, y: 100, width: 240, height: 170 },
  );
  // Release is the first update: the main process must evaluate it too.
  assert.deepEqual(
    advanceBuddyGesture(gesture, { x: 156, y: 150 }, [primary]),
    { x: 106, y: 100 },
  );
  assert.equal(gesture.moved, true);
});
test("a short click stays stationary and an invalid drag origin is rejected", () => {
  const bounds = { x: 100, y: 100, width: 240, height: 170 };
  const gesture = beginBuddyGesture({ x: 150, y: 150 }, bounds);
  assert.equal(
    advanceBuddyGesture(gesture, { x: 153, y: 150 }, [primary]),
    undefined,
  );
  assert.equal(gesture.moved, false);
  assert.throws(
    () => beginBuddyGesture({ x: 0, y: 0 }, bounds),
    /inside the companion/,
  );
});
