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

// Fades in progress, keyed by window identity, so overlapping conceal() calls
// on the same window nest instead of clobbering each other's recorded opacity.
const fades = new WeakMap<
  ConcealableWindow,
  { count: number; opacity: number }
>();

// Fading a window out instead of hiding it keeps its focus, visibility,
// stacking and Space, and leaves any sheet on it open. No OpenMuse window
// ignores mouse events today, so restoring sets that back to false.
//
// Fades nest: the screenshot capture and the pointer can overlap across the
// workspace and companion chat's separate conversations, so a window gets its
// original opacity back only when the last fade covering it ends.
export function conceal(windows: ConcealableWindow[]) {
  const restore = windows.map((win) => {
    const existing = fades.get(win);
    if (existing) {
      existing.count += 1;
    } else {
      fades.set(win, { count: 1, opacity: win.getOpacity() });
      win.setOpacity(0);
      win.setIgnoreMouseEvents(true);
    }
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
      win.setIgnoreMouseEvents(false);
    };
  });
  return () => restore.forEach((undo) => undo());
}
