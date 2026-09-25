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

function taskOf(messages: readonly ChatMessage[]) {
  const first = messages.find((message) => message.role === "user");
  const task = first ? messageText(first.content).trim() : "";
  if (!task) throw new Error("Send OpenMuse a task before teaching it.");
  return task;
}

/**
 * The user's verdict on a run, recorded with useLearnFromUserAction as a
 * `user_action` on the thread Intelligence already stores. Intelligence's
 * knowledge-base writer reads these. Only the first user turn's text (already
 * in that thread) is repeated; attachments are never sent again.
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
 * recalls it by meaning in the next conversation.
 */
export function lessonMemory(messages: readonly ChatMessage[]) {
  const task = taskOf(messages);
  const steps = messages
    .flatMap((message) =>
      message.role === "assistant" && message.toolCalls
        ? message.toolCalls.map((call) => call.function.name)
        : [],
    )
    .slice(0, 40);
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
  if (result)
    lines.push(
      `What OpenMuse reported when done: ${messageText(result.content).trim().slice(0, 2500)}`,
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
