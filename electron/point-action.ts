import type { Rect } from "../server/screenshots";
import { pointPrompt } from "../server/point-schema";
import {
  coversPoint,
  conceal,
  type ConcealableWindow,
} from "./window-occlusion";

export type PointWindow = ConcealableWindow & {
  isVisible(): boolean;
  getBounds(): Rect;
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
  // Resolve again: while the dialog is open, the display can change, or the
  // screenshot can expire or be evicted by newer captures.
  const { point } = deps.resolve();
  // The capture concealed our windows, so the model may be pointing at
  // something one of them now covers. The ring draws above them, so only
  // the target needs clearing.
  const covering = deps
    .windows()
    .filter((win) => win.isVisible() && coversPoint(win.getBounds(), point));
  const restore = conceal(covering);
  try {
    await deps.showPointer(point);
  } finally {
    restore();
  }
}
