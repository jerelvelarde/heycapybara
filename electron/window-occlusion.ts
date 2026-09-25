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

// Fading a window out instead of hiding it keeps its focus, visibility,
// stacking and Space, and leaves any sheet on it open. No OpenMuse window
// ignores mouse events today, so restoring sets that back to false.
export function conceal(windows: ConcealableWindow[]) {
  const restore = windows.map((win) => {
    const opacity = win.getOpacity();
    win.setOpacity(0);
    win.setIgnoreMouseEvents(true);
    return () => {
      if (win.isDestroyed()) return;
      win.setOpacity(opacity);
      win.setIgnoreMouseEvents(false);
    };
  });
  return () => restore.forEach((undo) => undo());
}
