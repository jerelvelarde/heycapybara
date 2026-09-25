import type { Rect } from "../server/screenshots";

// The helper centres a 48-point ring panel on the point (native/Recorder.swift
// --point), so a window within 24 points of it sits under the ring, and the
// extra 8 points keep the target's surroundings visible too. The ring draws
// above our windows at screen-saver level, so this clears the target, not
// the ring.
export const RING_MARGIN = 32;

// The left and top edges of the margin are inclusive (>=); the right and
// bottom are exclusive (<). See the paired boundary tests in
// tests/window-occlusion.test.ts for each edge.
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

// Buddy and companion chat windows are made transparent: true and
// frameless. Electron's only call site for setIgnoresMouseEvents: is
// SetIgnoreMouseEvents (Electron v44.4.5's shell/browser/native_window_mac.mm);
// it never runs at window creation, so these windows start out on AppKit's
// default, where clicks pass straight through their clear pixels and land on
// their opaque ones. That default holds only until something calls
// setIgnoreMouseEvents on the window, true or false either one; once called,
// the window stops doing that per-pixel test and instead goes uniform: false
// makes it hit-test its whole frame, including the clear pixels; true makes
// it ignore its whole frame, including the opaque ones. There is no API to
// get the per-pixel default back.
// markTransparent records which windows conceal() must never call it on.
const transparentWindows = new WeakSet<ConcealableWindow>();
export function markTransparent(win: ConcealableWindow) {
  transparentWindows.add(win);
}

// Fades in progress, keyed by window identity, so overlapping conceal() calls
// on the same window nest instead of clobbering each other's recorded
// opacity. `ignoredMouse` records whether this fade actually called
// setIgnoreMouseEvents(true), so undoFade can undo exactly that action
// later instead of re-deciding from transparentWindows' membership at
// restore time. That membership could in principle change while a window is
// still faded -- main.ts would have to call markTransparent() on a window
// after conceal() had already started fading it, rather than in the
// factory that creates it, which is where every call site marks a window
// today -- so this case is hypothetical, but the record makes it safe
// either way.
const fades = new WeakMap<
  ConcealableWindow,
  { count: number; opacity: number; ignoredMouse: boolean }
>();

// Fading a window out instead of hiding it keeps its focus, visibility,
// stacking and Space, and keeps any sheet attached to it open: hiding a
// window ends its sheet (NativeWindowMac::Hide), which an open approval
// prompt on it must not do. A sheet is a separate window of its own either
// way, so fading never touches it: an open folder-picker or export sheet can
// still show up in a capture or sit over a pointer target.
//
// Every window not marked transparent gets setIgnoreMouseEvents toggled true
// for the duration of the fade and back to false on restore.
// A marked window is never touched that way in either direction, because
// calling setIgnoreMouseEvents on it even once would cost it its per-pixel
// click-through for good (see markTransparent above). The trade-off: while
// faded, a marked window keeps hit-testing its opaque pixels instead of
// going fully click-through like the others.
//
// Fades nest: the screenshot capture and the pointer can overlap across the
// workspace and companion chat's separate conversations, so a window gets its
// original opacity back only when the last fade covering it ends.
function fadeOut(win: ConcealableWindow): void {
  const existing = fades.get(win);
  if (existing && existing.count > 0) {
    existing.count += 1;
    return;
  }
  // Either no record yet, or undoFade left one behind with count 0 after a
  // failed restore: the window is still stuck at opacity 0, possibly still
  // ignoring mouse events too (see undoFade below), so this is a retry, not
  // a no-op. Re-fade exactly as a fresh fade would, reusing the record's
  // opacity when there is one -- it is the window's TRUE original opacity
  // from before it was ever faded, not the stuck 0 that win.getOpacity()
  // would read back right now.
  const opacity = existing ? existing.opacity : win.getOpacity();
  // Decided fresh, from transparentWindows' membership at the moment this
  // fade starts, whether this is a brand new fade or a retry. Recorded in
  // the fade entry so undoFade later undoes exactly this decision rather
  // than re-reading membership at restore time (see the `fades` comment
  // above for why that would be hypothetical today, but still safe).
  const ignoredMouse = !transparentWindows.has(win);
  fades.set(win, { count: 1, opacity, ignoredMouse });
  let opacityChanged = false;
  try {
    win.setOpacity(0);
    opacityChanged = true;
    if (ignoredMouse) win.setIgnoreMouseEvents(true);
  } catch (error) {
    if (!opacityChanged) {
      // setOpacity(0) itself is what threw, so nothing on the window
      // actually changed this time. A retry (existing is set) must keep
      // carrying its TRUE original opacity forward for the next attempt,
      // so put that same record back rather than deleting it -- deleting it
      // here would lose that value for good, leaving a later fadeOut()
      // read back the window's current, stuck opacity and record that as
      // "original" instead. A genuinely fresh fade has no such record to
      // preserve.
      if (existing) fades.set(win, existing);
      else fades.delete(win);
    } else {
      // setOpacity(0) landed but setIgnoreMouseEvents(true) then threw.
      // Try to put the opacity back rather than leave the window stuck
      // invisible. A second failure while undoing is swallowed so it
      // doesn't mask the original error, but then the window stays at
      // opacity 0 with mouse events never actually ignored (that's the call
      // that threw): keep a count-0 record with the TRUE original opacity
      // so the next cycle retries instead of a fresh fadeOut() reading back
      // the stuck 0 and recording that as "original".
      let rolledBack = false;
      try {
        if (!win.isDestroyed()) win.setOpacity(opacity);
        rolledBack = true;
      } catch {
        // ignored: the error above takes precedence
      }
      if (rolledBack) fades.delete(win);
      else fades.set(win, { count: 0, opacity, ignoredMouse: false });
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
    if (win.isDestroyed()) {
      fades.delete(win);
      return;
    }
    // Restore opacity before touching mouse handling, as two separate steps
    // rather than a try/finally that always un-ignores afterwards. Either
    // call throwing leaves the record in place (count is already 0), with
    // its TRUE original opacity, so the next fadeOut()/undoFade() cycle
    // retries instead of a fresh fadeOut() reading back a stuck opacity and
    // recording that as "original":
    //  - if setOpacity fails, the window must stay exactly as fadeOut left
    //    it -- invisible, and still ignoring the mouse if fadeOut set that
    //    -- rather than un-ignore on top of a window stuck invisible, which
    //    would make it invisible AND clickable, worse than invisible and
    //    click-through;
    //  - if opacity comes back but setIgnoreMouseEvents(false) then fails,
    //    the window is visible again but stuck ignoring clicks; keeping the
    //    record (ignoredMouse still true) means the next cycle retries the
    //    un-ignore instead of there being no record left to catch it.
    win.setOpacity(fade.opacity);
    if (fade.ignoredMouse) win.setIgnoreMouseEvents(false);
    fades.delete(win);
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
