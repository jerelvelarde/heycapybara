import { useEffect, useRef, useState } from "react";
import { useAgent, useCopilotKit } from "@copilotkit/react-core/v2";
import {
  ArrowUp,
  Camera,
  LoaderCircle,
  Plus,
  Square,
  Sparkles,
  X,
} from "lucide-react";
import { validateSkillMarkdown } from "./skill-format";
import { userContent } from "./message-content";
import type { ScreenshotAttachment, Settings } from "./types";
export type AgentRequest = {
  id: string;
  prompt: string;
  mode: "skill" | "guide";
};
export function Assistant({
  settings,
  request,
  onDraft,
  onDone,
  onBusy,
  newConversationSignal = 0,
}: {
  settings: Settings;
  request: AgentRequest | null;
  onDraft: (markdown: string) => void;
  onDone: () => void;
  onBusy: (busy: boolean) => void;
  newConversationSignal?: number;
}) {
  const { agent, isReady } = useAgent();
  const { copilotkit } = useCopilotKit();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [image, setImage] = useState<ScreenshotAttachment | null>(null);
  const [phase, setPhase] = useState("");
  const [activities, setActivities] = useState<
    { id: string; summary: string }[]
  >([]);
  const cancelled = useRef(false);
  const handled = useRef("");
  const bottom = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  useEffect(() => {
    if (!newConversationSignal) return;
    agent.threadId = crypto.randomUUID();
    agent.setMessages([]);
    setInput("");
    setImage(null);
    setError("");
    setActivities([]);
    setPhase("");
  }, [newConversationSignal]);
  useEffect(() => {
    const subscription = agent.subscribe({
      onCustomEvent: ({ event }) => {
        if (
          event.name !== "kite.activity" ||
          typeof event.value?.summary !== "string"
        )
          return;
        const activity = {
          id: String(event.value.id),
          summary: event.value.summary,
        };
        setPhase(activity.summary.split("\n")[0]);
        setActivities((previous) =>
          [
            ...previous.filter((item) => item.id !== activity.id),
            activity,
          ].slice(-20),
        );
      },
      onRunErrorEvent: ({ event }) => setError(event.message),
      onToolCallStartEvent: ({ event }) => setPhase(event.toolCallName),
      onTextMessageContentEvent: () => setPhase("Writing"),
      onRunStartedEvent: () => setPhase("Thinking"),
    });
    return () => subscription.unsubscribe();
  }, [agent]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [agent.messages, busy]);
  async function send(
    prompt: string,
    mode: "skill" | "guide" = "guide",
    fresh = false,
  ) {
    if (busyRef.current) return;
    if (!isReady) {
      setError("Agent is still connecting. Try again shortly.");
      return;
    }
    if (!settings.modelConfigured) {
      setError(
        "Connect your OpenAI API key in Settings to start this session.",
      );
      onDone();
      return;
    }
    const attachment = fresh ? null : image;
    let content: ReturnType<typeof userContent>;
    try {
      content = userContent(prompt, attachment);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Agent request failed");
      setImage(null);
      return;
    }
    cancelled.current = false;
    busyRef.current = true;
    setBusy(true);
    onBusy(true);
    setError("");
    setActivities([]);
    if (fresh) {
      agent.threadId = crypto.randomUUID();
      agent.setMessages([]);
      setImage(null);
    }
    const messageId = crypto.randomUUID();
    agent.addMessage({
      id: messageId,
      role: "user",
      content,
    });
    setInput("");
    setImage(null);
    let finished = false;
    let runFailed = false;
    let failureMessage = "";
    const completion = agent.subscribe({
      onRunFinishedEvent: ({ event }) => {
        finished = !event.outcome || event.outcome.type === "success";
      },
      onCustomEvent: ({ event }) => {
        if (
          event.name !== "kite.activity" ||
          typeof event.value?.summary !== "string"
        )
          return;
        const activity = {
          id: String(event.value.id),
          summary: event.value.summary,
        };
        setPhase(activity.summary.split("\n")[0]);
        setActivities((previous) =>
          [
            ...previous.filter((item) => item.id !== activity.id),
            activity,
          ].slice(-20),
        );
      },
      onRunErrorEvent: ({ event }) => {
        runFailed = true;
        failureMessage = event.message;
      },
    });
    try {
      await copilotkit.runAgent({ agent });
      if (cancelled.current)
        throw new Error("Run stopped. No skill draft was created.");
      if (runFailed || !finished)
        throw new Error(
          failureMessage ||
            "The agent run did not finish successfully. Retry after checking the connection.",
        );
      if (mode === "skill") {
        const message = agent.messages
          .filter(
            (m) =>
              m.role === "assistant" &&
              typeof m.content === "string" &&
              m.content.trim(),
          )
          .at(-1);
        if (!message || typeof message.content !== "string")
          throw new Error(
            "The agent did not return a skill. Check its response and retry.",
          );
        const markdown = message.content
          .replace(/^```(?:markdown|md)?\s*\n/, "")
          .replace(/\n```\s*$/, "");
        validateSkillMarkdown(markdown);
        onDraft(markdown);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Agent request failed");
    } finally {
      completion.unsubscribe();
      busyRef.current = false;
      setBusy(false);
      onBusy(false);
      setPhase("");
      onDone();
    }
  }
  useEffect(() => {
    if (
      request &&
      isReady &&
      handled.current !== request.id &&
      !busyRef.current
    ) {
      handled.current = request.id;
      void send(request.prompt, request.mode, true);
    }
  }, [request, isReady]);
  return (
    <aside className="assistant">
      <header>
        <div className="assistant-heading">
          <span className="mini-sprite">
            {settings.companion === "capybara" ? (
              <img src="./capybara.png" alt="" />
            ) : (
              "✦"
            )}
          </span>
          <div>
            <strong>Your copilot</strong>
            <small>Codex · {settings.model}</small>
          </div>
        </div>
        <button
          title="New conversation"
          className="icon-button"
          disabled={busy}
          onClick={() => {
            agent.threadId = crypto.randomUUID();
            agent.setMessages([]);
            setImage(null);
            setError("");
            setActivities([]);
          }}
        >
          <Plus size={18} />
        </button>
      </header>
      <div className="conversation">
        {agent.messages.length === 0 ? (
          <div className="chat-welcome">
            {settings.companion === "capybara" ? (
              <img className="chat-capybara" src="./capybara.png" alt="" />
            ) : (
              <div className="kite-face">
                <i />
                <i />
                <span />
              </div>
            )}
            <h3>
              A little help.
              <br />A little more you.
            </h3>
            <p>Teach me once. We’ll make the next time easier.</p>
            <div
              className="suggestion"
              onClick={() => setInput("What skills have I taught you?")}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter")
                  setInput("What skills have I taught you?");
              }}
            >
              <Sparkles size={14} /> What have I taught you?
            </div>
          </div>
        ) : (
          agent.messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => (
              <div key={m.id} className={"message " + m.role}>
                <small>{m.role === "user" ? "YOU" : "OPENMUSE"}</small>
                <p>
                  {typeof m.content === "string"
                    ? m.content.length > 2400 && m.role === "user"
                      ? m.content.slice(0, 240) +
                        "\n[Reviewed recording attached]"
                      : m.content
                    : "Screen context attached"}
                </p>
                {m.role === "assistant" &&
                  "toolCalls" in m &&
                  m.toolCalls?.map((t) => (
                    <span className="tool-chip" key={t.id}>
                      {t.function.name}
                    </span>
                  ))}
              </div>
            ))
        )}
        {activities.length > 0 && (
          <details className="agent-activity" open={busy}>
            <summary>Agent activity · {activities.length}</summary>
            {activities.map((item) => (
              <p key={item.id}>{item.summary}</p>
            ))}
          </details>
        )}
        {busy && (
          <div className="thinking">
            <LoaderCircle className="spin" size={14} />
            {phase || "Thinking"}…
          </div>
        )}
        {error && <div className="inline-error">{error}</div>}
        <div ref={bottom} />
      </div>
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          if (input.trim()) void send(input);
        }}
      >
        {image && (
          <div className="attachment">
            <img
              src={image.dataUrl}
              alt={"Screen capture of " + image.label + " to send"}
            />
            <button
              type="button"
              title="Remove screenshot"
              onClick={() => setImage(null)}
            >
              <X size={12} />
            </button>
          </div>
        )}
        <textarea
          aria-label="Ask OpenMuse"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Ask OpenMuse anything…"
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (input.trim()) void send(input);
            }
          }}
        />
        <div>
          <button
            className="icon-button"
            type="button"
            title="Attach a screenshot of your primary screen"
            disabled={busy}
            onClick={() =>
              void window
                .kite!.screenshot()
                .then((shot) => {
                  setError("");
                  setImage(shot);
                })
                .catch((e) => setError(e.message))
            }
          >
            <Camera size={17} />
          </button>
          <small>
            {image
              ? "Screen shared when you send"
              : "AG-UI · " + (isReady ? "ready" : "connecting")}
          </small>
          {busy ? (
            <button
              className="send"
              type="button"
              title="Stop agent"
              onClick={() => {
                cancelled.current = true;
                void copilotkit.stopAgent({ agent });
              }}
            >
              <Square size={13} />
            </button>
          ) : (
            <button
              className="send"
              title="Send"
              disabled={!input.trim() || !isReady}
            >
              <ArrowUp size={18} />
            </button>
          )}
        </div>
      </form>
      <footer title={settings.workspace}>
        Workspace: {settings.workspace.split("/").at(-1)} · Screenshots shared
        when sent
      </footer>
    </aside>
  );
}
