import type { Rect } from "../server/screenshots";

// The helper centres a 48-point ring panel on the point (native/Recorder.swift
// --point), so a window within 24 points of it sits under the ring, and the
// extra 8 points keep the target's surroundings visible too. The ring draws
// above our windows at screen-saver level, so this clears the target, not
// the ring.
export const RING_MARGIN = 32;

export function coversPoint(bounds: Rect, point: { x: number; y: number }) {
  return (
    point.x >= bounds.x - RING_MARGIN &&
    point.x < bounds.x + bounds.width + RING_MARGIN &&
    point.y >= bounds.y - RING_MARGIN &&
    point.y < bounds.y + bounds.height + RING_MARGIN
  );
}

export type ConcealableWindow = {
  isDestroyed(): boolean;
  getOpacity(): number;
  setOpacity(opacity: number): void;
  setIgnoreMouseEvents(ignore: boolean): void;
};

// Buddy, the notch and companion chat windows are made transparent: true and
// frameless. Electron's only call site for setIgnoresMouseEvents: is
// SetIgnoreMouseEvents (Electron v44.4.5's shell/browser/native_window_mac.mm);
// it never runs at window creation, so these windows start out on AppKit's
// default, where clicks pass straight through their clear pixels. That
// default holds only until something calls setIgnoreMouseEvents on the
// window, true or false either one; once called, the window hit-tests its
// whole frame from then on, and there is no API to get the default back.
// markTransparent records which windows conceal() must never call it on.
const transparentWindows = new WeakSet<ConcealableWindow>();
export function markTransparent(win: ConcealableWindow) {
  transparentWindows.add(win);
}

// Fades in progress, keyed by window identity, so overlapping conceal() calls
// on the same window nest instead of clobbering each other's recorded opacity.
const fades = new WeakMap<
  ConcealableWindow,
  { count: number; opacity: number }
>();

// Fading a window out instead of hiding it keeps its focus, visibility,
// stacking and Space. A sheet on the window is a separate window of its own,
// so this never fades it either: an open folder-picker or export sheet can
// still show up in a capture or sit over a pointer target.
//
// Every window not marked transparent gets setIgnoreMouseEvents toggled true
// for the duration of the fade and back to false on restore, same as before.
// A marked window is never touched that way in either direction: it is
// invisible at opacity 0 regardless, and calling setIgnoreMouseEvents on it
// even once would cost it its click-through for good (see markTransparent
// above).
//
// Fades nest: the screenshot capture and the pointer can overlap across the
// workspace and companion chat's separate conversations, so a window gets its
// original opacity back only when the last fade covering it ends.
function fadeOut(win: ConcealableWindow): void {
  const existing = fades.get(win);
  if (existing) {
    existing.count += 1;
    return;
  }
  const opacity = win.getOpacity();
  fades.set(win, { count: 1, opacity });
  let opacityChanged = false;
  try {
    win.setOpacity(0);
    opacityChanged = true;
    if (!transparentWindows.has(win)) win.setIgnoreMouseEvents(true);
  } catch (error) {
    // setOpacity(0) may have already landed before this failed, so put it
    // back rather than leave the window stuck invisible with the fade
    // entry gone and nothing on record of the change. A second failure
    // while undoing is swallowed so it doesn't mask the original error.
    fades.delete(win);
    if (opacityChanged) {
      try {
        if (!win.isDestroyed()) win.setOpacity(opacity);
      } catch {
        // ignored: the error above takes precedence
      }
    }
    throw error;
  }
}

function undoFade(win: ConcealableWindow) {
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    const fade = fades.get(win);
    if (!fade) return;
    fade.count -= 1;
    if (fade.count > 0) return;
    fades.delete(win);
    if (win.isDestroyed()) return;
    win.setOpacity(fade.opacity);
    if (!transparentWindows.has(win)) win.setIgnoreMouseEvents(false);
  };
}

export function conceal(windows: ConcealableWindow[]) {
  const restore: Array<() => void> = [];
  try {
    for (const win of windows) {
      fadeOut(win);
      restore.push(undoFade(win));
    }
  } catch (error) {
    // A window later in the list failed to fade: undo whatever this call
    // already faded, through the same nesting bookkeeping restore() uses, so
    // nothing is left invisible and click-through. The fadeOut failure is
    // what the caller needs to see, so a secondary failure while undoing is
    // swallowed here rather than replacing it.
    for (const undo of restore) {
      try {
        undo();
      } catch {
        // ignored: the error from fadeOut above takes precedence
      }
    }
    throw error;
  }
  return () => {
    let firstError: unknown;
    let failed = false;
    for (const undo of restore) {
      try {
        undo();
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
    if (failed) throw firstError;
  };
}
