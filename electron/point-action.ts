import type { Rect } from "../server/screenshots";
import { pointPrompt } from "../server/point-schema";
import { throwIfCancelled, type ApprovalPrompt } from "./approval";
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
  // Returns the registry's own screenshot object, so the same capture is the
  // same object on every call (resolvePoint does).
  resolve(): { shot: { label: string }; point: { x: number; y: number } };
  confirm(prompt: ApprovalPrompt, signal?: AbortSignal): Promise<boolean>;
  windows(): PointWindow[];
  showPointer(point: { x: number; y: number }): Promise<void>;
};

export async function performPointAction(
  label: string,
  deps: PointActionDeps,
  signal?: AbortSignal,
) {
  // Resolve before asking so the user isn't asked to approve a point that already can't land.
  const approved = deps.resolve();
  if (!(await deps.confirm(pointPrompt(label, approved.shot.label), signal)))
    throw new Error("User declined action");
  throwIfCancelled(signal);
  // Resolve again: while the dialog is open, the display can change, or the
  // screenshot can expire or be evicted by newer captures.
  const { shot, point } = deps.resolve();
  // The user approved a pointer on the capture they attached. Replacing it
  // needs both an eviction of the old entry and a freshly issued random id
  // for the new one, but if it ever happened an id that then named another
  // capture would measure the point against an image they never attached.
  if (shot !== approved.shot)
    throw new Error(
      "That screenshot was replaced while the prompt was open. Ask the user to attach a new one.",
    );
  // The capture concealed our windows, so the model may be pointing at
  // something one of them now covers. The ring draws above them, so only
  // the target needs clearing.
  const covering = deps
    .windows()
    .filter((win) => win.isVisible() && coversPoint(win.getBounds(), point));
  const restore = conceal(covering);
  try {
    await deps.showPointer(point);
  } catch (error) {
    // The pointer's own failure is what the caller needs to see, so a
    // restore that also fails doesn't replace it.
    try {
      restore();
    } catch {
      // ignored: the showPointer error above takes precedence
    }
    throw error;
  }
  // The pointer already showed, so a restore failure here must not fail the
  // action: the model would likely retry, prompting the user again for a
  // pointer they already saw. window-occlusion.ts's undoFade keeps the fade
  // record on a failed restore, so a later conceal()/restore() cycle still
  // retries it.
  try {
    restore();
  } catch {
    // ignored: the user already saw the pointer, so this must not fail the
    // action; see the comment above.
  }
}
