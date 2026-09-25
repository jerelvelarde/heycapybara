import {
  BLOCKED_CHORD_MESSAGE,
  blockedChord,
  normalizedUrl,
} from "../server/computer-schema";
import type { AgentRun } from "../server/run-registry";
import { describeToolScreenshot } from "../server/screenshots";
import type {
  ActionScreenshot,
  DesktopAction,
  DesktopActionResult,
  ScreenshotAttachment,
} from "../src/types";
import {
  DECLINED_MESSAGE,
  throwIfCancelled,
  type ApprovalPrompt,
} from "./approval";
import type { ControlGrants } from "./control-grant";
import type { PointWindow } from "./point-action";
import { conceal, coversPoint, isMarkedTransparent } from "./window-occlusion";

type Point = { x: number; y: number };
export type ClickAction = Extract<DesktopAction, { type: "click" }>;
export type ScrollAction = Extract<DesktopAction, { type: "scroll" }>;
export type KeysAction = Extract<DesktopAction, { type: "keys" }>;
export type OpenUrlAction = Extract<DesktopAction, { type: "open-url" }>;

// A window as clearAround needs it: point-action's, plus hiding and showing
// without activating OpenMuse.
export type ActionWindow = PointWindow & {
  hide(): void;
  showInactive(): void;
};

export type ComputerDeps = {
  grants: ControlGrants;
  // Returns the registry's own screenshot object, so the same capture is the
  // same object on every call (resolvePoint does).
  resolve(request: { screenshotId: string; x: number; y: number }): {
    shot: { label: string };
    point: Point;
  };
  windows(): ActionWindow[];
  // Whether any OpenMuse approval sheet is open, for any run.
  promptOpen(): boolean;
  // A single-action prompt, for open_url outside a grant.
  confirm(prompt: ApprovalPrompt, signal: AbortSignal): Promise<boolean>;
  // Captures and registers a screenshot of the main display.
  capture(): Promise<ActionScreenshot>;
  wait(ms: number): Promise<void>;
  // The helper's input commands (native/Recorder.swift). Each stops the
  // helper when `signal` aborts.
  click(
    point: Point,
    button: ClickAction["button"],
    clicks: number,
    signal: AbortSignal,
  ): Promise<void>;
  scroll(
    point: Point,
    direction: ScrollAction["direction"],
    amount: number,
    signal: AbortSignal,
  ): Promise<void>;
  type(text: string, signal: AbortSignal): Promise<void>;
  keys(
    key: string,
    modifiers: KeysAction["modifiers"],
    signal: AbortSignal,
  ): Promise<void>;
  openUrl(url: string, bundleId: string, signal: AbortSignal): Promise<void>;
};

// How long a click or scroll waits before the screenshot it returns, so the
// app has a moment to react. A page that takes longer shows up in the
// model's next take_screenshot.
export const SETTLE_MS = 500;

// The model reads these, not the user.
export const PROMPT_OPEN_MESSAGE =
  "An OpenMuse approval prompt is open, and input sent now could answer it. Wait until the user has answered it, then try again.";
export const REPLACED_MESSAGE =
  "That screenshot was replaced while the prompt was open. Call take_screenshot for a new one.";
export const STOPPED_MESSAGE =
  "The task stopped while the action was running, so it may not have finished.";
export const AFTER_INPUT_NOTE =
  "The screen may have changed, so call take_screenshot before your next click or scroll.";
export const WINDOW_RESTORE_NOTE =
  "OpenMuse couldn't bring back one of its own windows after the click; tell the user it may be hidden.";

const PNG_DATA_URL = "data:image/png;base64,";

// A capture as a tool result carries it: the PNG as bare base64.
export function toActionScreenshot(
  attachment: ScreenshotAttachment,
): ActionScreenshot {
  if (!attachment.dataUrl.startsWith(PNG_DATA_URL))
    throw new Error("Screen capture is not a PNG image.");
  return {
    id: attachment.id,
    label: attachment.label,
    width: attachment.width,
    height: attachment.height,
    png: attachment.dataUrl.slice(PNG_DATA_URL.length),
  };
}

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

// Control for this task, and no cancellation while the question was open.
async function allowInput(
  run: AgentRun,
  signal: AbortSignal,
  deps: ComputerDeps,
  label?: string,
) {
  await deps.grants.ensure(run, signal, label);
  throwIfCancelled(signal);
}

// Input sent while a sheet is open could answer it: a click on its button,
// or keys once OpenMuse is in front, and the sheet can belong to another
// run's prompt. The screen counts as changed before anything is sent, so a
// screenshot from before this action can't be used for the next one even if
// the helper fails halfway.
function startInput(run: AgentRun, deps: ComputerDeps) {
  if (deps.promptOpen()) throw new Error(PROMPT_OPEN_MESSAGE);
  deps.grants.acting(run);
}

// Node kills the helper when the signal aborts, and the helper then fails
// with a reason that doesn't say why, so a failure after Stop is reported as
// the stop.
async function send(signal: AbortSignal, input: () => Promise<void>) {
  try {
    await input();
  } catch (error) {
    if (signal.aborted) throw new Error(STOPPED_MESSAGE, { cause: error });
    throw error;
  }
}

export async function takeScreenshot(
  run: AgentRun,
  signal: AbortSignal,
  deps: ComputerDeps,
): Promise<DesktopActionResult> {
  await deps.grants.ensure(run, signal);
  throwIfCancelled(signal);
  const screenshot = await deps.capture();
  deps.grants.captured(run, screenshot.id);
  return { text: describeToolScreenshot(screenshot), screenshot };
}

export async function typeText(
  text: string,
  run: AgentRun,
  signal: AbortSignal,
  deps: ComputerDeps,
): Promise<DesktopActionResult> {
  await allowInput(run, signal, deps);
  startInput(run, deps);
  await send(signal, () => deps.type(text, signal));
  // Counted in code points, as the schema's limit is.
  const typed = plural([...text].length, "character", "characters");
  return {
    text: `OpenMuse typed ${typed} into the focused field. ${AFTER_INPUT_NOTE}`,
  };
}

export async function pressKeys(
  action: KeysAction,
  run: AgentRun,
  signal: AbortSignal,
  deps: ComputerDeps,
): Promise<DesktopActionResult> {
  // Refused before asking: no grant makes these safe to send.
  if (blockedChord(action.key, action.modifiers))
    throw new Error(BLOCKED_CHORD_MESSAGE);
  await allowInput(run, signal, deps);
  startInput(run, deps);
  await send(signal, () => deps.keys(action.key, action.modifiers, signal));
  const chord = [...action.modifiers, action.key].join("+");
  return { text: `OpenMuse pressed ${chord}. ${AFTER_INPUT_NOTE}` };
}

// The page and the app both come from the model, so each goes on its own
// attributed line in the detail, where it can't rewrite the message.
export function openUrlPrompt(url: string, bundleId: string): ApprovalPrompt {
  return {
    message: "The agent wants to open a web page",
    detail: `The agent says the page is: ${url}\nThe agent says the app is: ${bundleId}`,
  };
}

// Under a control grant the user already let the agent act for this task, so
// opening a page doesn't ask again. Outside one it asks about this page
// alone, and allowing it grants nothing more.
export async function openUrl(
  action: OpenUrlAction,
  run: AgentRun,
  signal: AbortSignal,
  deps: ComputerDeps,
): Promise<DesktopActionResult> {
  const url = normalizedUrl(action.url);
  if (
    !deps.grants.has(run) &&
    !(await deps.confirm(openUrlPrompt(url, action.bundleId), signal))
  )
    throw new Error(DECLINED_MESSAGE);
  throwIfCancelled(signal);
  deps.grants.acting(run);
  await send(signal, () => deps.openUrl(url, action.bundleId, signal));
  return {
    text: `OpenMuse opened ${url} in ${action.bundleId}. ${AFTER_INPUT_NOTE}`,
  };
}

// Windows that clearAround hid but couldn't show again last time (their
// showInactive() threw). Kept module-level, like window-occlusion.ts's
// fades record, so the failure is retried instead of forgotten: a window
// stuck hidden reports isVisible() === false, so without this it would
// never again match the isVisible()-and-coversPoint check below and would
// stay hidden for good.
const stuckHidden = new WeakSet<ActionWindow>();

// Keeps OpenMuse's own windows from taking input meant for the app under
// them. conceal() makes an opaque window invisible and click-through. A
// window marked transparent only turns invisible (markTransparent in
// window-occlusion.ts explains why), so its opaque pixels would still catch
// the click; those are hidden instead, and shown again afterwards without
// activating OpenMuse. Hiding a window ends a sheet on it, but by now no
// sheet is open: input waits until none is (PROMPT_OPEN_MESSAGE).
export function clearAround(point: Point, windows: ActionWindow[]) {
  const covering = windows.filter(
    (win) =>
      !win.isDestroyed() &&
      (stuckHidden.has(win) ||
        (win.isVisible() && coversPoint(win.getBounds(), point))),
  );
  const restoreFaded = conceal(
    covering.filter((win) => !isMarkedTransparent(win)),
  );
  const hidden: ActionWindow[] = [];
  const showHidden = () => {
    let failed = false;
    let firstError: unknown;
    for (const win of hidden) {
      // Quitting can destroy a window while input is under way; it can't
      // come back, and it can't be retried either, so it's not worth
      // tracking any further.
      if (win.isDestroyed()) {
        stuckHidden.delete(win);
        continue;
      }
      try {
        win.showInactive();
        stuckHidden.delete(win);
      } catch (error) {
        stuckHidden.add(win);
        if (!failed) {
          failed = true;
          firstError = error;
        }
      }
    }
    return { failed, firstError };
  };
  try {
    for (const win of covering)
      if (isMarkedTransparent(win)) {
        win.hide();
        hidden.push(win);
      }
  } catch (error) {
    // The hide failure is what the caller needs to see, so a failure while
    // undoing doesn't replace it.
    showHidden();
    try {
      restoreFaded();
    } catch {
      // ignored: the hide error above takes precedence
    }
    throw error;
  }
  return () => {
    const shown = showHidden();
    let failed = shown.failed;
    let firstError = shown.firstError;
    try {
      restoreFaded();
    } catch (error) {
      if (!failed) {
        failed = true;
        firstError = error;
      }
    }
    if (failed) throw firstError;
  };
}

// Resolves before asking, so the user is never asked to hand over control
// for a point that already can't land, and again once control is granted:
// while the prompt was open the display could change, or the screenshot
// could expire or be evicted by newer captures (performPointAction does the
// same).
async function preparePointer(
  action: ClickAction | ScrollAction,
  run: AgentRun,
  signal: AbortSignal,
  deps: ComputerDeps,
) {
  const asked = deps.resolve(action);
  await allowInput(run, signal, deps, action.label);
  const { shot, point } = deps.resolve(action);
  if (shot !== asked.shot) throw new Error(REPLACED_MESSAGE);
  deps.grants.requireFresh(run, action.screenshotId);
  startInput(run, deps);
  return point;
}

// Clears OpenMuse's windows from the spot, sends the input and brings them
// back. Once the input has gone, failing to bring a window back doesn't fail
// the action: the model would send it again. undoFade keeps a failed fade's
// record, and clearAround's own stuckHidden set does the same for a hidden
// window, so a later clearAround retries either kind of failure. The caller
// still needs to know a window didn't come back, so it can tell the model;
// the error itself isn't reported that way, since it can carry a window's
// title or other detail no result text should leak, so only console.error
// sees it.
async function sendAt(
  point: Point,
  signal: AbortSignal,
  deps: ComputerDeps,
  input: () => Promise<void>,
): Promise<{ restoreFailed: boolean }> {
  const restore = clearAround(point, deps.windows());
  try {
    await send(signal, input);
  } catch (error) {
    try {
      restore();
    } catch {
      // ignored: the input's own failure takes precedence
    }
    throw error;
  }
  try {
    restore();
  } catch (error) {
    console.error(
      "clearAround: a window failed to reappear after input",
      error,
    );
    return { restoreFailed: true };
  }
  return { restoreFailed: false };
}

async function thenScreenshot(
  summary: string,
  noun: "click" | "scroll",
  run: AgentRun,
  signal: AbortSignal,
  deps: ComputerDeps,
): Promise<DesktopActionResult> {
  // After Stop nothing reads the result, so no screenshot is taken.
  if (signal.aborted) return { text: summary };
  await deps.wait(SETTLE_MS);
  if (signal.aborted) return { text: summary };
  try {
    const screenshot = await deps.capture();
    deps.grants.captured(run, screenshot.id);
    return {
      text: `${summary} ${describeToolScreenshot(screenshot)} It was taken after the ${noun}: check it to see what happened, and use it for your next click or scroll.`,
      screenshot,
    };
  } catch (error) {
    // The input was sent, so this mustn't fail the action, or the model
    // would send it again.
    const reason =
      error instanceof Error ? error.message : "Unknown capture error.";
    return {
      text: `${summary} OpenMuse couldn't take a screenshot afterwards: ${reason} Call take_screenshot before your next click or scroll.`,
    };
  }
}

const CLICK_KIND = ["", "", "double ", "triple "];

export async function clickOnScreen(
  action: ClickAction,
  run: AgentRun,
  signal: AbortSignal,
  deps: ComputerDeps,
): Promise<DesktopActionResult> {
  const point = await preparePointer(action, run, signal, deps);
  const { restoreFailed } = await sendAt(point, signal, deps, () =>
    deps.click(point, action.button, action.clicks, signal),
  );
  const kind = CLICK_KIND[action.clicks] ?? "";
  const restoreNote = restoreFailed ? ` ${WINDOW_RESTORE_NOTE}` : "";
  return thenScreenshot(
    `OpenMuse sent a ${kind}${action.button} click to "${action.label}" at (${action.x}, ${action.y}) in ${action.screenshotId}.${restoreNote}`,
    "click",
    run,
    signal,
    deps,
  );
}

export async function scrollOnScreen(
  action: ScrollAction,
  run: AgentRun,
  signal: AbortSignal,
  deps: ComputerDeps,
): Promise<DesktopActionResult> {
  const point = await preparePointer(action, run, signal, deps);
  const { restoreFailed } = await sendAt(point, signal, deps, () =>
    deps.scroll(point, action.direction, action.amount, signal),
  );
  const notches = plural(action.amount, "notch", "notches");
  const restoreNote = restoreFailed ? ` ${WINDOW_RESTORE_NOTE}` : "";
  return thenScreenshot(
    `OpenMuse scrolled ${action.direction} ${notches} over "${action.label}" at (${action.x}, ${action.y}) in ${action.screenshotId}.${restoreNote}`,
    "scroll",
    run,
    signal,
    deps,
  );
}
