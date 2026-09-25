import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Each entry is one Electron v44.4.5 behaviour that electron/window-occlusion.ts,
// or electron/approval.ts together with approve() in electron/main.ts, rely
// on without the public API guaranteeing it. Recorder.swift is a separate
// native process and never runs on Electron, so it never belongs on this
// list. None of these is pinned anywhere else, so an Electron upgrade could
// silently change any of them. Recheck each one before moving this pin, the
// same way the Codex SDK pin in tests/screenshots.test.ts is rechecked.
// Both the assertion message below and this file's own record of what to
// recheck are built from this one array, so they can't drift apart.
const RELIED_ON_BEHAVIOUR = [
  // window-occlusion.ts's markTransparent: a transparent, frameless window
  // starts on AppKit's per-pixel click-through default only because of this.
  "setIgnoresMouseEvents is never called at window creation, so a transparent, frameless window starts on AppKit's per-pixel click-through default",

  // electron/approval.ts's askApproval: why it always attaches the box to a
  // host window instead of ever calling the parentless form.
  "a parentless async message box on macOS blocks the main process until it's answered",
  // electron/main.ts's approve(): why it always calls the async
  // dialog.showMessageBox, never the sync form, to reach a host that may be
  // hidden or minimized.
  "the async message box attaches a sheet even to a hidden or minimized parent window; the sync form only attaches when the parent is shown, and otherwise falls back to a blocking runModal",
  // electron/main.ts's approve(): why openWorkspace() leaves a companion
  // chat that is hosting a sheet on screen instead of hiding it.
  "hiding a window ends its sheet",
  // electron/approval.ts: why the prompt's own message names OpenMuse
  // instead of leaving that to the dialog's title.
  "the message box ignores the `title` option",
  // electron/approval.ts: why Cancel is both the default and the cancel
  // button, so Escape (not Return) is what closes the box as a decline.
  "Return and Escape bind to the default and cancel buttons in that order, so Escape's later binding overrides Return's binding to the same button and Return never allows",
  // electron/main.ts's approve(): why hostHidden() is read once the box
  // settles instead of trusted from the 'hide' event.
  "a sheet ended from code, by hiding its host or by an aborted signal, resolves the box as though the cancel button were clicked, on a later task after the call that ended it",
  "the `hide` event comes from occlusion changes (`windowDidChangeOcclusionState` on macOS), not only from an explicit hide() call",
  // electron/main.ts's approve(): why mustShow restores a minimized
  // workspace before calling activate()/openWorkspace().
  "`Focus()` does nothing when `!IsVisible()`",
  // electron/main.ts's approve(): why hostHidden()'s isVisible() check also
  // goes true while the host is merely occluded, not only once truly hidden.
  "`IsVisible()` is `[window_ isVisible] && !occluded && !IsMinimized()`, with the occlusion bitmask compared by `==`",
  // electron/approval.ts: why signal support requires an attached box.
  "an aborted signal closes an attached message box as though the cancel button were clicked",

  // electron/main.ts's `rebuild` adapter, called from
  // electron/screen-capture.ts: why a 2x thumbnail is rebuilt from its own
  // pixels instead of resized directly.
  "a 2x `NativeImage` keeps its scale factor through `resize()`, so resizing one directly would still produce a 2x PNG",
] as const;

test("the pinned Electron version matches the behaviour electron/window-occlusion.ts and electron/approval.ts (via approve() and the rebuild adapter in electron/main.ts) rely on", async () => {
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
      RELIED_ON_BEHAVIOUR.join("; ") +
      ".",
  );
});
