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
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { Store } from "./store";
import {
  startupPreferences,
  savePreferences,
  companionSchema,
} from "./preferences";
import { recordingBlockedReason, replayBlockedReason } from "./setup-guards";
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
import { runHelper, helperStatus, withInput } from "./helper-result";
import { performPointAction } from "./point-action";
import {
  askApproval,
  approvalHost,
  DECLINED_MESSAGE,
  throwIfCancelled,
  type ApprovalPrompt,
} from "./approval";
import { conceal, markTransparent } from "./window-occlusion";
import type { Point } from "../src/buddy-drag";
import { ControlGrants } from "./control-grant";
import {
  clickOnScreen,
  openUrl,
  pressKeys,
  scrollOnScreen,
  STOPPED_MESSAGE,
  takeScreenshot,
  toActionScreenshot,
  typeText,
  type ComputerDeps,
} from "./computer-action";
import { desktopActionSchema } from "../server/computer-schema";
import type { AgentRun } from "../server/run-registry";
import { startRuntime } from "../server/runtime";
import { ScreenshotRegistry, resolvePoint } from "../server/screenshots";
import type {
  CompanionTrayMode,
  DesktopActionResult,
  Permissions,
  ScreenshotAttachment,
  Settings,
} from "../src/types";
import { captureScreenshot, singleFlight } from "./screen-capture";

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
const helperTimeout = { timeout: 15_000 };
// A first launch of an app can walk through Gatekeeper's notarization
// check, which can take longer than every other helper call.
const appLaunchTimeout = { timeout: 60_000 };
// Typing sends one key event pair per character, a few milliseconds apart
// (native/Recorder.swift --type), so it gets longer than other commands.
const typingTimeout = { timeout: 30_000 };
const screenshots = new ScreenshotRegistry();
let workspace: BrowserWindow;
let buddy: BrowserWindow;
let companionChat: BrowserWindow;
let onboarding: BrowserWindow | undefined;
// Set once preferences load; the setup window's close handler uses it to skip setup.
let skipOnboarding: (() => Promise<void>) | undefined;
let trayMode: CompanionTrayMode = "chat";
let tray: Tray;
let buddyPosition: Point | undefined;
let buddyGesture: BuddyGesture | undefined;
let buddySaveQueue = Promise.resolve();
const buddyPositionPath = () =>
  join(app.getPath("userData"), "buddy-position.json");
const buddyAreas = () =>
  screen.getAllDisplays().map((display) => display.workArea);
// A copy that macOS reopened (for example after a Screen Recording change) can start while the
// quitting copy still holds ⌘⇧K, so a failed registration is retried before it counts.
async function registerWorkspaceShortcut() {
  const toggle = () => {
    if (workspace.isDestroyed()) return;
    if (workspace.isVisible() && workspace.isFocused()) workspace.hide();
    else openWorkspace();
  };
  for (const wait of [0, 1000, 3000]) {
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    // before-quit has already unregistered every shortcut; do not take it back.
    if ((app as typeof app & { quitting?: boolean }).quitting) return false;
    if (globalShortcut.register("CommandOrControl+Shift+K", toggle))
      return true;
  }
  return false;
}
function syncCompanionWindows() {
  // A preference save can land after quitting has destroyed the windows.
  if (
    !buddy ||
    buddy.isDestroyed() ||
    !settings ||
    (app as typeof app & { quitting?: boolean }).quitting
  )
    return;
  if (!settings.onboardingComplete) {
    buddy.hide();
    if (companionChat && !companionChat.isDestroyed()) companionChat.hide();
    if (!onboarding || onboarding.isDestroyed())
      onboarding = makeOnboardingWindow();
    else {
      onboarding.show();
      onboarding.focus();
    }
    return;
  }
  if (onboarding && !onboarding.isDestroyed()) onboarding.destroy();
  onboarding = undefined;
  buddy.showInactive();
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
  if (!settings.onboardingComplete || setupReopenings > 0)
    throw new Error("Finish setup to use the companion.");
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
// Setup replays that passed their guard and are still saving; a counter so overlapping replays cannot clear each other.
let setupReopenings = 0;
const broadcast = () =>
  BrowserWindow.getAllWindows().forEach((w) =>
    w.webContents.send("kite:update"),
  );
// Every window listed here gets concealed for screenshots and the pointer;
// a window left out of this list still shows up in captures and is never
// cleared before the pointer ring appears over it.
function openMuseWindows() {
  return [workspace, buddy, onboarding, companionChat].filter(
    (win): win is BrowserWindow => !!win && !win.isDestroyed(),
  );
}
// How many approval sheets each window is hosting right now. Hiding a window
// ends the sheet on it as a Cancel (NativeWindowMac::Hide), so openWorkspace
// leaves a companion chat that is hosting one on screen.
const approvalHosts = new Map<BrowserWindow, number>();
// How many OpenMuse dialogs of any kind are open: approval sheets, but also
// the working-folder and export choosers and error alerts. Agent input sent
// while one is up could answer it - "Open" on the folder chooser would widen
// what Codex may edit - so promptOpen() counts these too. Every dialog call
// goes through here (tests/main-sheets.test.ts).
let sheetsOpen = 0;
async function showDialog<T>(show: () => T | Promise<T>): Promise<T> {
  sheetsOpen++;
  try {
    return await show();
  } finally {
    sheetsOpen--;
  }
}
async function approve(prompt: ApprovalPrompt, signal?: AbortSignal) {
  const { host, mustShow } = approvalHost({ companionChat, workspace });
  // -1, as bounce() itself returns when OpenMuse is already active, means
  // there is no bounce to cancel.
  let bounce = -1;
  approvalHosts.set(host, (approvalHosts.get(host) ?? 0) + 1);
  try {
    return await askApproval(
      prompt,
      {
        activate: () => {
          app.focus({ steal: true });
          // The companion chat floats above every app on every Space, so a
          // sheet on it is in view without activation; only the workspace
          // can sit behind another app.
          if (host === workspace) bounce = app.dock?.bounce("critical") ?? -1;
        },
        showMessageBox: (options) => {
          if (mustShow) {
            // mustShow only ever comes from approvalHost() choosing the
            // workspace (see its return above), so this is always about the
            // workspace, never the companion chat.
            //
            // app.show() undoes Cmd+H: that hides every OpenMuse window,
            // including one hosting no sheet at all, and makes each of them
            // report as not visible, so approvalHost() picks the workspace
            // and asks for it to be shown even though nothing the user did
            // targeted it specifically. openWorkspace() must not run here:
            // it hides a companion chat that isn't hosting this prompt,
            // which would close whatever chat the user had open just to
            // unhide the app for an unrelated approval.
            app.show?.();
            // focus() does nothing on a window that isn't visible, which a
            // minimized one isn't, and show() alone doesn't undo minimized.
            if (workspace.isMinimized()) workspace.restore();
            workspace.show();
            workspace.focus();
          }
          // Always the parented form. The async message box attaches a sheet
          // to its parent even while that window is hidden; the parentless
          // form runs a blocking modal loop on macOS.
          return showDialog(() => dialog.showMessageBox(host, { ...options }));
        },
        // Hiding a window ends its sheet and orders it out in the same call,
        // and the box resolves on a later task, so a host that is off screen
        // by then was dismissed, not answered. Electron's "hide" event can't
        // tell us this: on macOS it comes from occlusion changes
        // (windowDidChangeOcclusionState), so it also fires when another
        // app's window fully covers the host, and it can arrive after the
        // box has resolved.
        hostHidden: () => host.isDestroyed() || !host.isVisible(),
      },
      signal,
    );
  } finally {
    // A critical bounce lasts until OpenMuse is activated, so a prompt that
    // ends while it's in the background - Stop does this; whether a bare
    // tool-call timeout does too is unverified - would leave the icon
    // bouncing for nothing.
    if (bounce !== -1) app.dock?.cancelBounce(bounce);
    const remaining = (approvalHosts.get(host) ?? 1) - 1;
    if (remaining > 0) approvalHosts.set(host, remaining);
    else approvalHosts.delete(host);
  }
}
// One control grant per agent run (electron/control-grant.ts), asked like
// every other prompt: as a sheet on an OpenMuse window, through approve().
const grants = new ControlGrants(approve);

// Takes one screenshot of the main display. The composer's attach button
// shares captures through singleFlight (in whenReady below); the agent's
// take_screenshot, and the screenshot after a click or scroll, call this
// directly, so they never reuse a capture that started before the agent's
// last action.
function captureNow(): Promise<ScreenshotAttachment> {
  return captureScreenshot({
    screenCaptureAllowed: async () => (await permissions()).screenCapture,
    primaryDisplay: () => screen.getPrimaryDisplay(),
    displays: () => screen.getAllDisplays(),
    conceal: () => conceal(openMuseWindows().filter((win) => win.isVisible())),
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    sources: (target) =>
      desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: target,
      }),
    // A 2x NativeImage keeps its scale factor through resize(), so its PNG
    // would stay 2x; rebuilding it from its own pixels makes the target a
    // pixel size.
    rebuild: (png, size) =>
      nativeImage.createFromBuffer(png).resize(size).toPNG(),
    register: (input) => screenshots.add(input),
    sourcesTimeoutMs: 10_000,
  });
}

// What the computer-use actions (electron/computer-action.ts) run on.
// openMuseWindows() includes the setup window while it exists, so a click
// or scroll under it clears it too instead of landing on OpenMuse.
const computer: ComputerDeps = {
  grants,
  resolve: (request) =>
    resolvePoint(screenshots, screen.getAllDisplays(), request),
  windows: openMuseWindows,
  promptOpen: () => approvalHosts.size > 0 || sheetsOpen > 0,
  confirm: approve,
  capture: async () => toActionScreenshot(await captureNow()),
  wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  click: async (point, button, clicks, signal) => {
    await runHelper(
      () =>
        exec(
          helper,
          ["--click", String(point.x), String(point.y), button, String(clicks)],
          { ...helperTimeout, signal },
        ),
      helperStatus.clickSent,
    );
  },
  scroll: async (point, direction, amount, signal) => {
    await runHelper(
      () =>
        exec(
          helper,
          [
            "--scroll",
            String(point.x),
            String(point.y),
            direction,
            String(amount),
          ],
          { ...helperTimeout, signal },
        ),
      helperStatus.scrollSent,
    );
  },
  // The text goes on stdin: any process on the Mac can read another's
  // arguments.
  type: async (text, signal) => {
    await runHelper(
      () =>
        withInput(exec(helper, ["--type"], { ...typingTimeout, signal }), text),
      helperStatus.textTyped,
    );
  },
  keys: async (key, modifiers, signal) => {
    await runHelper(
      () =>
        exec(helper, ["--keys", key, ...modifiers], {
          ...helperTimeout,
          signal,
        }),
      helperStatus.keysPressed,
    );
  },
  openUrl: async (url, bundleId, signal) => {
    await runHelper(
      () =>
        exec(helper, ["--open-url", bundleId, url], {
          ...appLaunchTimeout,
          signal,
        }),
      helperStatus.webPageOpened,
    );
  },
};

// The runtime is the only caller: the kite:action IPC route that used to
// hand this a renderer's unvalidated input is gone (approvedAction is no
// longer registered as an IPC handler at all), so this takes the runtime's
// own AbortSignal for the call, and the run the call belongs to
// (server/tools.ts), directly instead of validating them out of unknown
// input.
async function approvedAction(
  input: unknown,
  signal: AbortSignal,
  run: AgentRun,
): Promise<DesktopActionResult | void> {
  const action = desktopActionSchema.parse(input);
  // Computer-use actions stop when their call is cancelled or when their run
  // ends, whichever comes first, so Stop cancels one that is under way.
  const cancel = AbortSignal.any([signal, run.signal]);
  switch (action.type) {
    case "screenshot":
      return takeScreenshot(run, cancel, computer);
    case "click":
      return clickOnScreen(action, run, cancel, computer);
    case "scroll":
      return scrollOnScreen(action, run, cancel, computer);
    case "type":
      return typeText(action.text, run, cancel, computer);
    case "keys":
      return pressKeys(action, run, cancel, computer);
    case "open-url":
      return openUrl(action, run, cancel, computer);
  }
  if (action.type === "open-app") {
    // Under a control grant the user already let the agent act for this task
    // (electron/control-grant.ts), so opening an app doesn't ask again. The
    // bundle id comes from the model, so like a pointer label it goes on its
    // own attributed line in the detail, where it can't rewrite the message.
    if (
      !grants.has(run) &&
      !(await approve(
        {
          message: "The agent wants to open an app",
          detail: `The agent says the app is: ${action.bundleId}`,
        },
        cancel,
      ))
    )
      throw new Error(DECLINED_MESSAGE);
    throwIfCancelled(cancel);
    grants.acting(run);
    try {
      await runHelper(
        () =>
          exec(helper, ["--open-app", action.bundleId], {
            ...appLaunchTimeout,
            signal: cancel,
          }),
        helperStatus.appOpened,
      );
    } catch (error) {
      // Stop kills the launch, which the helper can't report, so say so the
      // way the other actions do (send() in electron/computer-action.ts).
      if (cancel.aborted) throw new Error(STOPPED_MESSAGE, { cause: error });
      throw error;
    }
    return;
  }
  await performPointAction(
    action.label,
    {
      resolve: () => resolvePoint(screenshots, screen.getAllDisplays(), action),
      // Pointing doesn't ask under a control grant either.
      confirm: (prompt, promptSignal) =>
        grants.has(run) ? Promise.resolve(true) : approve(prompt, promptSignal),
      windows: openMuseWindows,
      showPointer: async (point) => {
        await runHelper(
          () =>
            exec(
              helper,
              ["--point", String(point.x), String(point.y)],
              helperTimeout,
            ),
          helperStatus.pointDisplayed,
        );
      },
    },
    cancel,
  );
}

const permissionKindSchema = z.enum(["accessibility", "screenCapture"]);
const permissionPanes = {
  accessibility:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screenCapture:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
} as const;
async function permissions(): Promise<Permissions> {
  const stdout = await runHelper(() =>
    exec(helper, ["--permissions"], helperTimeout),
  );
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
  const blocked = recordingBlockedReason({
    complete: settings.onboardingComplete,
    reopening: setupReopenings > 0,
  });
  if (blocked) throw new Error(blocked);
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
            await showDialog(() =>
              dialog.showMessageBox({
                type: "error",
                message:
                  "Recording stopped because an event could not be saved.",
              }),
            );
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
            await showDialog(() =>
              dialog.showMessageBox({
                type: "error",
                message:
                  "Could not finalize the recording. Retry Stop or restart OpenMuse Desktop.",
              }),
            );
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
  // Hiding the chat would end an approval sheet on it as a Cancel the user
  // never gave, so while it hosts one it stays on screen beside the
  // workspace.
  if (
    companionChat &&
    !companionChat.isDestroyed() &&
    !approvalHosts.has(companionChat)
  )
    companionChat.hide();
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
  // The buddy is transparent; the workspace is opaque and keeps ordinary
  // click handling, so it stays unmarked.
  const transparent = isBuddy;
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
    transparent,
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
  // Marked where it's made, so conceal() never costs a transparent window
  // its click-through (see markTransparent).
  if (transparent) markTransparent(win);
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
    // The workspace never shows at launch. This first sync is what opens setup on a new install, so setup at launch waits for the buddy window to be ready to show.
    if (isBuddy) syncCompanionWindows();
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
  // transparent: true above, so marked where it's made (see markTransparent).
  markTransparent(win);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  const loaded = process.env.KITE_DEV_URL
    ? win.loadURL(process.env.KITE_DEV_URL + "?companionChat=1")
    : win.loadFile(join(root, "dist/renderer/index.html"), {
        query: { companionChat: "1" },
      });
  void loaded.catch((error: unknown) => {
    // Quitting aborts a load that is still running; a dialog then would hold up the quit.
    if ((app as typeof app & { quitting?: boolean }).quitting) return;
    void showDialog(() =>
      dialog.showErrorBox(
        "OpenMuse chat could not load",
        error instanceof Error ? error.message : "Unknown loading error",
      ),
    );
  });
  win.on("close", (event) => {
    if (!(app as typeof app & { quitting?: boolean }).quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  return win;
}
function makeOnboardingWindow() {
  const width = 520;
  const height = 600;
  const { workArea } = screen.getPrimaryDisplay();
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Welcome to OpenMuse",
    titleBarStyle: "hiddenInset",
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: join(dirname(fileURLToPath(import.meta.url)), "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.on("closed", () => {
    if (onboarding === win) onboarding = undefined;
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  // Keep "Welcome to OpenMuse" instead of index.html's <title>.
  win.on("page-title-updated", (event) => event.preventDefault());
  const loaded = process.env.KITE_DEV_URL
    ? win.loadURL(process.env.KITE_DEV_URL + "?onboarding=1")
    : win.loadFile(join(root, "dist/renderer/index.html"), {
        query: { onboarding: "1" },
      });
  void loaded.catch((error: unknown) => {
    // Completing or skipping setup can destroy the window while it loads, and quitting aborts the
    // load; neither is a failure, and a dialog during a quit would hold the quit up.
    if (
      win.isDestroyed() ||
      (app as typeof app & { quitting?: boolean }).quitting
    )
      return;
    console.error("OpenMuse setup could not load", error);
    // The closed handler clears `onboarding`, so the next sync builds a fresh window.
    win.destroy();
    void showDialog(() =>
      dialog.showMessageBox({
        type: "error",
        message: "OpenMuse setup could not load",
        detail:
          "Choose Replay setup from the OpenMuse menu bar icon to try again.",
      }),
    );
  });
  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });
  win.on("close", (event) => {
    // Quitting is not a skip: onboardingComplete stays false on disk, so a relaunch reopens setup.
    // The !skipOnboarding check is defensive: every window is created after skipOnboarding is set.
    if (
      (app as typeof app & { quitting?: boolean }).quitting ||
      !skipOnboarding
    )
      return;
    // Closing skips setup. The window stays until the save succeeds; syncCompanionWindows() then destroys it (destroy() emits no close event).
    event.preventDefault();
    void skipOnboarding().catch((error: unknown) => {
      console.error("Could not skip setup", error);
      if (win.isDestroyed()) return;
      void showDialog(() =>
        dialog.showMessageBox(win, {
          type: "error",
          message: "Could not skip setup",
          detail:
            "OpenMuse could not save your settings. Check free disk space and folder permissions, then close this window again.",
        }),
      );
    });
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
        onboarding?.webContents,
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
    const userData = app.getPath("userData");
    const preferencesPath = join(userData, "preferences.json");
    const libraryPath = join(userData, "library");
    // First, because Store.load() creates the library and an existing library means a returning install.
    const savedPreferences = await startupPreferences(
      preferencesPath,
      libraryPath,
    );
    store = new Store(libraryPath);
    await store.load();
    await loadLinkedEnvironment(userData);
    runtime = await startRuntime(store, {
      statePath: join(userData, "agent"),
      binaryPath: app.isPackaged
        ? join(process.resourcesPath, "codex-runtime/bin/codex")
        : undefined,
      action: approvedAction,
      screenshots,
    });
    settings = runtime.settings;
    settings.companion = savedPreferences.companion;
    settings.onboardingComplete = savedPreferences.onboardingComplete;
    let preferenceQueue = Promise.resolve();
    function updatePreferences(change: Partial<typeof savedPreferences>) {
      const update = preferenceQueue.then(async () => {
        const next = await savePreferences(preferencesPath, {
          companion: settings.companion,
          onboardingComplete: settings.onboardingComplete,
          ...change,
        });
        settings.companion = next.companion;
        settings.onboardingComplete = next.onboardingComplete;
        // Any save whose change names onboardingComplete resyncs windows, even if the value is unchanged; a companion-only save does not, since a resync would re-show a companion the user hid.
        if ("onboardingComplete" in change) syncCompanionWindows();
        broadcast();
      });
      // Return the failed write to this caller while keeping later saves retryable.
      preferenceQueue = update.catch(() => {});
      return update;
    }
    skipOnboarding = () => updatePreferences({ onboardingComplete: true });
    async function replaySetup() {
      const blocked = replayBlockedReason({
        active: !!store.active,
        changing: transitioning || !!recorder,
      });
      if (blocked) throw new Error(blocked);
      setupReopenings++;
      try {
        await updatePreferences({ onboardingComplete: false });
      } finally {
        setupReopenings--;
      }
    }
    handle("setCompanion", (input) =>
      updatePreferences({ companion: companionSchema.parse(input) }),
    );
    handle("completeOnboarding", async (input) => {
      const options = z
        .strictObject({ openWorkspace: z.boolean().optional() })
        .optional()
        .parse(input);
      await updatePreferences({ onboardingComplete: true });
      // Open the workspace only after setup is saved, so a failed save stays visible in the setup window.
      if (options?.openWorkspace) openWorkspace();
    });
    handle("replayOnboarding", replaySetup);
    handle("openPermissionSettings", (kind) =>
      shell.openExternal(permissionPanes[permissionKindSchema.parse(kind)]),
    );
    session.defaultSession.setPermissionRequestHandler(
      (_wc, _permission, callback) => callback(false),
    );
    handle("chooseWorkspace", async () => {
      const result = await showDialog(() =>
        dialog.showOpenDialog(workspace, {
          title: "Choose OpenMuse's working folder",
          message: "Codex can edit files and run commands in this folder.",
          properties: ["openDirectory", "createDirectory"],
          defaultPath: settings.workspace,
        }),
      );
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
      const result = await showDialog(() =>
        dialog.showSaveDialog(workspace, {
          title: "Export workflow skill",
          defaultPath: "SKILL.md",
          filters: [{ name: "Markdown", extensions: ["md"] }],
        }),
      );
      if (result.canceled || !result.filePath) return false;
      await writeFile(result.filePath, skill.markdown, { mode: 0o600 });
      return true;
    });
    handle("permissions", async (kind) => {
      const parsed = permissionKindSchema.parse(kind);
      await runHelper(() =>
        exec(
          helper,
          [
            parsed === "accessibility"
              ? "--request-accessibility"
              : "--request-screen",
          ],
          helperTimeout,
        ),
      );
      return permissions();
    });
    // Nested fades (conceal() in window-occlusion.ts) already keep every
    // window concealed for as long as any overlapping capture or pointer
    // needs it, so overlapping captures can't see each other's windows.
    // This guard exists so a burst of quick clicks shares one real capture
    // and adds one registry entry, instead of hitting desktopCapturer and
    // screenshots.add() once per click. The agent's captures bypass this;
    // see captureNow.
    const captureScreenshotOnce = singleFlight(captureNow);
    handle("screenshot", captureScreenshotOnce);
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
    workspace = makeWindow(false);
    buddy = makeWindow(true);
    companionChat = makeCompanionChatWindow();
    const restoreVisibleBuddy = () => {
      // Display changes also arrive while quitting, after the companion is destroyed; touching it
      // then throws, and Electron's uncaught-exception dialog holds the quit up.
      if (buddy.isDestroyed()) return;
      buddyGesture = undefined;
      const [x, y] = buddy.getPosition();
      const position = clampBuddyPosition({ x, y }, buddyAreas());
      buddy.setPosition(position.x, position.y);
      positionCompanionChat();
      void persistBuddyPosition().catch((error: unknown) =>
        showDialog(() =>
          dialog.showMessageBox({
            type: "error",
            message: "Could not save companion position",
            detail:
              error instanceof Error ? error.message : "Unknown save error",
          }),
        ),
      );
    };
    screen.on("display-removed", restoreVisibleBuddy);
    screen.on("display-added", restoreVisibleBuddy);
    screen.on("display-metrics-changed", restoreVisibleBuddy);
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
            void replaySetup().catch((error: unknown) => {
              // A sheet on the workspace, not a parentless alert: on macOS that would freeze the
              // main process, and the usual refusal comes while a recording is still sending events.
              openWorkspace();
              void showDialog(() =>
                dialog.showMessageBox(workspace, {
                  type: "error",
                  message: "Could not replay setup",
                  detail:
                    error instanceof Error ? error.message : "Unknown error",
                }),
              );
            });
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
    app.on("activate", () => {
      if (settings.onboardingComplete) openWorkspace();
      else syncCompanionWindows();
    });
    // Registered last, once the menu bar item exists. A taken shortcut is only logged: on macOS a
    // parentless alert freezes the main process until it is dismissed, and a sheet on the workspace,
    // which is hidden at launch, would never be seen.
    void registerWorkspaceShortcut().then((registered) => {
      if (!registered && !(app as typeof app & { quitting?: boolean }).quitting)
        console.warn(
          "⌘⇧K is in use by another app; open OpenMuse from the menu bar.",
        );
    });
  })
  .catch(async (error) => {
    await showDialog(() =>
      dialog.showMessageBox({
        type: "error",
        message: "OpenMuse Desktop could not start",
        detail:
          error instanceof Error ? error.message : "Unknown startup error",
      }),
    );
    app.quit();
  });
app.on("before-quit", () => {
  (app as typeof app & { quitting?: boolean }).quitting = true;
  recorder?.stdin.end();
  recorder?.kill();
  runtime?.close();
  globalShortcut.unregisterAll();
});
