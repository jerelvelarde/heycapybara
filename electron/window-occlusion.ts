import type { Rect } from "../server/screenshots";

// The helper's ring is 48 points wide, so a window whose edge is within this
// margin of the point would still hide part of it.
const RING_MARGIN = 32;

export function coversPoint(bounds: Rect, point: { x: number; y: number }) {
  return (
    point.x >= bounds.x - RING_MARGIN &&
    point.x < bounds.x + bounds.width + RING_MARGIN &&
    point.y >= bounds.y - RING_MARGIN &&
    point.y < bounds.y + bounds.height + RING_MARGIN
  );
}
