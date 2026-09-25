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
