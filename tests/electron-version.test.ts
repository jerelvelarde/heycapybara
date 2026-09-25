import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// window-occlusion.ts and screen-capture.ts (via main.ts's window factories
// and IPC handlers, and native/Recorder.swift's --point helper) rely on
// specific Electron v44.4.5 behaviour that its public API doesn't guarantee:
//  - setIgnoresMouseEvents is never called at window creation, so a
//    transparent, frameless window starts on AppKit's per-pixel
//    click-through default (see markTransparent in window-occlusion.ts);
//  - a parentless async message box on macOS blocks;
//  - hiding a window ends its sheet;
//  - the message box ignores the `title` option;
//  - Return and Escape bind in a specific order.
// None of these are pinned anywhere else, so an Electron upgrade could
// silently change any of them. Recheck each one before moving this pin, the
// same way the Codex SDK pin in tests/screenshots.test.ts is rechecked.
test("the pinned Electron version matches the behaviour window-occlusion.ts and screen-capture.ts rely on", async () => {
  const packageJsonPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "node_modules",
    "electron",
    "package.json",
  );
  const pkg = JSON.parse(await readFile(packageJsonPath, "utf8"));
  assert.equal(
    pkg.version,
    "44.4.5",
    "Electron changed: recheck these before moving this pin -- " +
      "setIgnoresMouseEvents is never called at window creation (the per-pixel " +
      "click-through default window-occlusion.ts's markTransparent relies on), " +
      "a parentless async message box on macOS blocks, hiding a window ends " +
      "its sheet, the message box ignores the title option, and the Return/" +
      "Escape key binding order.",
  );
});
