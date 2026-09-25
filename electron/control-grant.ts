import type { AgentRun } from "../server/run-registry";
import { DECLINED_MESSAGE, type ApprovalPrompt } from "./approval";

// macOS doesn't show an alert's title, so the message itself says who is
// asking. The message and the first line of the detail are OpenMuse's own
// text; the model's label for its first step, when it has one, goes on its
// own attributed line, where it can't rewrite them (as in pointPrompt).
export const CONTROL_MESSAGE =
  "The agent wants to control your Mac for this task";
export const CONTROL_DETAIL =
  "Until the task ends or you press Stop, it can see your screen, click, type, press keys, scroll, and open apps and web pages without asking again.";
export const CONTROL_ALLOW = "Allow for this task";

export const RUN_ENDED_MESSAGE =
  "This task has ended, so the agent no longer has control of the Mac.";

export function staleScreenshotMessage(id: string) {
  return `Screenshot ${id} was taken before the agent's last action, so the screen may have changed. Use the screenshot your last click or scroll returned, or call take_screenshot.`;
}

export function controlPrompt(label?: string): ApprovalPrompt {
  return {
    message: CONTROL_MESSAGE,
    detail: label
      ? `${CONTROL_DETAIL}\nThe agent says its first step is: ${label}`
      : CONTROL_DETAIL,
    allow: CONTROL_ALLOW,
  };
}

type Grant =
  // `acted`: the run has sent input since it was granted control. `fresh`:
  // screenshots it has captured since its last input.
  | { answer: "allowed"; acted: boolean; fresh: Set<string> }
  | { answer: "declined" };

// One answer per agent run. The run's first computer-use action asks, and
// the answer holds until the run ends, however it ends (RunRegistry aborts
// run.signal then); the next run asks again. A decline holds for the run
// too, so a model that retries anyway doesn't put the question to the user
// twice. A prompt that closes without an answer (the call was cancelled, or
// the window hosting the sheet hid) records nothing, so the next action asks
// again.
export class ControlGrants {
  private grants = new Map<string, Grant>();
  private asking = new Map<string, Promise<boolean>>();

  constructor(
    private readonly confirm: (
      prompt: ApprovalPrompt,
      signal: AbortSignal,
    ) => Promise<boolean>,
  ) {}

  has(run: AgentRun) {
    return !run.signal.aborted && this.grants.get(run.id)?.answer === "allowed";
  }

  async ensure(run: AgentRun, signal: AbortSignal, label?: string) {
    if (run.signal.aborted) throw new Error(RUN_ENDED_MESSAGE);
    const known = this.grants.get(run.id);
    if (known?.answer === "allowed") return;
    if (known?.answer === "declined") throw new Error(DECLINED_MESSAGE);
    // Calls that arrive while the question is open wait for its answer
    // instead of opening a second sheet.
    let asking = this.asking.get(run.id);
    if (!asking) {
      asking = this.confirm(controlPrompt(label), signal).finally(() =>
        this.asking.delete(run.id),
      );
      this.asking.set(run.id, asking);
    }
    const allowed = await asking;
    if (run.signal.aborted) throw new Error(RUN_ENDED_MESSAGE);
    this.record(
      run,
      allowed
        ? { answer: "allowed", acted: false, fresh: new Set() }
        : { answer: "declined" },
    );
    if (!allowed) throw new Error(DECLINED_MESSAGE);
  }

  // Called right before input is sent, and before an app or page opens:
  // from then on, only screenshots captured afterwards are fresh.
  acting(run: AgentRun) {
    const grant = this.grants.get(run.id);
    if (grant?.answer !== "allowed") return;
    grant.acted = true;
    grant.fresh.clear();
  }

  captured(run: AgentRun, screenshotId: string) {
    const grant = this.grants.get(run.id);
    if (grant?.answer === "allowed") grant.fresh.add(screenshotId);
  }

  requireFresh(run: AgentRun, screenshotId: string) {
    const grant = this.grants.get(run.id);
    if (
      grant?.answer === "allowed" &&
      grant.acted &&
      !grant.fresh.has(screenshotId)
    )
      throw new Error(staleScreenshotMessage(screenshotId));
  }

  private record(run: AgentRun, grant: Grant) {
    // Calls that shared one prompt all record its answer; the first wins.
    if (this.grants.has(run.id)) return;
    this.grants.set(run.id, grant);
    run.signal.addEventListener("abort", () => this.grants.delete(run.id), {
      once: true,
    });
  }
}
