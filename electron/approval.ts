export type ApprovalPrompt = { message: string; detail?: string };

export type ApprovalDialogOptions = {
  type: "question";
  title: string;
  message: string;
  detail?: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  // Aborting it closes the box as if Cancel were pressed. Electron supports
  // it only for a box attached to a parent window.
  signal?: AbortSignal;
};

// A window that can host the approval dialog as an attached sheet.
export type SheetHost = { isVisible(): boolean; isDestroyed(): boolean };

// Picks which OpenMuse window should host the approval sheet. The companion
// chat wins when it's on screen; otherwise the sheet falls back to the main
// workspace window, and `mustShow` tells the caller to bring that window on
// screen first, so the user can see the sheet. Only quitting destroys the
// workspace, so there is nothing left to ask on then.
export function approvalHost<W extends SheetHost>({
  companionChat,
  workspace,
}: {
  companionChat: W;
  workspace: W;
}): { host: W; mustShow: boolean } {
  if (!companionChat.isDestroyed() && companionChat.isVisible()) {
    return { host: companionChat, mustShow: false };
  }
  if (workspace.isDestroyed()) throw new Error("OpenMuse is closing.");
  return { host: workspace, mustShow: !workspace.isVisible() };
}

export type ApprovalDeps = {
  // Makes OpenMuse the active app even when another app is in front.
  activate(): void;
  // Must attach the box to an OpenMuse window as a sheet: on macOS, a
  // message box with no parent window blocks the whole main process until
  // it's answered.
  showMessageBox(options: ApprovalDialogOptions): Promise<{ response: number }>;
  // Read once the box has resolved: whether the window hosting the sheet
  // went away while it was open. Hiding a window ends its sheet as if Cancel
  // were pressed, so this is what tells that apart from a real Cancel.
  // Left out, every Cancel counts as the user's answer.
  hostHidden?(): boolean;
};

// The model reads this message, not the user, so it must say not to retry
// rather than invite one - a bare "declined" leaves the model free to ask
// again right away. `electron/main.ts` throws this for a declined open-app
// request. `electron/point-action.ts` has its own separate literal for a
// declined point and is not wired to this constant.
export const DECLINED_MESSAGE =
  "The user declined. Don't retry unless they ask.";

// Stop, or the MCP call timing out, can cancel the request after the user
// allowed it but before the action runs. The action must not run then.
export function throwIfCancelled(signal?: AbortSignal) {
  if (signal?.aborted)
    throw new Error("The request was cancelled before the action ran.");
}

export async function askApproval(
  prompt: ApprovalPrompt,
  deps: ApprovalDeps,
  signal?: AbortSignal,
) {
  // Shown as a sheet attached to an OpenMuse window, never as a
  // free-floating alert. A parentless message box on macOS runs its own
  // synchronous loop until it's answered, which would stall the in-process
  // runtime server, the MCP endpoint, every IPC handler, and all timers for
  // as long as the prompt stays open.
  //
  // OpenMuse activates first, so the sheet doesn't open behind whatever app
  // the user is in (approve in main.ts also bounces the Dock icon when the
  // sheet is on the workspace, the only host another app's windows can
  // cover).
  //
  // macOS never shows a message box's `title`, so the prompt's `message`
  // itself has to say the agent is asking. `title` is kept for the other
  // platforms that do show it.
  //
  // Cancel is both the default button and the cancel button. Electron binds
  // Escape to the cancel button last, which overrides that same button's
  // Return binding from being the default - so Escape declines, and Return
  // does nothing. Return can never allow the action.
  //
  // Only "Allow once" approves. Everything else that closes the box
  // resolves as Cancel: the signal aborting, and the host window hiding,
  // which ends its sheet. Neither is the user declining, so each gets its
  // own error instead of reading as "no". A request that is already
  // cancelled never activates OpenMuse or shows the box at all.
  if (signal?.aborted)
    throw new Error("The request was cancelled before the user answered.");
  deps.activate();
  const { response } = await deps.showMessageBox({
    type: "question",
    title: "OpenMuse wants to take an action",
    message: prompt.message,
    detail: prompt.detail,
    buttons: ["Cancel", "Allow once"],
    defaultId: 0,
    cancelId: 0,
    ...(signal ? { signal } : {}),
  });
  if (response === 1) return true;
  if (signal?.aborted)
    throw new Error("The request was cancelled before the user answered.");
  if (deps.hostHidden?.())
    throw new Error(
      "The approval prompt closed before the user answered. Don't retry unless the user asks again.",
    );
  return false;
}
