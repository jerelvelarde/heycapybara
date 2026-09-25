import type { ScreenshotAttachment } from "./types";

const PNG_DATA_URL = "data:image/png;base64";

// The model never sees the id on the image part - it rides along for the
// Codex adapter, which looks the capture up by this id and writes the id
// and pixel size into the image's note. Without it, the image gets the
// "no screen reference" note instead.
export function userContent(
  prompt: string,
  image: ScreenshotAttachment | null,
) {
  if (!image) return prompt;
  const commaIndex = image.dataUrl.indexOf(",");
  const prefix =
    commaIndex === -1 ? image.dataUrl : image.dataUrl.slice(0, commaIndex);
  const data = commaIndex === -1 ? "" : image.dataUrl.slice(commaIndex + 1);
  if (prefix !== PNG_DATA_URL || !data || data.includes(","))
    throw new Error("The screenshot attachment is not a PNG data URL");
  return [
    { type: "text" as const, text: prompt },
    { type: "binary" as const, mimeType: "image/png", data, id: image.id },
  ];
}

// Electron's ipcRenderer.invoke wraps a rejected handler's error as
// `Error invoking remote method '<channel>': Error: <message>`; this peels
// both layers off so the carefully worded capture errors reach the user
// unmangled.
const IPC_INVOKE_PREFIX = /^Error invoking remote method '[^']*':\s*/;
const NESTED_ERROR_PREFIX = /^Error:\s*/;

export function ipcErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  let message = error.message;
  if (IPC_INVOKE_PREFIX.test(message))
    message = message
      .replace(IPC_INVOKE_PREFIX, "")
      .replace(NESTED_ERROR_PREFIX, "");
  return message || fallback;
}
