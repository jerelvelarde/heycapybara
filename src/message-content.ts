import type { ScreenshotAttachment } from "./types";

const PNG_DATA_URL = "data:image/png;base64";

// Only a request that continues the composer's own thread may carry its
// pending screenshot. "Record to skill" and "Use this skill" start a fresh
// thread (fresh=true) and must never attach one - that would leak a screen
// capture into an Intelligence cloud thread the user never meant to send it
// to.
export function requestAttachment(
  fresh: boolean,
  image: ScreenshotAttachment | null,
): ScreenshotAttachment | null {
  return fresh ? null : image;
}

// Tags an in-flight screenshot capture with the epoch it started in, so a
// capture that resolves after the composer has moved on to something else -
// a send, a new conversation - can tell it's stale and drop both its result
// and its error instead of landing on the wrong message.
export function createEpoch() {
  let n = 0;
  return {
    advance() {
      n += 1;
    },
    capture() {
      const at = n;
      return () => at === n;
    },
  };
}

// The model never sees the id on the image part - it rides along for the
// Codex adapter, which looks the capture up by this id. The id and pixel
// size are written into the note only when that capture is known, matches
// this image, and is still fresh; otherwise the model gets the unknown,
// mismatched, or stale note instead.
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
// `Error invoking remote method '<channel>': <error.toString()>`, and
// `toString()` itself leads with the error's own constructor name (for
// example `TypeError: `). Each prefix is stripped only when present - the
// invoke wrapper, then any leading `<Name>Error: ` label - so the
// carefully worded capture errors reach the user unmangled no matter which
// of the two prefixes showed up.
const IPC_INVOKE_PREFIX = /^Error invoking remote method '[^']*':\s*/;
const ERROR_LABEL_PREFIX = /^(?:[A-Z][A-Za-z]*)?Error:\s*/;

export function ipcErrorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message
    .replace(IPC_INVOKE_PREFIX, "")
    .replace(ERROR_LABEL_PREFIX, "");
  return message || fallback;
}

// The text a chat bubble shows. An assistant message that only carries tool
// calls (server/codex-events.ts emits one per OpenMuse tool step) has no text
// and renders as its chips alone. A user message with a screenshot has no
// plain string content. A user message this long is a record-to-skill prompt.
export function displayText(message: {
  role: string;
  content?: unknown;
}): string | null {
  if (typeof message.content === "string") {
    if (!message.content) return null;
    return message.role === "user" && message.content.length > 2400
      ? message.content.slice(0, 240) + "\n[Reviewed recording attached]"
      : message.content;
  }
  return message.role === "user" ? "Screen context attached" : null;
}
