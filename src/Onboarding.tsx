import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  LoaderCircle,
  Monitor,
  MousePointer2,
} from "lucide-react";
import { Sprite } from "./Sprite";
import type { PermissionKind, Permissions, Snapshot } from "./types";

type Step = "welcome" | "permissions" | "ready";
const steps: Step[] = ["welcome", "permissions", "ready"];
const rows = [
  {
    kind: "accessibility",
    title: "Accessibility",
    detail: "Follow along while you record a workflow.",
    hint: "Already on? Turn it off and on again.",
    icon: MousePointer2,
  },
  {
    kind: "screenCapture",
    title: "Screen Recording",
    detail: "Attach a screenshot to a message when you choose.",
    hint: "macOS may ask to reopen OpenMuse.",
    icon: Monitor,
  },
] as const;

export function Onboarding({ data }: { data: Snapshot }) {
  const [step, setStep] = useState<Step>("welcome");
  const [permissions, setPermissions] = useState<Permissions>(data.permissions);
  const [requested, setRequested] = useState<PermissionKind[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [checkFailed, setCheckFailed] = useState(false);
  const checking = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => heading.current?.focus(), [step]);

  const check = useCallback(async () => {
    if (checking.current) return;
    checking.current = true;
    try {
      setPermissions((await window.kite!.state()).permissions);
      setCheckFailed(false);
    } catch (cause) {
      console.error("Could not check permissions", cause);
      setCheckFailed(true);
    } finally {
      checking.current = false;
    }
  }, []);

  useEffect(() => {
    if (step !== "permissions") return;
    void check();
    const timer = window.setInterval(() => void check(), 2000);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [check, step]);

  async function run(action: () => Promise<unknown>, fallback: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      console.error(fallback, cause);
      setError(fallback);
    } finally {
      setBusy(false);
    }
  }

  function allow(kind: PermissionKind) {
    void run(async () => {
      const next = await window.kite!.permissions(kind);
      setRequested((kinds) =>
        kinds.includes(kind) ? kinds : [...kinds, kind],
      );
      setPermissions(next);
    }, "Could not ask macOS for permission. Try again.");
  }

  function go(next: Step) {
    setError("");
    setStep(next);
  }

  const index = steps.indexOf(step);
  return (
    <main className="onboarding">
      <div className="onboarding-titlebar" />
      <div
        className="onboarding-dots"
        role="img"
        aria-label={`Step ${index + 1} of ${steps.length}`}
      >
        {steps.map((name, position) => (
          <span key={name} className={position <= index ? "current" : ""} />
        ))}
      </div>
      <section className="onboarding-screen" key={step}>
        {step === "welcome" && (
          <>
            <div className="onboarding-art">
              <Sprite companion={data.settings.companion} />
            </div>
            <h1 ref={heading} tabIndex={-1}>
              Meet your new work buddy.
            </h1>
            <p>
              Show OpenMuse a workflow once, and it becomes a skill you can use
              again.
            </p>
            <div className="onboarding-actions">
              <button
                className="button primary"
                onClick={() => go("permissions")}
              >
                Get started <ArrowRight size={15} />
              </button>
            </div>
          </>
        )}
        {step === "permissions" && (
          <>
            <h1 ref={heading} tabIndex={-1}>
              Two quick permissions.
            </h1>
            <p>Nothing is captured until you record or attach a screenshot.</p>
            <ul className="onboarding-permissions" aria-live="polite">
              {rows.map(({ kind, title, detail, hint, icon: Icon }) => {
                const granted = permissions[kind];
                const waiting = !granted && requested.includes(kind);
                return (
                  <li key={kind} className="onboarding-permission">
                    <span className="onboarding-permission-icon">
                      <Icon size={18} />
                    </span>
                    <div>
                      <strong>
                        {title}
                        {kind === "screenCapture" && <small> · Optional</small>}
                      </strong>
                      <p>{detail}</p>
                      {waiting && (
                        <p className="onboarding-waiting">
                          <LoaderCircle
                            className="spin"
                            size={12}
                            aria-hidden="true"
                          />{" "}
                          Waiting for System Settings. {hint}
                        </p>
                      )}
                    </div>
                    {granted ? (
                      <span className="onboarding-granted">
                        <Check size={14} aria-hidden="true" /> Allowed
                      </span>
                    ) : waiting ? (
                      <button
                        className="button secondary"
                        disabled={busy}
                        aria-label={`Open System Settings for ${title}`}
                        onClick={() =>
                          void run(
                            () => window.kite!.openPermissionSettings(kind),
                            "Could not open System Settings. Try again.",
                          )
                        }
                      >
                        Open System Settings
                      </button>
                    ) : (
                      <button
                        className="button secondary"
                        disabled={busy}
                        aria-label={`Allow ${title}`}
                        onClick={() => allow(kind)}
                      >
                        Allow
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            {checkFailed && (
              <p className="onboarding-error" role="alert">
                Couldn’t check permissions.{" "}
                <button className="text-button" onClick={() => void check()}>
                  Try again
                </button>
              </p>
            )}
            {!permissions.accessibility && (
              <p className="onboarding-note">
                Recording needs Accessibility. You can allow it later in
                Settings.
              </p>
            )}
            <div className="onboarding-actions">
              <button
                className="button primary"
                disabled={busy}
                onClick={() => go("ready")}
              >
                Continue <ArrowRight size={15} />
              </button>
            </div>
          </>
        )}
        {step === "ready" && (
          <>
            <div className="onboarding-art">
              <Sprite companion={data.settings.companion} />
              <span className="onboarding-check" aria-hidden="true">
                <Check size={16} />
              </span>
            </div>
            <h1 ref={heading} tabIndex={-1}>
              You’re all set.
            </h1>
            <p>
              Look for me on your desktop. Click me to chat, or hover to record
              a workflow.
            </p>
            <div className="onboarding-actions">
              <button
                className="button primary"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => window.kite!.completeOnboarding(),
                    "Could not save your settings. Check free disk space and folder permissions, then try again.",
                  )
                }
              >
                Start using OpenMuse <ArrowRight size={15} />
              </button>
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  void run(
                    () =>
                      window.kite!.completeOnboarding({ openWorkspace: true }),
                    "Could not save your settings. Check free disk space and folder permissions, then try again.",
                  )
                }
              >
                Open the workspace
              </button>
            </div>
          </>
        )}
      </section>
      {error && (
        <p className="onboarding-error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
