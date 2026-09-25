import { randomBytes } from "node:crypto";

export type Rect = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };
// `bounds` are display points at capture time; `width`/`height` are the PNG's
// pixels.
export type Screenshot = Readonly<{
  id: string;
  displayId: string;
  label: string;
  bounds: Readonly<Rect>;
  width: number;
  height: number;
  capturedAt: number;
}>;

// Codex re-encodes prompt images outside these limits (codex-rs utils/image,
// PromptImageMode::HIGH_DETAIL). A resized image no longer matches the pixel
// size we give the model, so every capture must fit them. Checked against
// codex 0.156.1; recheck on upgrade. Codex core's `image_preparation` picks
// HIGH_DETAIL by default, but its unified_image_budget feature instead uses
// the larger ORIGINAL_DETAIL limits, which these captures also fit.
const MAX_DIMENSION = 2048;
const MAX_PATCHES = 2500;
const PATCH_SIZE = 32;

// Keeps headroom below the 2048 px limit above.
const CAPTURE_MAX_DIMENSION = 1920;

// Captures older than this are refused as stale.
const MAX_AGE_MS = 10 * 60 * 1000;

export function fitsPromptBudget({ width, height }: Size) {
  return (
    width <= MAX_DIMENSION &&
    height <= MAX_DIMENSION &&
    Math.ceil(width / PATCH_SIZE) * Math.ceil(height / PATCH_SIZE) <=
      MAX_PATCHES
  );
}

export function captureSize(display: Size): Size {
  if (!(
    Number.isFinite(display.width) &&
    Number.isFinite(display.height) &&
    display.width > 0 &&
    display.height > 0
  ))
    throw new Error(`Invalid display size ${display.width}×${display.height}`);
  let scale = Math.min(
    1,
    CAPTURE_MAX_DIMENSION / Math.max(display.width, display.height),
  );
  // Shrinks 2% at a time until the image fits the prompt budget, landing
  // slightly under the largest size within the 1920 px cap that Codex passes
  // through unchanged.
  for (;;) {
    const size = {
      width: Math.max(1, Math.floor(display.width * scale)),
      height: Math.max(1, Math.floor(display.height * scale)),
    };
    if (fitsPromptBudget(size)) return size;
    scale *= 0.98;
  }
}

export function exceeds(size: Size, limit: Size) {
  return size.width > limit.width || size.height > limit.height;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IHDR = [0x49, 0x48, 0x44, 0x52];

export function pngSize(png: Uint8Array): Size {
  if (
    png.length < 24 ||
    PNG_SIGNATURE.some((byte, index) => png[index] !== byte) ||
    IHDR.some((byte, index) => png[12 + index] !== byte)
  )
    throw new Error("Screen capture is not a PNG image");
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width === 0 || height === 0)
    throw new Error("Screen capture is not a PNG image");
  return { width, height };
}

export type Thumbnail = {
  toPNG(): Buffer;
  resize(size: Size): { toPNG(): Buffer };
};

// Electron can return a thumbnail larger than requested, for example at 2x.
// Resizing to the target keeps the image at captureSize's target: one pixel
// per point when that fits the budget, smaller otherwise.
export function fitThumbnail(thumbnail: Thumbnail, target: Size) {
  let png = thumbnail.toPNG();
  if (exceeds(pngSize(png), target)) png = thumbnail.resize(target).toPNG();
  const size = pngSize(png);
  if (!fitsPromptBudget(size))
    throw new Error(
      `Screen capture is still ${size.width}×${size.height} after resizing, which is too large for the model`,
    );
  return { png, size };
}

export class ScreenshotRegistry {
  private entries = new Map<string, Screenshot>();
  constructor(
    private readonly limit = 16,
    private readonly now = () => Date.now(),
  ) {
    if (!Number.isInteger(limit) || limit < 1)
      throw new Error("The screenshot registry must keep at least one capture");
  }
  add(input: Omit<Screenshot, "id" | "capturedAt">): Screenshot {
    const { width, height, bounds } = input;
    if (!(
      Number.isInteger(width) &&
      width > 0 &&
      Number.isInteger(height) &&
      height > 0 &&
      fitsPromptBudget({ width, height }) &&
      Number.isFinite(bounds.x) &&
      Number.isFinite(bounds.y) &&
      Number.isFinite(bounds.width) &&
      Number.isFinite(bounds.height) &&
      bounds.width > 0 &&
      bounds.height > 0
    ))
      throw new Error(
        "A screen capture needs whole-pixel positive dimensions within the model's image budget",
      );
    let id: string;
    // Must match server/point-schema.ts screenshotIdSchema (shot_ followed by
    // 8 lowercase hex characters).
    do id = "shot_" + randomBytes(4).toString("hex");
    while (this.entries.has(id));
    const shot: Screenshot = Object.freeze({
      ...input,
      bounds: Object.freeze({ ...input.bounds }),
      id,
      capturedAt: this.now(),
    });
    this.entries.set(id, shot);
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.limit) break;
      this.entries.delete(oldest);
    }
    return shot;
  }
  get(id: string) {
    return this.entries.get(id);
  }
}

export type ScreenshotLookup = Pick<ScreenshotRegistry, "get">;

export function sameBounds(a: Rect, b: Rect) {
  return (
    a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
  );
}

export function screenPoint(
  shot: Screenshot,
  point: { x: number; y: number },
  current: Rect | undefined,
  now = Date.now(),
) {
  if (!isFresh(shot, now)) {
    const age = now - shot.capturedAt;
    if (age < 0)
      throw new Error(
        "That screenshot's capture time is in the future, so the clock changed since it was taken. Ask the user to attach a new one.",
      );
    throw new Error(
      `That screenshot is more than ${MAX_AGE_MS / 60000} minutes old. Ask the user to attach a new one.`,
    );
  }
  if (!current)
    throw new Error(
      `${shot.label} is no longer connected. Ask the user to attach a new screenshot.`,
    );
  const { bounds } = shot;
  if (!sameBounds(current, bounds))
    throw new Error(
      `${shot.label} changed position or resolution since the screenshot. Ask the user to attach a new one.`,
    );
  if (
    !(point.x >= 0 && point.x < shot.width) ||
    !(point.y >= 0 && point.y < shot.height)
  )
    throw new Error(
      `(${point.x}, ${point.y}) is outside the ${shot.width}×${shot.height} screenshot.`,
    );
  // Snaps to the pixel the point falls in, then targets its centre: the
  // helper's hit test treats a display's top edge as outside (Cocoa maxY is
  // exclusive after its y-flip), so an uncentred row 0 would miss. Flooring
  // first keeps a fractional point in the last pixel from spilling past the
  // far edge.
  return {
    x: bounds.x + ((Math.floor(point.x) + 0.5) * bounds.width) / shot.width,
    y: bounds.y + ((Math.floor(point.y) + 0.5) * bounds.height) / shot.height,
  };
}

// A negative age means the clock moved backwards since the capture, so its
// age is unknown and it is treated as stale.
export function isFresh(shot: Screenshot, now = Date.now()) {
  const age = now - shot.capturedAt;
  return age >= 0 && age <= MAX_AGE_MS;
}

export function resolvePoint(
  lookup: ScreenshotLookup,
  displays: readonly { id: number | string; bounds: Rect }[],
  request: { screenshotId: string; x: number; y: number },
  now = Date.now(),
) {
  const shot = lookup.get(request.screenshotId);
  if (!shot)
    throw new Error(
      `No screenshot ${request.screenshotId} is available; it may have been replaced by newer captures or the app restarted. Check the id, or ask the user to attach a new screenshot.`,
    );
  const display = displays.find(
    (candidate) => String(candidate.id) === shot.displayId,
  );
  return { shot, point: screenPoint(shot, request, display?.bounds, now) };
}

// The Codex SDK joins every text part into one prompt and passes images
// separately, in order, so each note names its image by position. Codex
// itself labels each one `[Image #N]` in that same order, so the numbers
// line up with what the model sees.
export function describeScreenshot(shot: Screenshot, imageNumber: number) {
  return `Image ${imageNumber} in this message is screenshot ${shot.id} of ${shot.label}, ${shot.width}×${shot.height} pixels. To point at something in it, call point_on_screen with screenshotId "${shot.id}", a short label, and x, y in that image's pixels (origin at the top-left, x rightward, y downward).`;
}

export function unreferencedImageNote(imageNumber: number) {
  return `Image ${imageNumber} in this message has no screen reference, so point_on_screen cannot target it.`;
}

export function staleImageNote(imageNumber: number) {
  return `Image ${imageNumber} in this message is a screenshot that is too old to point at. Ask the user to attach a new one if you need to point.`;
}
