import { useEffect, useRef, useState } from "react";
import {
  useAgent,
  useCopilotKit,
  useLearnFromUserAction,
} from "@copilotkit/react-core/v2";
import {
  ArrowUp,
  BookOpen,
  Camera,
  LoaderCircle,
  Plus,
  Square,
  Sparkles,
  X,
} from "lucide-react";
import { validateSkillMarkdown } from "./skill-format";
import {
  createEpoch,
  displayText,
  ipcErrorMessage,
  requestAttachment,
  userContent,
} from "./message-content";
import { LearningStrip } from "./LearningStrip";
import { lessonMemory, teachingAnnotation } from "./learning-view";
import type { LearningStatus, ScreenshotAttachment, Settings } from "./types";
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
  learning,
}: {
  settings: Settings;
  request: AgentRequest | null;
  onDraft: (markdown: string) => void;
  onDone: () => void;
  onBusy: (busy: boolean) => void;
  newConversationSignal?: number;
  learning?: LearningStatus;
}) {
  const { agent, isReady } = useAgent();
  const { copilotkit } = useCopilotKit();
  // The user's "that worked" goes to Intelligence as a user_action
  // (POST {runtimeUrl}/annotate -> PUT /connector/annotate/:id), and the
  // lesson itself goes to Intelligence Memory through the main process. The
  // Intelligence key stays in the runtime.
  const learnFromUserAction = useLearnFromUserAction();
  const [lesson, setLesson] = useState<"none" | "offered" | "sending" | "sent">(
    "none",
  );
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [image, setImage] = useState<ScreenshotAttachment | null>(null);
  const [phase, setPhase] = useState("");
  const [activities, setActivities] = useState<
    { id: string; summary: string }[]
  >([]);
  // What the agent used from Intelligence in this conversation.
  const [usedSkills, setUsedSkills] = useState<string[]>([]);
  const [recalled, setRecalled] = useState<string[]>([]);
  const cancelled = useRef(false);
  const handled = useRef("");
  const bottom = useRef<HTMLDivElement>(null);
  const busyRef = useRef(false);
  // Tracks whether the displayed error came from a capture attempt, so a
  // later successful capture clears only its own error and never a run
  // failure or other message the user hasn't read yet.
  const errorSource = useRef<"capture" | null>(null);
  function showError(message: string, source: "capture" | null = null) {
    errorSource.current = source;
    setError(message);
  }
  // Bumped whenever the composer moves on from the attachment a capture was
  // started for (new conversation, or a message sent) so a screenshot that
  // resolves late never lands on the wrong message - and its error is
  // dropped too.
  const attachmentEpoch = useRef(createEpoch());
  function resetConversation() {
    agent.threadId = crypto.randomUUID();
    agent.setMessages([]);
    setImage(null);
    showError("");
    setActivities([]);
    setUsedSkills([]);
    setRecalled([]);
    setLesson("none");
    attachmentEpoch.current.advance();
  }
  useEffect(() => {
    if (!newConversationSignal) return;
    resetConversation();
    setInput("");
    setPhase("");
  }, [newConversationSignal]);
  useEffect(() => {
    const subscription = agent.subscribe({
      onCustomEvent: ({ event }) => {
        if (event.name === "kite.learned-skill") {
          const name = event.value?.name;
          if (typeof name === "string")
            setUsedSkills((previous) =>
              previous.includes(name) ? previous : [...previous, name],
            );
          return;
        }
        if (event.name === "kite.memory-recalled") {
          const previews = event.value?.previews;
          if (Array.isArray(previews))
            setRecalled(
              previews.filter(
                (preview): preview is string => typeof preview === "string",
              ),
            );
          return;
        }
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
      onRunErrorEvent: ({ event }) => showError(event.message),
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
      showError("Agent is still connecting. Try again shortly.");
      return;
    }
    if (!settings.modelConfigured) {
      showError(
        "Connect your OpenAI API key in Settings to start this session.",
      );
      onDone();
      return;
    }
    const attachment = requestAttachment(fresh, image);
    let content: ReturnType<typeof userContent>;
    try {
      content = userContent(prompt, attachment);
    } catch (e) {
      showError(e instanceof Error ? e.message : "Agent request failed");
      setImage(null);
      return;
    }
    cancelled.current = false;
    busyRef.current = true;
    setBusy(true);
    onBusy(true);
    showError("");
    setActivities([]);
    setLesson("none");
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
    attachmentEpoch.current.advance();
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
      } else if (settings.intelligenceConfigured) setLesson("offered");
    } catch (e) {
      showError(e instanceof Error ? e.message : "Agent request failed");
    } finally {
      completion.unsubscribe();
      busyRef.current = false;
      setBusy(false);
      onBusy(false);
      setPhase("");
      onDone();
    }
  }
  async function teach() {
    setLesson("sending");
    try {
      await window.kite!.saveLesson({
        threadId: agent.threadId,
        content: lessonMemory(agent.messages),
      });
    } catch (e) {
      setLesson("offered");
      showError(
        ipcErrorMessage(e, "Could not save this lesson to Intelligence"),
      );
      return;
    }
    setLesson("sent");
    try {
      await learnFromUserAction(
        teachingAnnotation(agent.messages, agent.threadId),
      );
    } catch (e) {
      showError(
        "Saved to Intelligence Memory, but the note for Intelligence's own learning failed: " +
          (e instanceof Error ? e.message : String(e)),
      );
    }
    await window.kite!.watchLearning();
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
          onClick={resetConversation}
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
            .map((m) => {
              const text = displayText(m);
              return (
                <div key={m.id} className={"message " + m.role}>
                  <small>{m.role === "user" ? "YOU" : "OPENMUSE"}</small>
                  {text !== null && <p>{text}</p>}
                  {m.role === "assistant" &&
                    "toolCalls" in m &&
                    m.toolCalls?.map((t) => (
                      <span className="tool-chip" key={t.id}>
                        {t.function.name}
                      </span>
                    ))}
                </div>
              );
            })
        )}
        {learning && recalled.length > 0 && (
          <div className="learned-skill-chip">
            <Sparkles size={12} /> Recalled from Intelligence Memory:{" "}
            {recalled[0]}
            {recalled.length > 1 ? ` (+${recalled.length - 1} more)` : ""}
          </div>
        )}
        {learning &&
          usedSkills.map((name) => (
            <div className="learned-skill-chip" key={name}>
              <BookOpen size={12} /> Using learned skill: {name}
            </div>
          ))}
        {activities.length > 0 && (
          <details className="agent-activity" open={busy}>
            <summary>Agent activity · {activities.length}</summary>
            {activities.map((item) => (
              <p key={item.id}>{item.summary}</p>
            ))}
          </details>
        )}
        {lesson !== "none" && !busy && (
          <div className="lesson-offer">
            {lesson === "sent" ? (
              "Saved to Intelligence Memory. New conversations will recall it."
            ) : (
              <>
                Did that work?
                <button
                  type="button"
                  disabled={lesson === "sending"}
                  onClick={() => void teach()}
                >
                  {lesson === "sending" ? "Saving…" : "Learn from this"}
                </button>
              </>
            )}
          </div>
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
      {learning && (
        <LearningStrip
          status={learning}
          onTry={resetConversation}
          onError={(message) => showError(message)}
        />
      )}
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
            onClick={() => {
              const isCurrent = attachmentEpoch.current.capture();
              void window
                .kite!.screenshot()
                .then((shot) => {
                  if (!isCurrent()) return;
                  if (errorSource.current === "capture") showError("");
                  setImage(shot);
                })
                .catch((e) => {
                  if (!isCurrent()) return;
                  showError(ipcErrorMessage(e, "Screenshot failed"), "capture");
                });
            }}
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
