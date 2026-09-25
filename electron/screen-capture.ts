import {
  type Rect,
  type Screenshot,
  type Size,
  captureSize,
  fitThumbnail,
  sameBounds,
} from "../server/screenshots";
import type { ScreenshotAttachment } from "../src/types";

export type CaptureSource = {
  display_id: string;
  thumbnail: { isEmpty(): boolean; toPNG(): Buffer };
};

export type CaptureDeps = {
  screenCaptureAllowed(): Promise<boolean>;
  primaryDisplay(): { id: number; label: string; size: Size; bounds: Rect };
  displays(): { id: number; bounds: Rect }[];
  conceal(): () => void; // fades the visible OpenMuse windows, returns restore
  wait(ms: number): Promise<void>;
  sources(target: Size): Promise<CaptureSource[]>;
  rebuild(png: Buffer, size: Size): Buffer;
  register(input: Omit<Screenshot, "id" | "capturedAt">): Screenshot;
  sourcesTimeoutMs: number;
};

// Shares one in-flight run across every overlapping caller, and clears it
// once that run settles so the next call after it starts a fresh one.
export function singleFlight<T>(run: () => Promise<T>): () => Promise<T> {
  let inFlight: Promise<T> | undefined;
  return () => {
    if (inFlight) return inFlight;
    const started = run().finally(() => {
      inFlight = undefined;
    });
    inFlight = started;
    return started;
  };
}

// Rejects with `message` if `promise` hasn't settled within `ms`. Clears its
// timer either way, so a promise that settles first doesn't leave a pending
// timer behind. It cannot cancel `promise` itself: if the timeout wins, the
// original call (e.g. getSources) keeps running in the background, and
// whatever it eventually settles with is simply dropped.
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function captureScreenshot(
  deps: CaptureDeps,
): Promise<ScreenshotAttachment> {
  if (!(await deps.screenCaptureAllowed()))
    throw new Error(
      "Allow Screen Recording for OpenMuse Desktop in System Settings > Privacy & Security > Screen & System Audio Recording, then quit and reopen OpenMuse Desktop.",
    );
  const display = deps.primaryDisplay();
  const target = captureSize(display.size);
  const restore = deps.conceal();
  // The CaptureDeps contract doesn't promise conceal()'s returned restore is
  // safe to call twice, so this runs it at most once regardless of what the
  // caller plugged in: the explicit call below, right after the pixels are
  // captured, or this fallback if something fails before that point.
  let restored = false;
  const restoreOnce = () => {
    if (restored) return;
    restored = true;
    restore();
  };
  try {
    // 200ms gives the compositor time to actually drop the concealed
    // windows before we capture. A timer guarantees no frames at all, only
    // elapsed time, so this is a heuristic margin, not a frame count. Do not
    // shorten it.
    await deps.wait(200);
    const sources = await withTimeout(
      deps.sources(target),
      deps.sourcesTimeoutMs,
      "Screen capture didn't respond. Try again, or quit and reopen OpenMuse Desktop.",
    );
    // The pixels are already captured, so the concealed windows can come
    // back now rather than staying invisible through the PNG work and the
    // display re-check below. A failure here is rethrown below rather than
    // swallowed: a window stuck invisible matters, and nothing has been
    // registered yet for it to invalidate.
    restoreOnce();
    // A capture of another display would put the pointer in the wrong place.
    const source = sources.find(
      (candidate) => candidate.display_id === String(display.id),
    );
    if (!source)
      throw new Error(
        `Couldn't find a screen source for ${display.label || "Main display"}. Try again, or reconnect the display.`,
      );
    if (source.thumbnail.isEmpty())
      throw new Error(
        "Screen capture came back empty. If you just granted Screen Recording, quit and reopen OpenMuse Desktop.",
      );
    // A 2x capture needs rebuilding at the target's own pixel size, not a
    // plain resize; main.ts holds the concrete `rebuild` implementation,
    // and fitThumbnail below is this file's call site for it.
    const rawPng = source.thumbnail.toPNG();
    const { png, size } = fitThumbnail(
      {
        toPNG: () => rawPng,
        resize: (resizeTarget) => ({
          toPNG: () => deps.rebuild(rawPng, resizeTarget),
        }),
      },
      target,
    );
    // The display can change while we waited and captured; catch it here
    // rather than register bounds that no longer match the image.
    const current = deps
      .displays()
      .find((candidate) => candidate.id === display.id);
    if (!current || !sameBounds(current.bounds, display.bounds))
      throw new Error("The display changed during the capture. Try again.");
    const shot = deps.register({
      displayId: String(display.id),
      label: display.label || "Main display",
      bounds: display.bounds,
      ...size,
    });
    return {
      id: shot.id,
      label: shot.label,
      width: size.width,
      height: size.height,
      dataUrl: "data:image/png;base64," + png.toString("base64"),
    };
  } catch (error) {
    // Most failures land here after the explicit restore above already ran
    // and succeeded (no source for the display, an empty thumbnail, a
    // display change, or a failed register), so restoreOnce() below is then
    // just a no-op guard. The rarer case is a failure before that restore
    // ran, or the restore call itself failing; either way, the original
    // error is why the capture failed and is what the caller needs to see,
    // so a broken restore on top of that is swallowed rather than replacing
    // it.
    try {
      restoreOnce();
    } catch {
      // ignored: the error above takes precedence
    }
    throw error;
  }
}
