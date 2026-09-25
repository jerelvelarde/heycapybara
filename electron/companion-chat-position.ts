import type { WorkArea } from "./buddy-position";

export const CHAT_SIZE = { width: 380, height: 320 };
export const RECORD_SIZE = { width: 320, height: 220 };
const GAP = 10;

export function companionTrayPosition(
  buddy: WorkArea,
  areas: WorkArea[],
  size: { width: number; height: number },
) {
  if (!areas.length) throw new Error("No display available for companion tray");
  const center = {
    x: buddy.x + buddy.width / 2,
    y: buddy.y + buddy.height / 2,
  };
  const area =
    areas.find(
      (candidate) =>
        center.x >= candidate.x &&
        center.x < candidate.x + candidate.width &&
        center.y >= candidate.y &&
        center.y < candidate.y + candidate.height,
    ) ?? areas[0];
  const below = buddy.y + buddy.height + GAP;
  const above = buddy.y - size.height - GAP;
  const fitsBelow = below + size.height <= area.y + area.height;
  const fitsAbove = above >= area.y;
  const preferredY = fitsBelow ? below : fitsAbove ? above : below;
  return {
    x: Math.round(
      Math.max(
        area.x,
        Math.min(center.x - size.width / 2, area.x + area.width - size.width),
      ),
    ),
    y: Math.round(
      Math.max(
        area.y,
        Math.min(preferredY, area.y + area.height - size.height),
      ),
    ),
  };
}
