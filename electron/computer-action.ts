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

const PNG_DATA_URL = "data:image/png;base64,";

// A capture as a tool result carries it: the PNG as bare base64.
export function toActionScreenshot(
  attachment: ScreenshotAttachment,
): ActionScreenshot {
  if (!attachment.dataUrl.startsWith(PNG_DATA_URL))
    throw new Error("Screen capture is not a PNG image");
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
