import { ExternalLink, LoaderCircle, Sparkles, X } from "lucide-react";
import { learningStrip } from "./learning-view";
import { ipcErrorMessage } from "./message-content";
import type { LearningStatus } from "./types";

export function LearningStrip({
  status,
  onTry,
  onError,
}: {
  status: LearningStatus;
  onTry: () => void;
  onError: (message: string) => void;
}) {
  const view = learningStrip(status);
  if (!view) return null;
  const run = (action: () => Promise<void>, fallback: string) =>
    void action().catch((error: unknown) =>
      onError(ipcErrorMessage(error, fallback)),
    );
  const dismiss = () =>
    run(
      () => window.kite!.dismissLearned(),
      "Could not dismiss what was learned",
    );
  return (
    <div className={"learning-strip " + view.tone} role="status">
      {view.tone === "busy" ? (
        <LoaderCircle className="spin" size={13} />
      ) : (
        <Sparkles size={13} />
      )}
      <span>{view.text}</span>
      {view.action?.kind === "open" && (
        <button
          type="button"
          onClick={() =>
            run(
              () => window.kite!.openLearningStep(),
              "Could not open Intelligence",
            )
          }
        >
          {view.action.label} <ExternalLink size={12} />
        </button>
      )}
      {view.action?.kind === "try" && (
        <>
          <button
            type="button"
            onClick={() => {
              onTry();
              dismiss();
            }}
          >
            Try it
          </button>
          <button
            type="button"
            title="Dismiss"
            aria-label="Dismiss"
            onClick={dismiss}
          >
            <X size={12} />
          </button>
        </>
      )}
    </div>
  );
}
