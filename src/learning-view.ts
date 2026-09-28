import type { LearningStatus } from "./types";

export type LearningStripView = {
  tone: "quiet" | "busy" | "action" | "success" | "error";
  text: string;
  action: { kind: "open"; label: string } | { kind: "try" } | null;
};

const OPEN_LABELS = {
  learning: "Open Intelligence",
  runs: "Analyze in Intelligence",
  candidates: "Review in Intelligence",
} as const;

export function openLabel(kind: keyof typeof OPEN_LABELS) {
  return OPEN_LABELS[kind];
}

/** What the one-line strip above the composer shows, or null to hide it. */
export function learningStrip(
  status: LearningStatus,
): LearningStripView | null {
  const open = status.link
    ? { kind: "open" as const, label: openLabel(status.link.kind) }
    : null;
  switch (status.phase) {
    case "off":
      return null;
    case "idle":
      return status.skills.length
        ? { tone: "quiet", text: status.message, action: null }
        : null;
    case "setup":
    case "error":
      return { tone: "error", text: status.message, action: open };
    case "waiting":
      return { tone: "action", text: status.message, action: open };
    case "analyzing":
      return { tone: "busy", text: status.message, action: null };
    case "review":
      return {
        tone: "action",
        text: status.insight
          ? `${status.message} Noticed: ${status.insight}`
          : status.message,
        action: open,
      };
    case "learned":
      return { tone: "success", text: status.message, action: { kind: "try" } };
  }
}

/** The part of an AG-UI message the lesson helpers read. */
export type ChatMessage = {
  role: string;
  content?: unknown;
  toolCalls?: readonly { function: { name: string } }[];
};

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type: "text"; text: string } =>
        !!part &&
        typeof part === "object" &&
        (part as { type?: unknown }).type === "text" &&
        typeof (part as { text?: unknown }).text === "string",
    )
    .map((part) => part.text)
    .join("\n");
}

const REDACTED = "[redacted]";
// A labelled secret: the label and separator stay, the value goes. A quoted
// value is taken whole; a bare one stops before trailing punctuation.
const LABELLED_SECRET =
  /\b(password|passcode|pin|token|secret|api[ _-]?key)(\s*[:=]\s*|\s+is\s+)("[^"]*"|'[^']*'|\S+?(?=[.,;!?]?(?:\s|$)))/gi;
const KEY_PREFIX =
  /\b(?:(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16})/g;
const LONG_HEX = /\b[0-9a-fA-F]{32,}\b/g;
const LONG_BASE64 = /[A-Za-z0-9+/_-]{40,}={0,2}/g;

/**
 * Replaces secret-shaped text with "[redacted]" before it is saved anywhere
 * Intelligence will recall it from. A long run counts as base64 only when it
 * mixes letters and digits, so a long word is left alone.
 */
export function redactSecrets(text: string) {
  return text
    .replace(
      LABELLED_SECRET,
      (_, label, separator) => label + separator + REDACTED,
    )
    .replace(KEY_PREFIX, REDACTED)
    .replace(LONG_HEX, REDACTED)
    .replace(LONG_BASE64, (run: string) =>
      /\d/.test(run) && /[A-Za-z]/.test(run) ? REDACTED : run,
    );
}

function taskOf(messages: readonly ChatMessage[]) {
  const first = messages.find((message) => message.role === "user");
  const task = first ? messageText(first.content).trim() : "";
  if (!task) throw new Error("Send OpenMuse a task before teaching it.");
  return redactSecrets(task);
}

/**
 * The user's verdict on a run, recorded with useLearnFromUserAction as a
 * `user_action` on the thread Intelligence already stores. Intelligence's
 * knowledge-base writer reads these. Only the first user turn's text (already
 * in that thread) is repeated, with secrets redacted; attachments are never
 * sent again.
 */
export function teachingAnnotation(
  messages: readonly ChatMessage[],
  threadId: string,
) {
  const task = taskOf(messages);
  return {
    threadId,
    title: "Taught OpenMuse a task",
    description: task.length > 500 ? task.slice(0, 499) + "…" : task,
    data: {
      outcome: "user-confirmed-success" as const,
      source: "openmuse-desktop" as const,
      userTurns: messages.filter((message) => message.role === "user").length,
    },
  };
}

/**
 * The lesson "Learn from this" saves to Intelligence Memory: the task, the
 * OpenMuse tools used in order (names only), and what OpenMuse reported when
 * done. Written by OpenMuse from the thread; Intelligence stores it and
 * recalls it by meaning in the next conversation. Secret-shaped text is
 * redacted, and the report is left out entirely when OpenMuse typed text,
 * since it may repeat what was typed.
 */
export function lessonMemory(messages: readonly ChatMessage[]) {
  const task = taskOf(messages);
  const tools = messages.flatMap((message) =>
    message.role === "assistant" && message.toolCalls
      ? message.toolCalls.map((call) => call.function.name)
      : [],
  );
  const steps = tools.slice(0, 40);
  const result = [...messages]
    .reverse()
    .find(
      (message) =>
        message.role === "assistant" && messageText(message.content).trim(),
    );
  const lines = [
    `How to: ${task.slice(0, 500)}`,
    "OpenMuse did this successfully and the user confirmed it worked.",
  ];
  if (steps.length)
    lines.push(`OpenMuse tools used, in order: ${steps.join(" → ")}.`);
  if (tools.includes("type_text"))
    lines.push("(final report omitted because text was typed)");
  else if (result)
    lines.push(
      `What OpenMuse reported when done: ${redactSecrets(messageText(result.content).trim()).slice(0, 2500)}`,
    );
  return lines.join("\n").slice(0, 4000);
}

/** The dot on the floating pet: learning, needs you, or something new. */
export function buddyLearningBadge(
  status: LearningStatus,
): "busy" | "attention" | "new" | null {
  if (status.phase === "analyzing") return "busy";
  if (status.phase === "waiting" || status.phase === "review")
    return "attention";
  if (status.phase === "learned") return "new";
  return null;
}
