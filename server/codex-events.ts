import { randomUUID } from "node:crypto";
import { EventType, type BaseEvent } from "@ag-ui/core";
import type { McpToolCallItem, ThreadEvent } from "@openai/codex-sdk";

/**
 * An event OpenMuse's own runner emits next to Codex's, before a turn starts
 * (server/codex-agent.ts). It reaches the chat as one AG-UI custom event.
 */
export type KiteNotice = {
  type: "kite.notice";
  name: string;
  value: Record<string, unknown>;
};

// MCP servers whose calls are OpenMuse's own steps: the kite tools, and
// Intelligence's knowledge-base tool through OpenMuse's proxy.
const OPENMUSE_SERVERS = new Set(["kite", "intelligence"]);

// A finished call to one of those servers becomes an AG-UI tool call. The
// step then persists in the Intelligence thread that learning reads, and it
// shows as a chip in chat. Only the tool's name and status are kept: MCP
// arguments and results never reach the thread (the Rich Threads rule on
// jerel/kite-os-learning). The result is included so CopilotKit never tries
// to run it as a frontend tool.
function openMuseToolCall(item: McpToolCallItem): BaseEvent[] {
  const toolCallId = randomUUID();
  return [
    { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: item.tool },
    { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: "{}" },
    { type: EventType.TOOL_CALL_END, toolCallId },
    {
      type: EventType.TOOL_CALL_RESULT,
      messageId: randomUUID(),
      toolCallId,
      role: "tool",
      content: JSON.stringify({ status: item.status }),
    },
  ] as BaseEvent[];
}

// The one argument read back out of a call: which learned skill the agent
// loaded, so chat can say so. The name is Intelligence's own, not user data.
function learnedSkillLoaded(item: McpToolCallItem): BaseEvent[] {
  const args = item.arguments as { name?: unknown } | null | undefined;
  const name = typeof args?.name === "string" ? args.name : undefined;
  if (
    item.server !== "kite" ||
    item.tool !== "load_learned_skill" ||
    item.status !== "completed" ||
    !name
  )
    return [];
  return [
    {
      type: EventType.CUSTOM,
      name: "kite.learned-skill",
      value: { name: name.slice(0, 128) },
    } as BaseEvent,
  ];
}

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
  const activity = {
    type: EventType.CUSTOM,
    name: "kite.activity",
    value: {
      id: item.id,
      summary: summary.slice(0, 2000),
      status: event.type,
    },
  } as BaseEvent;
  if (
    item.type === "mcp_tool_call" &&
    OPENMUSE_SERVERS.has(item.server) &&
    event.type === "item.completed"
  )
    return [...openMuseToolCall(item), ...learnedSkillLoaded(item), activity];
  return [activity];
}
