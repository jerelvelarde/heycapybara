import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { crossedDragThreshold, type Point } from "../src/buddy-drag";
export type WorkArea = Point & { width: number; height: number };
export const BUDDY_SIZE = { width: 240, height: 170 };
export function clampBuddyPosition(position: Point, areas: WorkArea[]): Point {
  if (!areas.length) throw new Error("No display available for companion");
  const candidates = areas.map((area) => ({
    x: Math.round(
      Math.max(
        area.x,
        Math.min(
          position.x,
          area.x + Math.max(0, area.width - BUDDY_SIZE.width),
        ),
      ),
    ),
    y: Math.round(
      Math.max(
        area.y,
        Math.min(
          position.y,
          area.y + Math.max(0, area.height - BUDDY_SIZE.height),
        ),
      ),
    ),
  }));
  return candidates.reduce((closest, point) =>
    Math.hypot(point.x - position.x, point.y - position.y) <
    Math.hypot(closest.x - position.x, closest.y - position.y)
      ? point
      : closest,
  );
}
export async function loadBuddyPosition(
  path: string,
): Promise<Point | undefined> {
  let data: string;
  try {
    data = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
  const value: unknown = JSON.parse(data);
  if (
    typeof value !== "object" ||
    value === null ||
    !("x" in value) ||
    !("y" in value) ||
    typeof value.x !== "number" ||
    typeof value.y !== "number" ||
    !Number.isFinite(value.x) ||
    !Number.isFinite(value.y)
  )
    throw new Error("Invalid saved companion position");
  return { x: value.x, y: value.y };
}
export async function saveBuddyPosition(path: string, position: Point) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + ".tmp";
  await writeFile(temporary, JSON.stringify(position), { mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

export type BuddyGesture = { cursor: Point; position: Point; moved: boolean };
export function beginBuddyGesture(
  cursor: Point,
  bounds: WorkArea,
): BuddyGesture {
  if (
    cursor.x < bounds.x ||
    cursor.y < bounds.y ||
    cursor.x > bounds.x + bounds.width ||
    cursor.y > bounds.y + bounds.height
  )
    throw new Error("Drag must begin inside the companion");
  return { cursor, position: { x: bounds.x, y: bounds.y }, moved: false };
}
export function advanceBuddyGesture(
  gesture: BuddyGesture,
  cursor: Point,
  areas: WorkArea[],
): Point | undefined {
  if (!gesture.moved && !crossedDragThreshold(gesture.cursor, cursor)) return;
  gesture.moved = true;
  return clampBuddyPosition(
    {
      x: gesture.position.x + cursor.x - gesture.cursor.x,
      y: gesture.position.y + cursor.y - gesture.cursor.y,
    },
    areas,
  );
}
