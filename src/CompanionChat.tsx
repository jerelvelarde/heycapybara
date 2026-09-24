import { useState } from "react";
import {
  Circle,
  ExternalLink,
  LoaderCircle,
  Plus,
  Square,
  X,
} from "lucide-react";
import { Assistant } from "./Assistant";
import type { CompanionTrayMode, Recording, Settings } from "./types";

export function CompanionChat({
  settings,
  mode,
  active,
}: {
  settings: Settings;
  mode: CompanionTrayMode;
  active: Recording | null;
}) {
  const [error, setError] = useState("");
  const [title, setTitle] = useState("");
  const [working, setWorking] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [newConversationSignal, setNewConversationSignal] = useState(0);
  async function action(fn: () => Promise<void>) {
    try {
      setError("");
      await fn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Window action failed");
    }
  }
  async function record(action: () => Promise<unknown>) {
    setWorking(true);
    try {
      await action();
      setError("");
      if (!active) setTitle("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Recording failed");
    } finally {
      setWorking(false);
    }
  }
  return (
    <main
      className={
        "companion-chat " + (mode === "record" ? "record-mode" : "chat-mode")
      }
    >
      <div className="companion-chat-toolbar">
        <span>
          {settings.companion === "capybara" ? (
            <img src="./capybara.png" alt="" />
          ) : (
            <span className="companion-kite-mark">✦</span>
          )}
          {mode === "record" ? "Record a workflow" : "Chat with OpenMuse"}
        </span>
        <div>
          {mode === "chat" && (
            <button
              title="New conversation"
              aria-label="New conversation"
              disabled={chatBusy}
              onClick={() => setNewConversationSignal((value) => value + 1)}
            >
              <Plus size={16} />
            </button>
          )}
          <button
            title="Open workspace"
            onClick={() => void action(window.kite!.openWorkspace)}
          >
            <ExternalLink size={16} /> Workspace
          </button>
          <button
            title="Close chat"
            aria-label="Close chat"
            onClick={() => void action(window.kite!.closeCompanionChat)}
          >
            <X size={16} />
          </button>
        </div>
      </div>
      {error && <div className="inline-error">{error}</div>}
      <div className="companion-chat-assistant" hidden={mode !== "chat"}>
        <Assistant
          settings={settings}
          request={null}
          onDraft={() => {}}
          onDone={() => {}}
          onBusy={setChatBusy}
          newConversationSignal={newConversationSignal}
        />
      </div>
      {mode === "record" && (
        <section className="companion-record">
          {active ? (
            <>
              <div className="companion-record-status">
                <span className="record-dot" /> Recording now
              </div>
              <strong>{active.title}</strong>
              <p>
                {active.events.length} events captured. You can keep working in
                other apps.
              </p>
              <button
                className="companion-record-primary"
                disabled={working}
                onClick={() => void record(window.kite!.stop)}
              >
                {working ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Square size={15} />
                )}{" "}
                Stop recording
              </button>
            </>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (title.trim())
                  void record(() => window.kite!.start(title.trim()));
              }}
            >
              <label htmlFor="companion-record-title">
                What should I learn?
              </label>
              <input
                id="companion-record-title"
                autoFocus
                maxLength={160}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Name this workflow"
              />
              <p>Recording starts only when you press Start.</p>
              <button
                className="companion-record-primary"
                disabled={!title.trim() || working}
              >
                {working ? (
                  <LoaderCircle className="spin" size={16} />
                ) : (
                  <Circle size={16} />
                )}{" "}
                Start recording
              </button>
            </form>
          )}
        </section>
      )}
    </main>
  );
}
