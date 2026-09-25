import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  CircleHelp,
  ExternalLink,
  FolderOpen,
  Monitor,
  MousePointer2,
  Radio,
  RotateCcw,
  Square,
  X,
} from "lucide-react";
import type { Permissions, Snapshot } from "./types";

type Step = "welcome" | "accessibility" | "screenCapture" | "ready";

export function Notch({
  data,
  refresh,
}: {
  data: Snapshot;
  refresh: () => Promise<void>;
}) {
  const setup = !data.settings.onboardingComplete;
  const [step, setStep] = useState<Step>("welcome");
  const [permissions, setPermissions] = useState<Permissions>(data.permissions);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [accessibilityRequested, setAccessibilityRequested] = useState(false);
  const [accessibilityGuide, setAccessibilityGuide] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const checkInFlight = useRef(false);
  const expandedRef = useRef(false);

  useEffect(() => setPermissions(data.permissions), [data.permissions]);
  useEffect(() => {
    if (setup) {
      setStep("welcome");
      setExpanded(false);
      setAccessibilityGuide(false);
      expandedRef.current = false;
    }
  }, [setup]);

  const checkStatus = useCallback(async () => {
    if (checkInFlight.current) return;
    checkInFlight.current = true;
    setChecking(true);
    try {
      const snapshot = await window.kite!.state();
      setPermissions(snapshot.permissions);
      setError("");
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not check permissions. Try again.",
      );
    } finally {
      checkInFlight.current = false;
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!setup || (step !== "accessibility" && step !== "screenCapture"))
      return;
    void checkStatus();
    const timer = window.setInterval(() => void checkStatus(), 3000);
    const onFocus = () => void checkStatus();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [checkStatus, setup, step]);

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Action failed. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  function expand(value: boolean) {
    if (setup || expandedRef.current === value) return;
    expandedRef.current = value;
    setExpanded(value);
    void window.kite!.setNotchExpanded(value).catch((cause: unknown) => {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not resize the companion.",
      );
    });
  }

  function dragApp(event: React.DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    setError("");
    try {
      void Promise.resolve(window.kite!.startAppDrag()).catch(
        (cause: unknown) => {
          setError(
            cause instanceof Error
              ? cause.message
              : "App drag is available in the packaged app. Use Show in Finder instead.",
          );
        },
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "App drag is available in the packaged app. Use Show in Finder instead.",
      );
    }
  }

  if (!setup) {
    return (
      <main
        className={"notch notch-home" + (expanded ? " is-expanded" : "")}
        onMouseEnter={() => expand(true)}
        onMouseLeave={() => expand(false)}
        onFocusCapture={() => expand(true)}
        onBlurCapture={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) expand(false);
        }}
      >
        <button
          className="notch-pill"
          onClick={() => expand(true)}
          aria-expanded={expanded}
          aria-label="OpenMuse companion"
        >
          {data.settings.companion === "capybara" ? (
            <img src="./capybara.png" alt="" />
          ) : (
            <span className="notch-kite-mark" aria-hidden="true">
              ✦
            </span>
          )}
          <span>{data.active ? "Recording" : "OpenMuse"}</span>
          {data.active && (
            <span className="notch-live" aria-label="Recording in progress" />
          )}
        </button>
        {expanded && (
          <div className="notch-home-panel">
            <p>Your little workspace companion</p>
            <div className="notch-home-actions">
              <button
                onClick={() => void run(() => window.kite!.openWorkspace())}
                disabled={busy}
              >
                <FolderOpen size={15} /> Open workspace
              </button>
              <button
                onClick={() =>
                  void run(() =>
                    data.active
                      ? window.kite!.stop()
                      : window.kite!.start("New workflow"),
                  )
                }
                disabled={busy}
              >
                {data.active ? <Square size={14} /> : <Radio size={15} />}
                {data.active ? "Stop recording" : "Record a workflow"}
              </button>
              <button
                onClick={() => void run(() => window.kite!.replayOnboarding())}
                disabled={busy}
              >
                <RotateCcw size={15} /> Replay setup
              </button>
            </div>
            {error && (
              <p className="notch-error" role="alert">
                {error}
              </p>
            )}
          </div>
        )}
      </main>
    );
  }

  if (accessibilityGuide && step === "accessibility") {
    return (
      <main className="notch notch-permission-guide">
        <button
          draggable
          className="notch-guide-app-tile"
          disabled={busy}
          onDragStart={dragApp}
          onClick={() => void run(() => window.kite!.revealAppInFinder())}
          title="Drag OpenMuse into Accessibility settings or click to show in Finder"
        >
          <img src="./capybara.png" alt="" />
          <strong>OpenMuse Desktop</strong>
        </button>
        <div className="notch-guide-copy">
          <strong>Drag me into the Accessibility list</strong>
          <span>
            Drop the app in System Settings, then turn it on. Already listed?
            Toggle it off and on, then restart OpenMuse. Finder is the fallback.
          </span>
          <div className="notch-guide-actions">
            <button
              disabled={busy}
              onClick={() => void run(() => window.kite!.revealAppInFinder())}
            >
              <FolderOpen size={14} /> Show in Finder
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await window.kite!.closeAccessibilityGuide();
                  setAccessibilityGuide(false);
                  await checkStatus();
                })
              }
            >
              <ArrowRight size={14} /> Back to setup
            </button>
          </div>
        </div>
        {error && (
          <p className="notch-guide-error" role="alert">
            {error}
          </p>
        )}
      </main>
    );
  }

  const stepNumber = {
    welcome: 1,
    accessibility: 2,
    screenCapture: 3,
    ready: 4,
  }[step];
  return (
    <main className="notch notch-setup">
      <div className="notch-topline">
        <span className="notch-brand">
          <span className="notch-brand-mark">✦</span> OpenMuse
        </span>
        <span>GETTING STARTED · {stepNumber} OF 4</span>
      </div>
      <div className="notch-progress" aria-label={`Step ${stepNumber} of 4`}>
        {[1, 2, 3, 4].map((n) => (
          <span key={n} className={n <= stepNumber ? "current" : ""} />
        ))}
      </div>
      {step === "welcome" && (
        <div className="notch-step notch-welcome">
          <div className="notch-mascot">
            <img src="./capybara.png" alt="OpenMuse capybara" />
          </div>
          <span className="notch-eyebrow">
            A LITTLE HELP, RIGHT WHERE YOU ARE
          </span>
          <h1>Meet your new work buddy.</h1>
          <p>
            Show OpenMuse a workflow once, then turn it into a skill you can use
            again. Let’s get your Mac ready.
          </p>
          <button
            className="notch-primary"
            onClick={() => setStep("accessibility")}
          >
            Let’s get started <ArrowRight size={16} />
          </button>
        </div>
      )}
      {step === "accessibility" && (
        <div className="notch-step">
          <div className="notch-icon">
            <MousePointer2 size={23} />
          </div>
          <span className="notch-eyebrow">STEP 1 · ACCESSIBILITY</span>
          <h1>Let me follow along.</h1>
          <p>
            Accessibility lets OpenMuse observe app context, clicks and
            shortcuts while you record. macOS asks you to approve it.
          </p>
          <div className="notch-drag-row">
            <button
              draggable
              className="notch-app-tile"
              onDragStart={dragApp}
              onClick={() => void run(() => window.kite!.revealAppInFinder())}
              title="Drag OpenMuse into Accessibility settings or click to show in Finder"
            >
              <img src="./capybara.png" alt="" />
              <strong>OpenMuse Desktop</strong>
              <span>Drag this app into Settings</span>
            </button>
            <span className="notch-drag-arrow">
              <ArrowRight size={21} />
            </span>
            <div className="notch-system-tile">
              <MousePointer2 size={22} />
              <strong>Accessibility</strong>
              <span>Privacy &amp; Security</span>
            </div>
          </div>
          <div className="notch-actions">
            <button
              className="notch-primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  setAccessibilityGuide(true);
                  setAccessibilityRequested(true);
                  try {
                    await window.kite!.openAccessibilitySettings();
                    await checkStatus();
                  } catch (cause) {
                    setAccessibilityGuide(false);
                    throw cause;
                  }
                })
              }
            >
              <ExternalLink size={15} /> Open System Settings
            </button>
            <button
              className="notch-secondary"
              disabled={busy}
              onClick={() => void run(() => window.kite!.revealAppInFinder())}
            >
              Show app in Finder
            </button>
          </div>
          <div className="notch-status">
            <span
              className={
                permissions.accessibility
                  ? "notch-status-granted"
                  : "notch-status-waiting"
              }
            >
              {permissions.accessibility ? (
                <Check size={14} />
              ) : (
                <CircleHelp size={14} />
              )}{" "}
              {permissions.accessibility
                ? "Accessibility granted"
                : accessibilityRequested
                  ? "Waiting for macOS approval"
                  : "Not enabled yet"}
            </span>
            <button disabled={checking} onClick={() => void checkStatus()}>
              {checking ? "Checking…" : "Refresh status"}
            </button>
          </div>
          <p className="notch-hint">
            If OpenMuse is already in the list, toggle it off and on instead of
            dragging a duplicate. Restart the app if macOS asks. The drag tile
            needs a packaged app.
          </p>
          <div className="notch-bottom-actions">
            <button
              className="notch-link"
              onClick={() => setStep("screenCapture")}
            >
              Continue without recording
            </button>
            <button
              className="notch-next"
              disabled={!permissions.accessibility}
              onClick={() => setStep("screenCapture")}
            >
              Continue <ArrowRight size={16} />
            </button>
          </div>
        </div>
      )}
      {step === "screenCapture" && (
        <div className="notch-step">
          <div className="notch-icon">
            <Monitor size={23} />
          </div>
          <span className="notch-eyebrow">STEP 2 · OPTIONAL</span>
          <h1>Share a screenshot when you want.</h1>
          <p>
            Screen Recording lets you attach a screenshot to a conversation.
            OpenMuse only captures one when you choose to share it.
          </p>
          <div className="notch-permission-card">
            <Monitor size={19} />
            <span>
              <strong>Screen Recording</strong>
              <small>
                {permissions.screenCapture
                  ? "Granted in macOS"
                  : "You can enable this later in Settings"}
              </small>
            </span>
            {permissions.screenCapture && <Check size={16} />}
          </div>
          <div className="notch-actions">
            <button
              className="notch-primary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await window.kite!.permissions("screenCapture");
                  await checkStatus();
                })
              }
            >
              <ExternalLink size={15} /> Open System Settings
            </button>
            <button
              className="notch-secondary"
              disabled={checking}
              onClick={() => void checkStatus()}
            >
              {checking ? "Checking…" : "Refresh status"}
            </button>
          </div>
          <div className="notch-bottom-actions">
            <button className="notch-link" onClick={() => setStep("ready")}>
              Skip for now
            </button>
            <button className="notch-next" onClick={() => setStep("ready")}>
              Continue <ArrowRight size={16} />
            </button>
          </div>
        </div>
      )}
      {step === "ready" && (
        <div className="notch-step notch-ready">
          <div className="notch-mascot">
            <img src="./capybara.png" alt="" />
          </div>
          <div className="notch-icon-check">
            <Check size={20} />
          </div>
          <span className="notch-eyebrow">ALL SET</span>
          <h1>Let’s make something easier.</h1>
          <p>
            {data.settings.placement === "notch"
              ? "Your companion lives by the notch. Hover over it to open your workspace or start a recording."
              : "Your floating companion is ready. Click it to open your workspace or start a recording."}
          </p>
          <button
            className="notch-primary"
            disabled={busy}
            onClick={() => void run(() => window.kite!.completeOnboarding())}
          >
            Finish setup <ArrowRight size={16} />
          </button>
        </div>
      )}
      {error && (
        <div className="notch-error" role="alert">
          {error}
          <button onClick={() => setError("")} aria-label="Dismiss error">
            <X size={14} />
          </button>
        </div>
      )}
    </main>
  );
}
