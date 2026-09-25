type Rectangle = { x: number; y: number; width: number; height: number };
type Size = { width: number; height: number };
type Point = { x: number; y: number };

export function notchPosition(
  display: { bounds: Rectangle; workArea: Rectangle },
  topInset: number,
  size: Size,
): Point {
  const { bounds, workArea } = display;
  const safeTop =
    bounds.y + (Number.isFinite(topInset) && topInset > 0 ? topInset : 0);
  return {
    x: Math.round(bounds.x + Math.max(0, (bounds.width - size.width) / 2)),
    y: Math.round(Math.max(safeTop, workArea.y)),
  };
}
