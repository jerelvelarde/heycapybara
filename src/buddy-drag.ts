export type Point = { x: number; y: number };
export function crossedDragThreshold(start: Point, current: Point) {
  return Math.hypot(current.x - start.x, current.y - start.y) >= 5;
}
