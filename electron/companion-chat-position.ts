import type { WorkArea } from "./buddy-position";

export const CHAT_SIZE = { width: 380, height: 500 };
const GAP = 12;

export function companionChatPosition(buddy: WorkArea, areas: WorkArea[]) {
  if (!areas.length) throw new Error("No display available for chat");
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
  const right = buddy.x + buddy.width + GAP;
  const left = buddy.x - CHAT_SIZE.width - GAP;
  const x =
    right + CHAT_SIZE.width <= area.x + area.width
      ? right
      : left >= area.x
        ? left
        : Math.max(
            area.x,
            Math.min(right, area.x + area.width - CHAT_SIZE.width),
          );
  const y = Math.max(
    area.y,
    Math.min(
      buddy.y + buddy.height - CHAT_SIZE.height,
      area.y + area.height - CHAT_SIZE.height,
    ),
  );
  return { x: Math.round(x), y: Math.round(y) };
}
