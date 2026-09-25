import "dotenv/config";
import {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
  screen,
  dialog,
  shell,
  desktopCapturer,
  session,
  Menu,
  Tray,
  nativeImage,
} from "electron";
import {
  spawn,
  execFile,
  type ChildProcessWithoutNullStreams,
} from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { join, dirname, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { Store } from "./store";
import {
  loadPreferences,
  savePreferences,
  companionSchema,
  placementSchema,
} from "./preferences";
import { notchPosition } from "./notch-geometry";
import {
  CHAT_SIZE,
  RECORD_SIZE,
  companionTrayPosition,
} from "./companion-chat-position";
import { loadLinkedEnvironment } from "./environment";
import { trayIcon } from "./tray-icon";
import {
  BUDDY_SIZE,
  beginBuddyGesture,
  advanceBuddyGesture,
  type BuddyGesture,
  clampBuddyPosition,
  loadBuddyPosition,
  saveBuddyPosition,
} from "./buddy-position";
import type { Point } from "../src/buddy-drag";
import { startRuntime } from "../server/runtime";
import {
  ScreenshotRegistry,
  captureSize,
  fitsPromptBudget,
  pngSize,
  screenPoint,
} from "../server/screenshots";
import type {
  CompanionTrayMode,
  Permissions,
  ScreenshotAttachment,
  Settings,
} from "../src/types";

// Preserve the installed app's data across the display-name rebrand.
app.setPath("userData", join(app.getPath("appData"), "Kite"));
app.setName("OpenMuse Desktop");
if (process.env.KITE_DATA_DIR)
  app.setPath("userData", process.env.KITE_DATA_DIR);
const root = app.getAppPath();
const helper = app.isPackaged
  ? join(process.resourcesPath, "kite-recorder")
  : join(root, "native/bin/kite-recorder");
const exec = promisify(execFile);
const screenshots = new ScreenshotRegistry();
let workspace: BrowserWindow;
let buddy: BrowserWindow;
let notch: BrowserWindow;
let companionChat: BrowserWindow;
let trayMode: CompanionTrayMode = "chat";
let notchExpanded = false;
let accessibilityGuideActive = false;
let notchTopInset = 0;
let appDragIcon: Electron.NativeImage;
let tray: Tray;
let buddyPosition: Point | undefined;
let buddyGesture: BuddyGesture | undefined;
let buddySaveQueue = Promise.resolve();
const buddyPositionPath = () =>
  join(app.getPath("userData"), "buddy-position.json");
const appBundlePath = () => resolve(app.getPath("exe"), "../../..");
const buddyAreas = () =>
  screen.getAllDisplays().map((display) => display.workArea);
function notchSize() {
  return !settings?.onboardingComplete
    ? accessibilityGuideActive
      ? { width: 460, height: 190 }
      : { width: 460, height: 640 }
    : notchExpanded
      ? { width: 360, height: 260 }
      : { width: 250, height: 62 };
}
function fittedNotchBounds() {
  const display = screen.getPrimaryDisplay();
  const requested = notchSize();
  const location = notchPosition(display, notchTopInset, requested);
  const bounds = {
    ...location,
    width: requested.width,
    height: Math.max(
      1,
      Math.min(
        requested.height,
        display.workArea.y + display.workArea.height - location.y - 8,
      ),
    ),
  };
  if (accessibilityGuideActive && !settings?.onboardingComplete)
    bounds.y = Math.max(
      display.workArea.y,
      display.workArea.y + display.workArea.height - bounds.height - 20,
    );
  return bounds;
}
function positionNotch() {
  if (!notch || notch.isDestroyed()) return;
  notch.setBounds(fittedNotchBounds());
}
async function refreshNotchInset() {
  const { stdout } = await exec(helper, ["--notch-inset"]);
  notchTopInset = z
    .object({ topInset: z.number().nonnegative() })
    .parse(JSON.parse(stdout)).topInset;
  positionNotch();
}
function syncCompanionWindows() {
  if (!buddy || !notch || !settings) return;
  positionNotch();
  if (!settings.onboardingComplete || settings.placement === "notch") {
    buddy.hide();
    companionChat?.hide();
    notch.showInactive();
  } else {
    notch.hide();
    buddy.showInactive();
  }
}
function positionCompanionChat() {
  if (!companionChat || companionChat.isDestroyed() || !buddy) return;
  const point = companionTrayPosition(
    buddy.getBounds(),
    buddyAreas(),
    trayMode === "chat" ? CHAT_SIZE : RECORD_SIZE,
  );
  companionChat.setPosition(point.x, point.y);
}
function openCompanionTray(mode: CompanionTrayMode, toggle = false) {
  if (settings.placement !== "floating" || !settings.onboardingComplete)
    throw new Error("Select the floating companion to open its controls");
  if (toggle && companionChat.isVisible() && trayMode === mode) {
    companionChat.hide();
  } else {
    trayMode = mode;
    const size = mode === "chat" ? CHAT_SIZE : RECORD_SIZE;
    companionChat.setSize(size.width, size.height);
    positionCompanionChat();
    companionChat.show();
    companionChat.focus();
    broadcast();
  }
}
function persistBuddyPosition() {
  const [x, y] = buddy.getPosition();
  const save = buddySaveQueue.then(() =>
    saveBuddyPosition(buddyPositionPath(), { x, y }),
  );
  // A failed save is reported to its caller; subsequent gestures can retry.
  buddySaveQueue = save.catch(() => {});
  return save;
}
function moveBuddy(cursor: Point) {
  if (!buddyGesture) return;
  const point = advanceBuddyGesture(buddyGesture, cursor, buddyAreas());
  if (point) {
    buddy.setPosition(point.x, point.y);
    if (companionChat?.isVisible()) positionCompanionChat();
  }
}
let recorder: ChildProcessWithoutNullStreams | null = null;
let store: Store;
let settings: Settings;
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let recordingQueue = Promise.resolve();
let transitioning = false;
const broadcast = () =>
  BrowserWindow.getAllWindows().forEach((w) =>
    w.webContents.send("kite:update"),
  );
async function approvedAction(input: unknown) {
  const action = z
    .discriminatedUnion("type", [
      z.object({
        type: z.literal("open-app"),
        bundleId: z.string().regex(/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/),
      }),
      z.object({
        type: z.literal("point"),
        screenshotId: z.string().regex(/^shot_[0-9a-f]{8}$/),
        x: z.number().finite(),
        y: z.number().finite(),
        label: z.string().trim().min(1).max(60),
      }),
    ])
    .parse(input);
  let detail: string;
  let args: string[];
  if (action.type === "open-app") {
    detail = `Open application ${action.bundleId}`;
    args = ["--open-app", action.bundleId];
  } else {
    const shot = screenshots.get(action.screenshotId);
    if (!shot)
      throw new Error(
        "That screenshot is no longer available. Ask the user to attach a new one.",
      );
    const display = screen
      .getAllDisplays()
      .find((candidate) => String(candidate.id) === shot.displayId);
    // Check the geometry before asking, so the user never approves a point that cannot land.
    const point = screenPoint(shot, action, display?.bounds);
    detail = `Point at “${action.label}” on ${shot.label}`;
    args = ["--point", String(point.x), String(point.y)];
  }
  const result = await dialog.showMessageBox(workspace, {
    type: "question",
    title: "OpenMuse wants to take an action",
    message: detail,
    buttons: ["Cancel", "Allow once"],
    defaultId: 0,
    cancelId: 0,
  });
  if (result.response !== 1) throw new Error("User declined action");
  const { stdout } = await exec(helper, args);
  const events = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const error = events.find((e) => e.kind === "error");
  if (error) throw new Error(error.detail);
}

async function permissions(): Promise<Permissions> {
  const { stdout } = await exec(helper, ["--permissions"]);
  return z
    .object({ accessibility: z.boolean(), screenCapture: z.boolean() })
    .parse(JSON.parse(stdout));
}
const eventSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  kind: z.enum(["app", "click", "shortcut", "error", "status"]),
  app: z.string(),
  bundleId: z.string(),
  title: z.string(),
  detail: z.string(),
  x: z.number().optional(),
  y: z.number().optional(),
});
async function finishRecording() {
  if (transitioning) throw new Error("Recording is changing state");
  transitioning = true;
  try {
    const child = recorder;
    recorder = null;
    if (child) {
      child.stdin.write('{"command":"stop"}\n');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill();
          resolve();
        }, 1500);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await recordingQueue;
    const result = await store.stop();
    broadcast();
    return result;
  } finally {
    transitioning = false;
  }
}
async function startRecording(title: string) {
  if (transitioning || recorder || store.active)
    throw new Error("Recording is already active or changing state");
  transitioning = true;
  try {
    if (!(await permissions()).accessibility)
      throw new Error(
        "Enable Accessibility for OpenMuse Desktop in System Settings, then retry.",
      );
    const recording = await store.start(title);
    const child = spawn(helper, [], { stdio: ["pipe", "pipe", "pipe"] });
    recorder = child;
    const lines = createInterface({ input: child.stdout });
    let readyResolve: () => void;
    let readyReject: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const timer = setTimeout(
      () => readyReject(new Error("Native recorder did not become ready")),
      5000,
    );
    lines.on("line", (line) => {
      try {
        const event = eventSchema.parse(JSON.parse(line));
        if (event.kind === "error") readyReject(new Error(event.detail));
        if (event.kind === "status" && event.detail === "Recording started")
          readyResolve();
        recordingQueue = recordingQueue
          .then(async () => {
            if (store.active?.id === recording.id) {
              await store.append(event);
              broadcast();
            }
          })
          .catch(async () => {
            child.kill();
            await dialog.showMessageBox({
              type: "error",
              message: "Recording stopped because an event could not be saved.",
            });
          });
      } catch {
        readyReject(new Error("Invalid native recorder event"));
      }
    });
    child.on("error", (error) => readyReject(error));
    child.on("exit", () => {
      clearTimeout(timer);
      lines.close();
      readyReject(new Error("Native recorder exited"));
      if (recorder === child) {
        recorder = null;
        recordingQueue = recordingQueue
          .then(async () => {
            if (store.active) {
              await store.stop();
              broadcast();
            }
          })
          .catch(async () => {
            broadcast();
            await dialog.showMessageBox({
              type: "error",
              message:
                "Could not finalize the recording. Retry Stop or restart OpenMuse Desktop.",
            });
          });
      }
    });
    child.stderr.on("data", () => {}); // Native diagnostic text can contain app metadata; do not log it.
    child.stdin.write('{"command":"start"}\n');
    try {
      await ready;
    } catch (error) {
      child.kill();
      recorder = null;
      await recordingQueue;
      if (store.active) await store.stop();
      broadcast();
      throw error;
    } finally {
      clearTimeout(timer);
    }
    broadcast();
    return recording;
  } finally {
    transitioning = false;
  }
}
function openWorkspace() {
  if (!workspace || workspace.isDestroyed()) return;
  if (companionChat && !companionChat.isDestroyed()) companionChat.hide();
  workspace.show();
  workspace.focus();
}
function makeWindow(isBuddy: boolean) {
  const display = screen.getPrimaryDisplay().workArea;
  const position = isBuddy
    ? clampBuddyPosition(
        buddyPosition ?? {
          x: display.x + display.width - 258,
          y: display.y + display.height - 190,
        },
        buddyAreas(),
      )
    : undefined;
  const win = new BrowserWindow({
    width: isBuddy ? BUDDY_SIZE.width : 1240,
    height: isBuddy ? BUDDY_SIZE.height : 820,
    minWidth: isBuddy ? 240 : 960,
    minHeight: isBuddy ? 170 : 650,
    x: position?.x,
    y: position?.y,
    show: false,
    title: "OpenMuse Desktop",
    backgroundColor: isBuddy ? "#00000000" : "#fcfcfc",
    transparent: isBuddy,
    frame: !isBuddy,
    ...(!isBuddy ? { titleBarStyle: "hiddenInset" as const } : {}),
    resizable: !isBuddy,
    alwaysOnTop: isBuddy,
    acceptFirstMouse: isBuddy,
    skipTaskbar: isBuddy,
    webPreferences: {
      preload: join(dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  if (isBuddy)
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  if (process.env.KITE_DEV_URL)
    void win.loadURL(process.env.KITE_DEV_URL + (isBuddy ? "?buddy=1" : ""));
  else
    void win.loadFile(join(root, "dist/renderer/index.html"), {
      query: isBuddy ? { buddy: "1" } : {},
    });
  win.once("ready-to-show", () => {
    if (isBuddy) syncCompanionWindows();
    else if (settings.placement !== "floating" || !settings.onboardingComplete)
      win.show();
  });
  win.on("close", (event) => {
    if (!(app as typeof app & { quitting?: boolean }).quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  return win;
}
function makeCompanionChatWindow() {
  const win = new BrowserWindow({
    ...CHAT_SIZE,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    skipTaskbar: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  const loaded = process.env.KITE_DEV_URL
    ? win.loadURL(process.env.KITE_DEV_URL + "?companionChat=1")
    : win.loadFile(join(root, "dist/renderer/index.html"), {
        query: { companionChat: "1" },
      });
  void loaded.catch((error: unknown) =>
    dialog.showErrorBox(
      "OpenMuse chat could not load",
      error instanceof Error ? error.message : "Unknown loading error",
    ),
  );
  win.on("close", (event) => {
    if (!(app as typeof app & { quitting?: boolean }).quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  return win;
}
function makeNotchWindow() {
  const bounds = fittedNotchBounds();
  const win = new BrowserWindow({
    ...bounds,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    acceptFirstMouse: true,
    skipTaskbar: true,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: join(dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  if (process.env.KITE_DEV_URL)
    void win.loadURL(process.env.KITE_DEV_URL + "?notch=1");
  else
    void win.loadFile(join(root, "dist/renderer/index.html"), {
      query: { notch: "1" },
    });
  win.once("ready-to-show", syncCompanionWindows);
  win.webContents.once("did-finish-load", syncCompanionWindows);
  win.on("close", (event) => {
    if (!(app as typeof app & { quitting?: boolean }).quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  return win;
}
const text = z.string().max(12000);
function handle(name: string, fn: (...args: unknown[]) => unknown) {
  ipcMain.handle("kite:" + name, (event, ...args) => {
    if (
      ![
        workspace?.webContents,
        buddy?.webContents,
        notch?.webContents,
        companionChat?.webContents,
      ].includes(event.sender) ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error("Untrusted IPC sender");
    return fn(...args);
  });
}
app
  .whenReady()
  .then(async () => {
    store = new Store(join(app.getPath("userData"), "library"));
    await store.load();
    await loadLinkedEnvironment(app.getPath("userData"));
    runtime = await startRuntime(store, {
      statePath: join(app.getPath("userData"), "agent"),
      binaryPath: app.isPackaged
        ? join(process.resourcesPath, "codex-runtime/bin/codex")
        : undefined,
      action: approvedAction,
      screenshots,
    });
    settings = runtime.settings;
    const preferencesPath = join(app.getPath("userData"), "preferences.json");
    const savedPreferences = await loadPreferences(preferencesPath);
    settings.companion = savedPreferences.companion;
    settings.placement = savedPreferences.placement;
    settings.onboardingComplete = savedPreferences.onboardingComplete;
    let preferenceQueue = Promise.resolve();
    function updatePreferences(change: Partial<typeof savedPreferences>) {
      const update = preferenceQueue.then(async () => {
        const next = await savePreferences(preferencesPath, {
          companion: settings.companion,
          placement: settings.placement,
          onboardingComplete: settings.onboardingComplete,
          ...change,
        });
        settings.companion = next.companion;
        settings.placement = next.placement;
        settings.onboardingComplete = next.onboardingComplete;
        if ("onboardingComplete" in change) {
          notchExpanded = false;
          accessibilityGuideActive = false;
        }
        syncCompanionWindows();
        broadcast();
      });
      // Return the failed write to this caller while keeping later saves retryable.
      preferenceQueue = update.catch(() => {});
      return update;
    }
    handle("setCompanion", (input) =>
      updatePreferences({ companion: companionSchema.parse(input) }),
    );
    handle("setPlacement", (input) =>
      updatePreferences({ placement: placementSchema.parse(input) }),
    );
    handle("completeOnboarding", () =>
      updatePreferences({ onboardingComplete: true }),
    );
    handle("replayOnboarding", () =>
      updatePreferences({ onboardingComplete: false }),
    );
    handle("revealAppInFinder", () => {
      shell.showItemInFolder(app.isPackaged ? appBundlePath() : root);
    });
    ipcMain.handle("kite:openAccessibilitySettings", async (event) => {
      if (
        event.sender !== notch?.webContents ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error("Untrusted setup sender");
      accessibilityGuideActive = true;
      positionNotch();
      try {
        await shell.openExternal(
          "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
        );
      } catch (error) {
        accessibilityGuideActive = false;
        positionNotch();
        throw error;
      }
    });
    ipcMain.handle("kite:closeAccessibilityGuide", (event) => {
      if (
        event.sender !== notch?.webContents ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error("Untrusted setup sender");
      accessibilityGuideActive = false;
      positionNotch();
    });
    handle("setNotchExpanded", (input) => {
      notchExpanded = z.boolean().parse(input);
      if (settings.onboardingComplete) positionNotch();
    });
    ipcMain.on("kite:startAppDrag", (event) => {
      if (
        event.sender !== notch?.webContents ||
        event.senderFrame !== event.sender.mainFrame ||
        !app.isPackaged
      )
        return;
      event.sender.startDrag({ file: appBundlePath(), icon: appDragIcon });
    });
    session.defaultSession.setPermissionRequestHandler(
      (_wc, _permission, callback) => callback(false),
    );
    handle("chooseWorkspace", async () => {
      const result = await dialog.showOpenDialog(workspace, {
        title: "Choose OpenMuse's working folder",
        message: "Codex can edit files and run commands in this folder.",
        properties: ["openDirectory", "createDirectory"],
        defaultPath: settings.workspace,
      });
      if (result.canceled || !result.filePaths[0]) return;
      await runtime.setWorkspace(result.filePaths[0]);
      broadcast();
    });
    handle("setModelKey", async (key) => {
      runtime.setModelKey(key);
      broadcast();
    });
    handle("verifyIntelligence", async () => {
      settings.deliveryStatus = await runtime.checkIntelligence();
      broadcast();
    });
    handle("state", async () => ({
      recordings: store.recordings,
      skills: store.skills,
      active: store.active,
      permissions: await permissions(),
      settings,
      trayMode,
    }));
    handle("reviewedRecording", async (id) => {
      await store.flush();
      const recording = store.recordings.find(
        (r) => r.id === z.string().parse(id),
      );
      if (!recording?.stoppedAt)
        throw new Error("A completed recording is required");
      return structuredClone(recording);
    });
    handle("start", (title) =>
      startRecording(z.string().min(1).max(160).parse(title)),
    );
    handle("stop", finishRecording);
    handle("note", async (value) => {
      const note = text.min(1).parse(value);
      await store.append({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        kind: "note",
        app: "You",
        bundleId: "",
        title: "Narration",
        detail: note,
      });
      broadcast();
    });
    handle("removeEvent", async (r, e) => {
      await store.removeEvent(z.string().parse(r), z.string().parse(e));
      broadcast();
    });
    handle("deleteRecording", async (id) => {
      await store.deleteRecording(z.string().parse(id));
      broadcast();
    });
    handle("saveSkill", async (input) => {
      const skill = await store.saveSkill(
        z
          .object({
            id: z.string().optional(),
            name: z.string(),
            markdown: z.string(),
            recordingId: z.string(),
            approve: z.boolean(),
          })
          .parse(input),
      );
      broadcast();
      return skill;
    });
    handle("deleteSkill", async (id) => {
      await store.deleteSkill(z.string().parse(id));
      broadcast();
    });
    handle("exportSkill", async (id) => {
      const skill = store.skills.find((s) => s.id === id);
      if (!skill) throw new Error("Skill not found");
      const result = await dialog.showSaveDialog(workspace, {
        title: "Export workflow skill",
        defaultPath: "SKILL.md",
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (result.canceled || !result.filePath) return false;
      await writeFile(result.filePath, skill.markdown, { mode: 0o600 });
      return true;
    });
    handle("permissions", async (kind) => {
      z.enum(["accessibility", "screenCapture"]).parse(kind);
      await exec(helper, [
        kind === "accessibility"
          ? "--request-accessibility"
          : "--request-screen",
      ]);
      return permissions();
    });
    handle("screenshot", async (): Promise<ScreenshotAttachment> => {
      if (!(await permissions()).screenCapture)
        throw new Error("Enable Screen Recording permission in Settings.");
      const display = screen.getPrimaryDisplay();
      const target = captureSize(display.size);
      const restoreWorkspace = workspace.isVisible();
      const restoreBuddy = buddy.isVisible();
      const restoreNotch = notch.isVisible();
      const restoreChat = companionChat.isVisible();
      workspace.hide();
      buddy.hide();
      notch.hide();
      companionChat.hide();
      try {
        await new Promise((resolve) => setTimeout(resolve, 200));
        const sources = await desktopCapturer.getSources({
          types: ["screen"],
          thumbnailSize: target,
        });
        // A capture of another display would put the pointer in the wrong place.
        const source = sources.find(
          (candidate) => candidate.display_id === String(display.id),
        );
        if (!source || source.thumbnail.isEmpty())
          throw new Error("Screen capture unavailable");
        let png = source.thumbnail.toPNG();
        if (!fitsPromptBudget(pngSize(png)))
          png = source.thumbnail.resize(target).toPNG();
        const size = pngSize(png);
        if (!fitsPromptBudget(size))
          throw new Error(
            "Screen capture is too large to send without resizing",
          );
        const shot = screenshots.add({
          displayId: String(display.id),
          label: display.label || "the main display",
          bounds: display.bounds,
          ...size,
        });
        return {
          id: shot.id,
          label: shot.label,
          width: size.width,
          height: size.height,
          dataUrl: "data:image/png;base64," + png.toString("base64"),
        };
      } finally {
        if (restoreWorkspace) workspace.show();
        if (restoreBuddy) buddy.showInactive();
        if (restoreNotch) notch.showInactive();
        if (restoreChat) companionChat.showInactive();
      }
    });
    handle("action", approvedAction);
    handle("openWorkspace", openWorkspace);
    ipcMain.handle("kite:toggleCompanionChat", (event) => {
      if (
        event.sender !== buddy?.webContents ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error("Untrusted companion chat sender");
      openCompanionTray("chat", true);
    });
    ipcMain.handle("kite:openCompanionTray", (event, input) => {
      if (
        event.sender !== buddy?.webContents ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error("Untrusted companion tray sender");
      openCompanionTray(z.enum(["chat", "record"]).parse(input));
    });
    ipcMain.handle("kite:closeCompanionChat", (event) => {
      if (
        event.sender !== companionChat?.webContents ||
        event.senderFrame !== event.sender.mainFrame
      )
        throw new Error("Untrusted companion chat sender");
      companionChat.hide();
    });
    handle("openIntelligence", () =>
      shell.openExternal("https://dashboard.operations.copilotkit.ai"),
    );
    buddyPosition = await loadBuddyPosition(buddyPositionPath());
    ipcMain.handle(
      "kite:buddyDrag",
      (event, input: unknown, coordinates: unknown) => {
        if (
          event.sender !== buddy?.webContents ||
          event.senderFrame !== event.sender.mainFrame
        )
          throw new Error("Untrusted companion drag sender");
        const action = z.enum(["begin", "move", "end"]).parse(input);
        const cursor = z
          .object({
            x: z.number().finite().min(-1_000_000).max(1_000_000),
            y: z.number().finite().min(-1_000_000).max(1_000_000),
          })
          .strict()
          .parse(coordinates);
        if (action === "begin") {
          buddyGesture = beginBuddyGesture(cursor, buddy.getBounds());
        } else if (action === "move") moveBuddy(cursor);
        else if (buddyGesture) {
          moveBuddy(cursor);
          const moved = buddyGesture.moved;
          buddyGesture = undefined;
          if (moved) return persistBuddyPosition();
        }
      },
    );
    await refreshNotchInset();
    const bundledIcon = nativeImage.createFromPath(
      join(root, "dist/renderer/capybara.png"),
    );
    appDragIcon = bundledIcon.isEmpty()
      ? nativeImage.createFromDataURL(trayIcon)
      : bundledIcon.resize({ width: 64, height: 64 });
    workspace = makeWindow(false);
    buddy = makeWindow(true);
    notch = makeNotchWindow();
    companionChat = makeCompanionChatWindow();
    const restoreVisibleBuddy = () => {
      buddyGesture = undefined;
      const [x, y] = buddy.getPosition();
      const position = clampBuddyPosition({ x, y }, buddyAreas());
      buddy.setPosition(position.x, position.y);
      positionCompanionChat();
      void persistBuddyPosition().catch((error: unknown) =>
        dialog.showMessageBox({
          type: "error",
          message: "Could not save companion position",
          detail: error instanceof Error ? error.message : "Unknown save error",
        }),
      );
    };
    function reflowDisplays() {
      restoreVisibleBuddy();
      void refreshNotchInset().catch((error: unknown) =>
        dialog.showMessageBox({
          type: "error",
          message: "Could not reposition the notch companion",
          detail: error instanceof Error ? error.message : "Unknown error",
        }),
      );
    }
    screen.on("display-removed", reflowDisplays);
    screen.on("display-added", reflowDisplays);
    screen.on("display-metrics-changed", reflowDisplays);
    if (
      !globalShortcut.register("CommandOrControl+Shift+K", () => {
        if (workspace.isVisible() && workspace.isFocused()) workspace.hide();
        else openWorkspace();
      })
    )
      await dialog.showMessageBox(workspace, {
        type: "warning",
        message:
          "⌘⇧K is in use by another app. Open OpenMuse from the menu bar.",
      });
    const icon = nativeImage
      .createFromDataURL(trayIcon)
      .resize({ width: 18, height: 18 });
    icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip("OpenMuse Desktop");
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: "Open OpenMuse", click: openWorkspace },
        { label: "Show companion", click: syncCompanionWindows },
        {
          label: "Replay setup",
          click: () => {
            void updatePreferences({ onboardingComplete: false }).catch(
              (error: unknown) =>
                dialog.showErrorBox(
                  "Could not replay setup",
                  error instanceof Error ? error.message : "Unknown error",
                ),
            );
          },
        },
        {
          label: "Stop recording",
          click: () => {
            if (store.active) void finishRecording();
          },
        },
        { type: "separator" },
        { label: "Quit OpenMuse Desktop", click: () => app.quit() },
      ]),
    );
    app.on("activate", openWorkspace);
  })
  .catch(async (error) => {
    await dialog.showMessageBox({
      type: "error",
      message: "OpenMuse Desktop could not start",
      detail: error instanceof Error ? error.message : "Unknown startup error",
    });
    app.quit();
  });
app.on("before-quit", () => {
  (app as typeof app & { quitting?: boolean }).quitting = true;
  recorder?.stdin.end();
  recorder?.kill();
  runtime?.close();
  globalShortcut.unregisterAll();
});
