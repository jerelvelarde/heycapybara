import type { Rect } from "../server/screenshots";
import { pointPrompt } from "../server/point-schema";
import { coversPoint } from "./window-occlusion";

export type PointWindow = {
  isVisible(): boolean;
  getBounds(): Rect;
  hide(): void;
  showInactive(): void;
};

export type PointActionDeps = {
  resolve(): { shot: { label: string }; point: { x: number; y: number } };
  confirm(prompt: { message: string; detail?: string }): Promise<boolean>;
  windows(): PointWindow[];
  showPointer(point: { x: number; y: number }): Promise<void>;
};

export async function performPointAction(label: string, deps: PointActionDeps) {
  // Resolve before asking so the user isn't asked to approve a point that already can't land.
  const { shot } = deps.resolve();
  if (!(await deps.confirm(pointPrompt(label, shot.label))))
    throw new Error("User declined action");
  // Resolve again: the display can change, or the screenshot expire, while the dialog is open.
  const { point } = deps.resolve();
  // Our own windows would cover the ring and the target it points at.
  const hidden = deps
    .windows()
    .filter((win) => win.isVisible() && coversPoint(win.getBounds(), point));
  hidden.forEach((win) => win.hide());
  try {
    await deps.showPointer(point);
  } finally {
    hidden.forEach((win) => win.showInactive());
  }
}
