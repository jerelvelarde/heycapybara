import { randomBytes } from "node:crypto";

export type Rect = { x: number; y: number; width: number; height: number };
export type Size = { width: number; height: number };
export type Screenshot = {
  id: string;
  displayId: string;
  label: string;
  bounds: Rect;
  width: number;
  height: number;
  capturedAt: number;
};

// Codex re-encodes prompt images outside these limits (codex-rs utils/image,
// PromptImageMode::HIGH_DETAIL). A resized image no longer matches the pixel
// size we give the model, so every capture must fit them.
const MAX_DIMENSION = 2048;
const MAX_PATCHES = 2500;
const PATCH_SIZE = 32;
const CAPTURE_MAX_DIMENSION = 1920;
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
    throw new Error("Invalid display size");
  let scale = Math.min(
    1,
    CAPTURE_MAX_DIMENSION / Math.max(display.width, display.height),
  );
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
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

export class ScreenshotRegistry {
  private entries = new Map<string, Screenshot>();
  constructor(
    private readonly limit = 16,
    private readonly now = () => Date.now(),
  ) {}
  add(input: Omit<Screenshot, "id" | "capturedAt">): Screenshot {
    let id: string;
    do id = "shot_" + randomBytes(4).toString("hex");
    while (this.entries.has(id));
    const shot = {
      ...input,
      bounds: { ...input.bounds },
      id,
      capturedAt: this.now(),
    };
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

export function screenPoint(
  shot: Screenshot,
  point: { x: number; y: number },
  current: Rect | undefined,
  now = Date.now(),
) {
  if (now - shot.capturedAt > MAX_AGE_MS)
    throw new Error(
      "That screenshot is more than 10 minutes old. Ask the user to attach a new one.",
    );
  if (!current)
    throw new Error(
      `${shot.label} is no longer connected. Ask the user to attach a new screenshot.`,
    );
  const { bounds } = shot;
  if (
    current.x !== bounds.x ||
    current.y !== bounds.y ||
    current.width !== bounds.width ||
    current.height !== bounds.height
  )
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
  // Target the centre of the pixel so edge pixels stay inside the display.
  return {
    x: bounds.x + ((Math.floor(point.x) + 0.5) * bounds.width) / shot.width,
    y: bounds.y + ((Math.floor(point.y) + 0.5) * bounds.height) / shot.height,
  };
}

// The Codex SDK joins every text part into one prompt and passes images
// separately, in order, so each note names its image by position.
export function describeScreenshot(shot: Screenshot, imageNumber: number) {
  return `Image ${imageNumber} in this message is screenshot ${shot.id} of ${shot.label}, ${shot.width}×${shot.height} pixels. To point at something in it, call point_on_screen with screenshotId "${shot.id}", a short label, and x, y in that image's pixels (origin at the top-left, x rightward, y downward).`;
}

export function unreferencedImageNote(imageNumber: number) {
  return `Image ${imageNumber} in this message has no screen reference, so point_on_screen cannot target it.`;
}
