import { useCallback, useEffect, useState } from "react";
import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import {
  ArrowDownToLine,
  ArrowRight,
  BookOpen,
  Check,
  ChevronRight,
  Circle,
  CircleHelp,
  Command,
  ExternalLink,
  Layers3,
  LoaderCircle,
  Mic,
  Monitor,
  MoreHorizontal,
  MousePointer2,
  Plus,
  Radio,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react";
import { Assistant, type AgentRequest } from "./Assistant";
import { Buddy } from "./Buddy";
import { manualDraft, skillPrompt } from "./skill";
import type { Recording, Skill, Snapshot } from "./types";
const isBuddy = new URLSearchParams(location.search).has("buddy");
const time = (date: string) =>
  new Date(date).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const day = (date: string) =>
  new Date(date).toLocaleDateString([], { month: "short", day: "numeric" });
function Sprite({ small = false }: { small?: boolean }) {
  return (
    <div className={"sprite " + (small ? "small" : "")}>
      <div className="sprite-shape">
        <span className="eye left" />
        <span className="eye right" />
        <span className="mouth" />
      </div>
      <svg viewBox="0 0 80 80">
        <path d="M42 0C10 24 67 22 35 43S32 64 15 74" />
      </svg>
    </div>
  );
}
export function App() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    try {
      setData(await window.kite!.state());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load Kite");
    }
  }, []);
  useEffect(() => {
    if (!window.kite) return;
    void refresh();
    const off = window.kite.onUpdate(() => void refresh());
    return off;
  }, [refresh]);
  if (!window.kite)
    return (
      <div className="browser-notice">
        <Sprite />
        <h1>Kite lives on your Mac.</h1>
        <p>
          Open the desktop app to record workflows across your applications.
        </p>
        <code>npm run dev</code>
        <p>This browser view cannot access your desktop.</p>
      </div>
    );
  if (!data)
    return (
      <div className="loading">
        <Sprite />
        <p>{error || "Waking up Kite…"}</p>
        {error && <button onClick={() => void refresh()}>Try again</button>}
      </div>
    );
  if (isBuddy)
    return (
      <Buddy active={!!data.active} error={error} setError={setError}>
        <Sprite small />
      </Buddy>
    );
  return (
    <CopilotKitProvider
      runtimeUrl={data.settings.runtimeUrl}
      useSingleEndpoint
      headers={{ Authorization: "Bearer " + data.settings.runtimeToken }}
      showDevConsole={false}
    >
      <Workspace
        data={data}
        refresh={refresh}
        error={error}
        setError={setError}
      />
    </CopilotKitProvider>
  );
}
function Workspace({
  data,
  refresh,
  error,
  setError,
}: {
  data: Snapshot;
  refresh: () => Promise<void>;
  error: string;
  setError: (s: string) => void;
}) {
  const [tab, setTab] = useState("Overview");
  const [query, setQuery] = useState("");
  const [recordingId, setRecordingId] = useState("");
  const [editor, setEditor] = useState<{
    id?: string;
    name: string;
    markdown: string;
    recordingId: string;
  } | null>(null);
  const [newRecording, setNewRecording] = useState(false);
  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [working, setWorking] = useState(false);
  const [modelKey, setModelKey] = useState("");
  const [agentBusy, setAgentBusy] = useState(false);
  const [request, setRequest] = useState<AgentRequest | null>(null);
  const [draftFor, setDraftFor] = useState<Recording | null>(null);
  const [toast, setToast] = useState("");
  const selected = data.recordings.find((r) => r.id === recordingId);
  const active = data.active;
  const count = data.skills.filter((s) => s.approvedAt).length;
  async function perform(fn: () => Promise<unknown>) {
    setWorking(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action failed");
    } finally {
      setWorking(false);
    }
  }
  function notify(message: string) {
    setToast(message);
    setTimeout(() => setToast(""), 3500);
  }
  function selectTab(value: string) {
    setTab(value);
    setRecordingId("");
    setEditor(null);
  }
  function generate(r: Recording) {
    void perform(async () => {
      const reviewed = await window.kite!.reviewedRecording(r.id);
      const prompt = skillPrompt(reviewed);
      setDraftFor(reviewed);
      setRequest({ id: crypto.randomUUID(), prompt, mode: "skill" });
    });
  }
  function guide(skill: Skill) {
    setRequest({
      id: crypto.randomUUID(),
      mode: "guide",
      prompt: `Guide me through my approved local skill "${skill.name}" (id ${skill.id}). Load it first, then ask what context you need. Help me complete it one step at a time.`,
    });
  }
  function openManual(r: Recording) {
    setEditor({ name: r.title, markdown: manualDraft(r), recordingId: r.id });
  }
  const recordings = data.recordings.filter((r) =>
    r.title.toLowerCase().includes(query.toLowerCase()),
  );
  const skills = data.skills.filter((s) =>
    s.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="app-shell">
      <nav className="sidebar">
        <div className="traffic-space" />
        <div className="brand">
          <div className="brand-mark">✦</div>kite<span>DESKTOP</span>
        </div>
        <button
          className="workspace-switch"
          onClick={() => selectTab("Settings")}
        >
          <span className="avatar">U</span>
          <span>
            My workspace<small>Personal</small>
          </span>
          <MoreHorizontal size={17} />
        </button>
        <div className="nav-label">WORKSPACE</div>
        {[
          { name: "Overview", icon: Layers3 },
          { name: "Recordings", icon: Radio },
          { name: "Skill library", icon: BookOpen },
          { name: "Learning", icon: Sparkles },
        ].map(({ name, icon: Icon }) => (
          <button
            key={name}
            className={"nav-item " + (tab === name ? "selected" : "")}
            onClick={() => selectTab(name)}
          >
            <Icon size={18} />
            {name}
            {name === "Skill library" && (
              <span className="nav-count">{count}</span>
            )}
            {name === "Learning" && <span className="tiny-dot" />}
          </button>
        ))}
        <div className="sidebar-bottom">
          <div className="local-status">
            <span className="green-dot" /> On your Mac
            <small>Your companion is ready</small>
          </div>
          <button
            className={"nav-item " + (tab === "Settings" ? "selected" : "")}
            onClick={() => selectTab("Settings")}
          >
            <Settings2 size={18} /> Settings
          </button>
          <button className="nav-item" onClick={() => selectTab("Help")}>
            <CircleHelp size={18} /> How Kite works
          </button>
          <div className="sidebar-footer">
            <span className="kite-mini">✦</span> Made to learn with you{" "}
            <span>↗</span>
          </div>
        </div>
      </nav>
      <div className="workspace">
        <header className="topbar">
          <div>
            Workspace <ChevronRight size={13} /> <strong>{tab}</strong>
          </div>
          <div>
            <span className="platform">
              <Monitor size={13} /> macOS
            </span>
            <span className="shortcut">⌘ ⇧ K</span>
          </div>
        </header>
        <div className="workspace-content">
          {error && (
            <div className="error-banner">
              {error}
              <button title="Dismiss error" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {toast && (
            <div className="toast">
              <Check size={15} />
              {toast}
            </div>
          )}
          {editor ? (
            <>
              <div className="section-top">
                <div>
                  <button className="back" onClick={() => setEditor(null)}>
                    ← Back to workspace
                  </button>
                  <h1>Make it a skill.</h1>
                  <p>Review the instructions. Keep what’s useful.</p>
                </div>
                <span className="badge amber">Draft · review required</span>
              </div>
              <div className="editor-card">
                <label>
                  SKILL NAME
                  <input
                    value={editor.name}
                    onChange={(e) =>
                      setEditor({ ...editor, name: e.target.value })
                    }
                  />
                </label>
                <div className="editor-label">
                  <span>SKILL.md</span>
                  <span>Editable markdown</span>
                </div>
                <textarea
                  className="markdown-editor"
                  aria-label="Skill markdown"
                  spellCheck={false}
                  value={editor.markdown}
                  onChange={(e) =>
                    setEditor({ ...editor, markdown: e.target.value })
                  }
                />
                <div className="editor-actions">
                  <button
                    className="button secondary"
                    disabled={working}
                    onClick={() =>
                      void perform(async () => {
                        const s = await window.kite!.saveSkill({
                          ...editor,
                          approve: false,
                        });
                        setEditor({ ...editor, id: s.id });
                        notify("Draft saved locally");
                      })
                    }
                  >
                    Save draft
                  </button>
                  <button
                    className="button primary"
                    disabled={working || !editor.markdown.trim()}
                    onClick={() =>
                      void perform(async () => {
                        await window.kite!.saveSkill({
                          ...editor,
                          approve: true,
                        });
                        setEditor(null);
                        setRecordingId("");
                        setTab("Skill library");
                        notify("Skill approved. Kite can use it now.");
                      })
                    }
                  >
                    <Check size={16} /> Approve skill
                  </button>
                </div>
              </div>
              <p className="footnote">
                Approval makes this skill available locally. Intelligence
                proposals are reviewed and published in your Intelligence
                project.
              </p>
            </>
          ) : selected ? (
            <>
              <div className="section-top">
                <div>
                  <button className="back" onClick={() => setRecordingId("")}>
                    ← All recordings
                  </button>
                  <h1>{selected.title}</h1>
                  <p>
                    {day(selected.startedAt)} · {time(selected.startedAt)} ·{" "}
                    {
                      selected.events.filter(
                        (e) => !["status", "error"].includes(e.kind),
                      ).length
                    }{" "}
                    captured events
                  </p>
                </div>
                <span className={"badge " + (!selected.stoppedAt ? "red" : "")}>
                  {selected.stoppedAt ? "Ready to review" : "Recording"}
                </span>
              </div>
              <div className="recording-toolbar">
                <span>
                  <ShieldCheck size={16} /> Review before sharing
                </span>
                {selected.stoppedAt && (
                  <div>
                    <button
                      className="button secondary"
                      onClick={() => openManual(selected)}
                    >
                      Manual draft
                    </button>
                    <button
                      className="button primary"
                      disabled={
                        working || agentBusy || !data.settings.modelConfigured
                      }
                      onClick={() => generate(selected)}
                    >
                      <WandSparkles size={16} /> Record to skill
                    </button>
                  </div>
                )}
              </div>
              <Timeline
                recording={selected}
                onDelete={(id) =>
                  void perform(() => window.kite!.removeEvent(selected.id, id))
                }
              />
              {selected.stoppedAt && (
                <p className="footnote">
                  “Record to skill” sends the remaining events to your
                  configured model
                  {data.settings.intelligenceConfigured
                    ? " and Intelligence project"
                    : ""}
                  . Remove private or unrelated details first.
                </p>
              )}
            </>
          ) : tab === "Overview" ||
            tab === "Recordings" ||
            tab === "Skill library" ? (
            <>
              <div className="section-top">
                <div>
                  <div className="eyebrow">YOUR EVERYDAY, A LITTLE LIGHTER</div>
                  <h1>
                    {tab === "Overview"
                      ? "Good things take practice."
                      : tab === "Recordings"
                        ? "Show me how it’s done."
                        : "A little more know-how."}
                  </h1>
                  <p>
                    {tab === "Overview"
                      ? "Do it once. Teach Kite. Make it second nature."
                      : tab === "Recordings"
                        ? "Your workflows, captured across the apps you use."
                        : "The things you’ve taught Kite, ready for next time."}
                  </p>
                </div>
                {tab !== "Overview" && (
                  <button
                    className="button primary"
                    onClick={() => setNewRecording(true)}
                    disabled={!!active}
                  >
                    <Plus size={16} /> New recording
                  </button>
                )}
              </div>
              {tab === "Overview" && (
                <>
                  <div className={"hero " + (active ? "is-recording" : "")}>
                    <div className="hero-copy">
                      <span className="hero-tag">
                        <span
                          className={active ? "record-dot" : "purple-dot"}
                        />
                        {active
                          ? "RECORDING YOUR WORKFLOW"
                          : "MEET YOUR LEARNING COMPANION"}
                      </span>
                      <h2>
                        {active ? (
                          active.title
                        ) : (
                          <>
                            Less repeating.
                            <br />
                            More doing.
                          </>
                        )}
                      </h2>
                      <p>
                        {active
                          ? "Go about your workflow. Kite is capturing the steps across your apps. Come back when you’re done."
                          : "Show Kite how you work, and turn your everyday workflows into skills that stick."}
                      </p>
                      <button
                        className="button primary"
                        disabled={working}
                        onClick={() =>
                          active
                            ? void perform(async () => {
                                const r = await window.kite!.stop();
                                setRecordingId(r.id);
                              })
                            : setNewRecording(true)
                        }
                      >
                        {active ? (
                          <>
                            <Square size={14} /> Stop & review
                          </>
                        ) : (
                          <>
                            <Circle size={14} fill="currentColor" /> Record a
                            workflow
                          </>
                        )}
                      </button>
                      {!active && (
                        <small>Across your apps. Always on your terms.</small>
                      )}
                    </div>
                    <div className="hero-art">
                      <div className="orbit orbit-one" />
                      <div className="orbit orbit-two" />
                      <div className="floating-app app-note">
                        <span />
                        <span />
                        <span />
                      </div>
                      <div className="floating-app app-grid">
                        <i />
                        <i />
                        <i />
                        <i />
                      </div>
                      <div className="floating-app app-pointer">
                        <MousePointer2 size={23} />
                      </div>
                      <Sprite />
                      <div className="art-caption">I’ll learn your way.</div>
                      <span className="spark spark-one">✧</span>
                      <span className="spark spark-two">✦</span>
                    </div>
                  </div>
                  <div className="stats">
                    <div>
                      <span className="stat-icon lilac">
                        <BookOpen size={18} />
                      </span>
                      <div>
                        <strong>
                          {count}
                          <span> skills learned</span>
                        </strong>
                        <small>Ready when you need them</small>
                      </div>
                    </div>
                    <div>
                      <span className="stat-icon peach">
                        <Radio size={18} />
                      </span>
                      <div>
                        <strong>
                          {data.recordings.filter((r) => r.stoppedAt).length}
                          <span> recordings</span>
                        </strong>
                        <small>Every workflow starts here</small>
                      </div>
                    </div>
                    <div>
                      <span className="stat-icon sage">
                        <Sparkles size={18} />
                      </span>
                      <div>
                        <strong className="stat-word">
                          {data.settings.intelligenceConfigured
                            ? "Configured"
                            : "Local first"}
                        </strong>
                        <small>
                          {data.settings.intelligenceConfigured
                            ? "Intelligence · verify in project"
                            : "Connect Intelligence to learn more"}
                        </small>
                      </div>
                    </div>
                  </div>
                </>
              )}
              {active && (
                <div className="active-strip">
                  <span className="record-dot" />
                  <strong>{active.title}</strong>
                  <span>{active.events.length} events</span>
                  <button onClick={() => setRecordingId(active.id)}>
                    View
                  </button>
                  <button
                    disabled={working}
                    onClick={() =>
                      void perform(async () => {
                        const r = await window.kite!.stop();
                        setRecordingId(r.id);
                      })
                    }
                  >
                    <Square size={12} /> Stop
                  </button>
                </div>
              )}
              {tab === "Skill library" ? (
                <>
                  <div className="section-heading">
                    <h2>
                      Your skills <span>{data.skills.length}</span>
                    </h2>
                    <label className="search">
                      <Search size={14} />
                      <input
                        aria-label="Search skills"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="Find a skill…"
                      />
                    </label>
                  </div>
                  {skills.length ? (
                    <div className="skill-grid">
                      {skills.map((s, i) => (
                        <div className="skill-card" key={s.id}>
                          <div className="skill-card-top">
                            <span
                              className={
                                "stat-icon " + ["lilac", "peach", "sage"][i % 3]
                              }
                            >
                              <BookOpen size={21} />
                            </span>
                            <span
                              className={
                                "badge " + (!s.approvedAt ? "amber" : "")
                              }
                            >
                              {s.approvedAt ? "Approved" : "Draft"}
                            </span>
                          </div>
                          <h3>{s.name}</h3>
                          <p>
                            {s.markdown
                              .match(/^description: (.+)$/m)?.[1]
                              .replace(/^"|"$/g, "") ??
                              "A workflow taught by you"}
                          </p>
                          <div className="skill-card-actions">
                            <button
                              className="text-button"
                              onClick={() =>
                                setEditor({
                                  id: s.id,
                                  name: s.name,
                                  markdown: s.markdown,
                                  recordingId: s.recordingId,
                                })
                              }
                            >
                              Edit skill
                            </button>
                            <button
                              className="icon-button"
                              title="Export SKILL.md"
                              onClick={() =>
                                void perform(async () => {
                                  if (await window.kite!.exportSkill(s.id))
                                    notify("Skill exported");
                                })
                              }
                            >
                              <ArrowDownToLine size={16} />
                            </button>
                            <button
                              className="icon-button danger"
                              title="Delete skill"
                              onClick={() => {
                                if (confirm("Delete this skill?"))
                                  void perform(() =>
                                    window.kite!.deleteSkill(s.id),
                                  );
                              }}
                            >
                              <Trash2 size={15} />
                            </button>
                          </div>
                          <button
                            className="button secondary full"
                            disabled={
                              !s.approvedAt ||
                              agentBusy ||
                              !data.settings.modelConfigured
                            }
                            onClick={() => guide(s)}
                          >
                            Use this skill <ArrowRight size={15} />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Empty
                      icon={<BookOpen size={24} />}
                      title="Your know-how belongs here."
                      body="Record something you do often. Review it, give it a name, and teach Kite your way."
                      action={() => setNewRecording(true)}
                    />
                  )}
                </>
              ) : (
                <>
                  <div className="section-heading">
                    <h2>
                      {tab === "Overview"
                        ? "Recent recordings"
                        : "All recordings"}{" "}
                      <span>{data.recordings.length}</span>
                    </h2>
                    {tab === "Overview" ? (
                      <button
                        className="text-button"
                        onClick={() => selectTab("Recordings")}
                      >
                        View all <ArrowRight size={14} />
                      </button>
                    ) : (
                      <label className="search">
                        <Search size={14} />
                        <input
                          aria-label="Search recordings"
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                          placeholder="Find a workflow…"
                        />
                      </label>
                    )}
                  </div>
                  {recordings.length ? (
                    <div className="recording-list">
                      {(tab === "Overview"
                        ? recordings.slice(0, 4)
                        : recordings
                      ).map((r) => (
                        <div className="recording-row" key={r.id}>
                          <button onClick={() => setRecordingId(r.id)}>
                            <span className="recording-symbol">
                              <Radio size={19} />
                            </span>
                            <span>
                              <strong>{r.title}</strong>
                              <small>
                                {day(r.startedAt)} ·{" "}
                                {
                                  r.events.filter(
                                    (e) =>
                                      !["status", "error"].includes(e.kind),
                                  ).length
                                }{" "}
                                events ·{" "}
                                {
                                  new Set(
                                    r.events
                                      .map((e) => e.app)
                                      .filter((a) => a && a !== "You"),
                                  ).size
                                }{" "}
                                apps
                              </small>
                            </span>
                            <span
                              className={"badge " + (!r.stoppedAt ? "red" : "")}
                            >
                              {r.stoppedAt ? "Review" : "Recording"}
                            </span>
                            <ChevronRight size={16} />
                          </button>
                          {r.stoppedAt && (
                            <button
                              className="icon-button danger"
                              title="Delete recording"
                              onClick={() => {
                                if (
                                  confirm(
                                    "Delete this recording and all captured events?",
                                  )
                                )
                                  void perform(() =>
                                    window.kite!.deleteRecording(r.id),
                                  );
                              }}
                            >
                              <Trash2 size={15} />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Empty
                      icon={<Radio size={24} />}
                      title="Your first workflow is a good place to start."
                      body="Try a small routine: organize a file, prepare a report, or move something between apps."
                      action={() => setNewRecording(true)}
                    />
                  )}
                </>
              )}
              {tab === "Overview" && (
                <div className="learning-callout">
                  <span className="stat-icon lilac">
                    <Sparkles size={19} />
                  </span>
                  <div>
                    <strong>A companion that gets better with you.</strong>
                    <p>
                      Connect CopilotKit Intelligence to discover patterns and
                      improve your skills.
                    </p>
                  </div>
                  <button
                    title="Set up learning"
                    onClick={() => selectTab("Learning")}
                  >
                    <ArrowRight size={19} />
                  </button>
                </div>
              )}
            </>
          ) : tab === "Learning" ? (
            <>
              <div className="section-top">
                <div className="eyebrow">
                  POWERED BY COPILOTKIT INTELLIGENCE
                </div>
                <h1>Practice makes progress.</h1>
                <p>
                  Turn your real workflows into knowledge that travels with you.
                </p>
              </div>
              <div className="learning-flow">
                {[
                  {
                    n: "01",
                    title: "Capture the workflow",
                    body: "Record across your Mac. Review the evidence before it leaves your device.",
                    icon: Radio,
                  },
                  {
                    n: "02",
                    title: "Discover what works",
                    body: "Intelligence analyzes completed threads and proposes reusable skills.",
                    icon: Sparkles,
                  },
                  {
                    n: "03",
                    title: "Bring it back to Kite",
                    body: "Review and publish skills in Intelligence. Kite loads them on future runs.",
                    icon: BookOpen,
                  },
                ].map(({ n, title, body, icon: Icon }) => (
                  <div key={n}>
                    <span>{n}</span>
                    <Icon size={23} />
                    <h3>{title}</h3>
                    <p>{body}</p>
                  </div>
                ))}
              </div>
              <div className="settings-card">
                <h2>Your learning connection</h2>
                <Setting
                  label="Project key"
                  value={
                    data.settings.intelligenceConfigured
                      ? "Configured"
                      : "Not configured"
                  }
                />
                <Setting
                  label="Skill delivery"
                  value={data.settings.deliveryStatus}
                />
                <Setting
                  label="Learning container"
                  value={data.settings.containerId}
                />
                <Setting label="Model" value={data.settings.model} />
                <Setting
                  label="Model API key"
                  value={
                    data.settings.modelConfigured ? "Available" : "Missing"
                  }
                />
                <p className="footnote">
                  Both ingestion and skill delivery use this container. Create
                  it in your Intelligence project and enable skill delivery.
                  Automatic analyses follow the project’s schedule and require
                  eligible completed threads.
                </p>
                <button
                  className="button secondary"
                  disabled={working || !data.settings.intelligenceConfigured}
                  onClick={() =>
                    void perform(() => window.kite!.verifyIntelligence())
                  }
                >
                  {working ? "Checking…" : "Verify connection"}
                </button>
                <button
                  className="button primary"
                  onClick={() => void window.kite!.openIntelligence()}
                >
                  Open Intelligence <ExternalLink size={15} />
                </button>
              </div>
              <div className="setup-note">
                <strong>Connect your project</strong>
                <p>
                  From this project directory, sign in and select your
                  Intelligence project. Set your model key in the runtime
                  environment, then restart Kite.
                </p>
                <pre>
                  npx copilotkit@latest login{"\n"}npx copilotkit@latest project
                  select
                </pre>
                <p>
                  Local “Record to skill” drafts stay in your library.
                  Publishing a local file directly to Intelligence is not part
                  of this integration.
                </p>
              </div>
            </>
          ) : tab === "Settings" ? (
            <>
              <div className="section-top">
                <h1>Make yourself at home.</h1>
                <p>A few permissions help Kite work alongside you.</p>
              </div>
              <div className="settings-card">
                <h2>macOS permissions</h2>
                {(["accessibility", "screenCapture"] as const).map((kind) => (
                  <div className="permission-row" key={kind}>
                    <span className="stat-icon lilac">
                      {kind === "accessibility" ? (
                        <MousePointer2 size={18} />
                      ) : (
                        <Monitor size={18} />
                      )}
                    </span>
                    <div>
                      <strong>
                        {kind === "accessibility"
                          ? "Accessibility"
                          : "Screen Recording"}
                      </strong>
                      <p>
                        {kind === "accessibility"
                          ? "Read app context and observe clicks and shortcuts during recordings."
                          : "Attach a primary-screen screenshot to a message when you choose."}
                      </p>
                    </div>
                    <button
                      className="button secondary"
                      disabled={working}
                      onClick={() =>
                        void perform(() => window.kite!.permissions(kind))
                      }
                    >
                      {data.permissions[kind] ? (
                        <>
                          <Check size={14} /> Granted
                        </>
                      ) : (
                        "Enable"
                      )}
                    </button>
                  </div>
                ))}
                <button className="text-button" onClick={() => void refresh()}>
                  Refresh permissions
                </button>
                <p className="footnote">
                  macOS may require restarting Kite after a permission change.
                  Development permission labels may say Electron or
                  kite-recorder.
                </p>
              </div>
              <div className="settings-card">
                <h2>Codex agent</h2>
                <Setting label="Engine" value={data.settings.backend} />
                <Setting label="Model" value={data.settings.model} />
                <Setting
                  label="Working folder"
                  value={data.settings.workspace}
                />
                <button
                  className="button secondary"
                  disabled={working || agentBusy}
                  onClick={() =>
                    void perform(() => window.kite!.chooseWorkspace())
                  }
                >
                  Choose working folder
                </button>
                <p className="footnote">
                  Codex can edit files and run commands in this folder. Start a
                  new conversation after changing folders. Desktop actions still
                  ask for approval.
                </p>
                <h2>Model connection</h2>
                <p>
                  Connect an OpenAI key for this session. Kept in memory and
                  cleared when Kite quits.
                </p>
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const key = modelKey;
                    setModelKey("");
                    void perform(() => window.kite!.setModelKey(key));
                  }}
                >
                  <input
                    type="password"
                    aria-label="OpenAI API key"
                    autoComplete="off"
                    placeholder="OpenAI API key"
                    value={modelKey}
                    onChange={(event) => setModelKey(event.target.value)}
                  />
                  <button
                    className="button secondary"
                    disabled={working || agentBusy || !modelKey.trim()}
                  >
                    Use key for this session
                  </button>
                </form>
                <Setting
                  label="Model"
                  value={
                    data.settings.modelConfigured ? "Connected" : "Key required"
                  }
                />
              </div>
              <div className="settings-card">
                <h2>Your workspace</h2>
                <Setting label="Show / hide Kite" value="⌘ ⇧ K" />
                <Setting
                  label="Recording storage"
                  value="Local · Application Support/Kite/library"
                />
                <Setting label="Ordinary typed text" value="Not captured" />
                <Setting
                  label="Screenshots"
                  value="Attached on demand · not saved to recordings"
                />
                <p className="footnote">
                  App titles and accessible control labels can contain personal
                  information. Review and remove events before generating a
                  skill. Screenshots you send are processed by your model and
                  may be retained in your Intelligence thread.
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="section-top">
                <h1>Show. Teach. Repeat.</h1>
                <p>A small companion for the work you do every day.</p>
              </div>
              <div className="settings-card">
                <h2>Start with a real routine</h2>
                <ol className="help-list">
                  <li>
                    <strong>Record a workflow.</strong> Name the task and do it
                    across your Mac. Add notes to explain your intent.
                  </li>
                  <li>
                    <strong>Stop and review.</strong> Remove unrelated events.
                    Ordinary text is omitted; add only the details needed to
                    teach the workflow.
                  </li>
                  <li>
                    <strong>Create a skill.</strong> Generate with your
                    configured model or start a manual draft. Edit and approve
                    the instructions.
                  </li>
                  <li>
                    <strong>Use it next time.</strong> Open your library and
                    choose “Use this skill.” Kite loads it and guides you step
                    by step.
                  </li>
                  <li>
                    <strong>Let experience improve it.</strong> Connect
                    Intelligence to collect runs, review proposed improvements,
                    and deliver published skills.
                  </li>
                </ol>
                <p>
                  In this version, Kite can guide any recorded workflow, open
                  apps, and point on screen with approval. It does not
                  automatically click or type through arbitrary applications.
                </p>
              </div>
            </>
          )}
        </div>
        {active && (
          <form
            className="record-note"
            onSubmit={(e) => {
              e.preventDefault();
              if (note.trim())
                void perform(async () => {
                  await window.kite!.note(note);
                  setNote("");
                });
            }}
          >
            <span className="record-dot" />
            <input
              aria-label="Add a recording note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Explain what you’re doing… add a note to this recording"
            />
            <button disabled={!note.trim() || working}>
              <Plus size={17} /> Add note
            </button>
          </form>
        )}
        <div className="workspace-footer">
          <span>
            <ShieldCheck size={12} /> You choose what Kite sees.
          </span>
          <span>
            Kite v0.1 <span className="footer-dot">·</span> Built with AG-UI
          </span>
        </div>
      </div>
      <Assistant
        settings={data.settings}
        request={request}
        onDraft={(markdown) => {
          if (draftFor)
            setEditor({
              name: draftFor.title,
              markdown,
              recordingId: draftFor.id,
            });
        }}
        onDone={() => setRequest(null)}
        onBusy={setAgentBusy}
      />
      {newRecording && (
        <div className="modal-backdrop">
          <form
            className="modal"
            onSubmit={(e) => {
              e.preventDefault();
              void perform(async () => {
                await window.kite!.start(title);
                setNewRecording(false);
                setTitle("");
                setTab("Overview");
                setRecordingId("");
                notify("Recording started. Go about your workflow.");
              });
            }}
          >
            <button
              type="button"
              className="modal-close icon-button"
              title="Close"
              onClick={() => setNewRecording(false)}
            >
              <X size={19} />
            </button>
            <span className="stat-icon lilac">
              <Radio size={24} />
            </span>
            <h2>Show Kite your way.</h2>
            <p>
              Give this workflow a name, then do it naturally across your apps.
            </p>
            <label>
              WORKFLOW NAME
              <input
                autoFocus
                placeholder="e.g. Prepare my weekly report"
                value={title}
                maxLength={160}
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <div className="capture-details">
              <Check size={14} /> App switches, clicks & keyboard shortcuts
              <br />
              <Check size={14} /> Add notes to explain your intent
              <br />
              <ShieldCheck size={14} /> Ordinary typing is not captured
            </div>
            {!data.permissions.accessibility && (
              <p className="inline-error">
                Enable Accessibility in Settings before recording.
              </p>
            )}
            <button
              className="button primary full"
              disabled={
                working || !title.trim() || !data.permissions.accessibility
              }
            >
              {working ? (
                <LoaderCircle className="spin" size={16} />
              ) : (
                <Circle fill="currentColor" size={13} />
              )}{" "}
              Start recording
            </button>
            <small>
              Recording stays local until you choose “Record to skill.”
            </small>
          </form>
        </div>
      )}
    </div>
  );
}
function Empty({
  icon,
  title,
  body,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  action: () => void;
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">{icon}</span>
      <h3>{title}</h3>
      <p>{body}</p>
      <button className="text-button" onClick={action}>
        Record your first workflow <ArrowRight size={14} />
      </button>
    </div>
  );
}
function Setting({ label, value }: { label: string; value: string }) {
  return (
    <div className="setting">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
function Timeline({
  recording,
  onDelete,
}: {
  recording: Recording;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="timeline">
      {recording.events.length === 0 ? (
        <div className="empty-state">
          <Radio size={22} />
          <h3>Waiting for your first step…</h3>
          <p>Switch to another app and start your workflow.</p>
        </div>
      ) : (
        recording.events.map((e) => (
          <div className={"timeline-event " + e.kind} key={e.id}>
            <span className="event-icon">
              {e.kind === "click" ? (
                <MousePointer2 size={15} />
              ) : e.kind === "shortcut" ? (
                <Command size={15} />
              ) : e.kind === "note" ? (
                <Mic size={15} />
              ) : e.kind === "app" ? (
                <Monitor size={15} />
              ) : (
                <Circle size={12} />
              )}
            </span>
            <div>
              <strong>
                {e.app || "Kite"} <span>{e.kind}</span>
              </strong>
              <p>{e.detail}</p>
              {e.title && <small>{e.title}</small>}
            </div>
            <time>{time(e.timestamp)}</time>
            {recording.stoppedAt && (
              <button
                title="Remove event"
                className="icon-button danger"
                onClick={() => onDelete(e.id)}
              >
                <Trash2 size={13} />
              </button>
            )}
          </div>
        ))
      )}
    </div>
  );
}
