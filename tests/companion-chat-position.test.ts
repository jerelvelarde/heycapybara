import { test } from "node:test";
import assert from "node:assert/strict";
import { companionChatPosition } from "../electron/companion-chat-position";

test("chat opens beside the sprite and flips at a screen edge", () => {
  const area = { x: 0, y: 0, width: 1440, height: 900 };
  assert.deepEqual(
    companionChatPosition({ x: 100, y: 200, width: 240, height: 170 }, [area]),
    { x: 352, y: 0 },
  );
  assert.deepEqual(
    companionChatPosition({ x: 1180, y: 700, width: 240, height: 170 }, [area]),
    { x: 788, y: 370 },
  );
});

test("chat follows sprite onto a negative-coordinate display", () => {
  const areas = [
    { x: 0, y: 0, width: 1440, height: 900 },
    { x: -1200, y: 80, width: 1200, height: 800 },
  ];
  assert.deepEqual(
    companionChatPosition({ x: -300, y: 600, width: 240, height: 170 }, areas),
    { x: -692, y: 270 },
  );
});
