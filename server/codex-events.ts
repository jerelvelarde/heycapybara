import { randomUUID } from "node:crypto";
import { EventType, type BaseEvent } from "@ag-ui/core";
import type { ThreadEvent } from "@openai/codex-sdk";

/**
 * An event OpenMuse's own runner emits next to Codex's, before a turn starts
 * (server/codex-agent.ts). It reaches the chat as one AG-UI custom event.
 */
export type KiteNotice = {
  type: "kite.notice";
  name: string;
  value: Record<string, unknown>;
};

export function codexEvents(event: ThreadEvent | KiteNotice): BaseEvent[] {
  if (event.type === "kite.notice")
    return [
      {
        type: EventType.CUSTOM,
        name: event.name,
        value: event.value,
      } as BaseEvent,
    ];
  if (event.type === "error" || event.type === "turn.failed")
    throw new Error(
      event.type === "error" ? event.message : event.error.message,
    );
  if (
    !["item.started", "item.updated", "item.completed"].includes(event.type) ||
    !("item" in event)
  )
    return [];
  const item = event.item;
  if (
    item.type === "agent_message" &&
    event.type === "item.completed" &&
    item.text
  ) {
    const messageId = randomUUID();
    return [
      { type: EventType.TEXT_MESSAGE_START, messageId, role: "assistant" },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: item.text },
      { type: EventType.TEXT_MESSAGE_END, messageId },
    ];
  }
  if (item.type === "reasoning" || item.type === "agent_message") return [];
  const summary =
    item.type === "command_execution"
      ? `Command ${item.status}: ${item.command}`
      : item.type === "file_change"
        ? `Files ${item.status}: ${item.changes.map((c) => c.path).join(", ")}`
        : item.type === "mcp_tool_call"
          ? `${item.tool}: ${item.status}`
          : item.type === "web_search"
            ? `Searching: ${item.query}`
            : item.type === "todo_list"
              ? item.items
                  .map((i) => `${i.completed ? "✓" : "○"} ${i.text}`)
                  .join("\n")
              : item.message;
  return [
    {
      type: EventType.CUSTOM,
      name: "kite.activity",
      value: {
        id: item.id,
        summary: summary.slice(0, 2000),
        status: event.type,
      },
    },
  ];
}
