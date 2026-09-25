import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHAT_SIZE,
  RECORD_SIZE,
  companionTrayPosition,
} from "../electron/companion-chat-position";

test("tray centers below the sprite when space allows", () => {
  const area = { x: 0, y: 0, width: 1440, height: 900 };
  assert.deepEqual(
    companionTrayPosition(
      { x: 100, y: 200, width: 240, height: 170 },
      [area],
      CHAT_SIZE,
    ),
    { x: 30, y: 380 },
  );
});

test("tray flips above a sprite near the bottom edge", () => {
  const area = { x: 0, y: 0, width: 1440, height: 900 };
  assert.deepEqual(
    companionTrayPosition(
      { x: 1180, y: 700, width: 240, height: 170 },
      [area],
      RECORD_SIZE,
    ),
    { x: 1120, y: 470 },
  );
});

test("tray remains inside a negative-coordinate display", () => {
  const areas = [
    { x: 0, y: 0, width: 1440, height: 900 },
    { x: -1200, y: 80, width: 1200, height: 800 },
  ];
  assert.deepEqual(
    companionTrayPosition(
      { x: -300, y: 200, width: 240, height: 170 },
      areas,
      CHAT_SIZE,
    ),
    { x: -380, y: 380 },
  );
});
