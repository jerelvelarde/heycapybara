import { useState } from "react";
import { ExternalLink, X } from "lucide-react";
import { Assistant } from "./Assistant";
import type { Settings } from "./types";

export function CompanionChat({ settings }: { settings: Settings }) {
  const [error, setError] = useState("");
  async function action(fn: () => Promise<void>) {
    try {
      setError("");
      await fn();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Window action failed");
    }
  }
  return (
    <main className="companion-chat">
      <div className="companion-chat-toolbar">
        <span>
          <img src="./capybara.png" alt="" /> OpenMuse
        </span>
        <div>
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
      <Assistant
        settings={settings}
        request={null}
        onDraft={() => {}}
        onDone={() => {}}
        onBusy={() => {}}
      />
    </main>
  );
}
