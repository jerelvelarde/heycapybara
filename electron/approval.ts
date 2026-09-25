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

export type ApprovalDeps = {
  // Makes OpenMuse the active app even when another app is in front.
  activate(): void;
  showMessageBox(options: ApprovalDialogOptions): Promise<{ response: number }>;
};

export async function askApproval(prompt: ApprovalPrompt, deps: ApprovalDeps) {
  // The alert has no parent window, so it doesn't depend on which OpenMuse
  // window is in front.
  // Electron shows a parentless alert with NSAlert's runModal, which doesn't
  // bring an inactive app forward. So OpenMuse activates first; otherwise the
  // alert can open behind the app the user is in.
  // Cancel is the default and cancel button, so a Return pressed while typing
  // declines.
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
