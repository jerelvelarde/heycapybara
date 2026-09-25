export type ApprovalPrompt = { message: string; detail?: string };

export type ApprovalDialogOptions = {
  type: "question";
  title: string;
  message: string;
  detail?: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
};

// A window that can host the approval dialog as an attached sheet.
export type SheetHost = { isVisible(): boolean; isDestroyed(): boolean };

// Picks which OpenMuse window should host the approval sheet. The companion
// chat wins when it's on screen; otherwise the sheet falls back to the main
// workspace window, and `mustShow` tells the caller to bring that window on
// screen first, since a hidden window can't host a sheet.
export function approvalHost<W extends SheetHost>(
  companionChat: W,
  workspace: W,
): { host: W; mustShow: boolean } {
  if (!companionChat.isDestroyed() && companionChat.isVisible()) {
    return { host: companionChat, mustShow: false };
  }
  return { host: workspace, mustShow: !workspace.isVisible() };
}

export type ApprovalDeps = {
  // Makes OpenMuse the active app even when another app is in front.
  activate(): void;
  // Must attach the box to a visible OpenMuse window as a sheet: on macOS, a
  // message box with no parent window blocks the whole main process until
  // it's answered.
  showMessageBox(options: ApprovalDialogOptions): Promise<{ response: number }>;
};

export async function askApproval(prompt: ApprovalPrompt, deps: ApprovalDeps) {
  // Shown as a sheet attached to a visible OpenMuse window, never as a
  // free-floating alert. A parentless message box on macOS runs its own
  // synchronous loop until it's answered, which would stall the in-process
  // runtime server, the MCP endpoint, every IPC handler, and all timers for
  // as long as the prompt stays open.
  //
  // OpenMuse activates first and bounces its Dock icon until it becomes the
  // active app, so the sheet can't end up hidden behind whatever app the
  // user is currently in.
  //
  // macOS never shows a message box's `title`, so the prompt's `message`
  // itself has to say the agent is asking. `title` is kept for the other
  // platforms that do show it.
  //
  // Cancel is both the default button and the cancel button. Electron binds
  // Escape to the cancel button last, which overrides that same button's
  // Return binding from being the default - so Escape declines, and Return
  // does nothing. Return can never allow the action.
  deps.activate();
  const result = await deps.showMessageBox({
    type: "question",
    title: "OpenMuse wants to take an action",
    message: prompt.message,
    detail: prompt.detail,
    buttons: ["Cancel", "Allow once"],
    defaultId: 0,
    cancelId: 0,
  });
  return result.response === 1;
}
