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

export const CONTROL_BUSY_MESSAGE =
  "Another OpenMuse conversation is controlling the Mac right now. Wait for it to finish or stop it, then try again.";

// The same text askApproval (electron/approval.ts) gives a cancelled call.
const CANCELLED_MESSAGE = "The request was cancelled before the user answered.";

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

type Grant = { answer: "allowed"; run: AgentRun } | { answer: "declined" };

type Outcome = "allowed" | "declined" | "busy" | "ended";

// One answer per agent run. The run's first computer-use action asks, and
// the answer holds until the run ends, however it ends (RunRegistry aborts
// run.signal then); the next run asks again. A decline holds for the run
// too, so a model that retries anyway doesn't put the question to the user
// twice. A prompt that closes without an answer (the run ended, or the
// window hosting the sheet hid) records nothing, so the next action asks
// again.
//
// The workspace and the companion chat can each run a conversation at once,
// but only one run controls the Mac at a time: another run's input would
// change the screen behind this one's screenshots, and the two would hide
// and restore OpenMuse's windows out of turn.
export class ControlGrants {
  private grants = new Map<string, Grant>();
  private asking = new Map<string, Promise<Outcome>>();
  // Runs that have sent input, each with the screenshots it has captured
  // since its last input. A run with no entry hasn't sent any yet.
  private fresh = new Map<string, Set<string>>();

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
    if (this.controlledByAnother(run)) throw new Error(CONTROL_BUSY_MESSAGE);
    if (signal.aborted) throw new Error(CANCELLED_MESSAGE);
    // Calls that arrive while the question is open wait for its answer
    // instead of opening a second sheet. The sheet belongs to the run, not
    // to the call that opened it, so each call's cancellation ends only its
    // own wait.
    let asking = this.asking.get(run.id);
    if (!asking) {
      asking = this.ask(run, label).finally(() => this.asking.delete(run.id));
      this.asking.set(run.id, asking);
    }
    const outcome = await untilCancelled(asking, signal);
    if (outcome === "ended") throw new Error(RUN_ENDED_MESSAGE);
    if (outcome === "busy") throw new Error(CONTROL_BUSY_MESSAGE);
    if (outcome === "declined") throw new Error(DECLINED_MESSAGE);
  }

  // Called right before input is sent, and before an app or page opens:
  // from then on, only screenshots this run captures afterwards are fresh.
  // It counts with or without a grant, so a page opened on its own approval
  // makes earlier screenshots stale too. Every other run's screenshots go
  // stale as well, since the screen may have changed under them.
  acting(run: AgentRun) {
    if (run.signal.aborted) return;
    for (const shots of this.fresh.values()) shots.clear();
    if (this.fresh.has(run.id)) return;
    this.fresh.set(run.id, new Set());
    run.signal.addEventListener("abort", () => this.fresh.delete(run.id), {
      once: true,
    });
  }

  captured(run: AgentRun, screenshotId: string) {
    this.fresh.get(run.id)?.add(screenshotId);
  }

  // Once a run has sent any input, its next click or scroll must use a
  // screenshot that run captured after that input. Before then any
  // screenshot will do, such as one the user attached.
  requireFresh(run: AgentRun, screenshotId: string) {
    const shots = this.fresh.get(run.id);
    if (shots && !shots.has(screenshotId))
      throw new Error(staleScreenshotMessage(screenshotId));
  }

  private controlledByAnother(run: AgentRun) {
    for (const grant of this.grants.values())
      if (
        grant.answer === "allowed" &&
        grant.run.id !== run.id &&
        !grant.run.signal.aborted
      )
        return true;
    return false;
  }

  // Asks under the run's signal and records the answer here, so an answer
  // given after every waiting call was cancelled still holds. The run ending
  // closes the sheet, and that reads as the run ending, not a cancel.
  private async ask(run: AgentRun, label?: string): Promise<Outcome> {
    let allowed: boolean;
    try {
      allowed = await this.confirm(controlPrompt(label), run.signal);
    } catch (error) {
      if (run.signal.aborted) return "ended";
      throw error;
    }
    if (run.signal.aborted) return "ended";
    if (!allowed) {
      this.record(run, { answer: "declined" });
      return "declined";
    }
    // Another run may have been allowed while this sheet was open.
    if (this.controlledByAnother(run)) return "busy";
    this.record(run, { answer: "allowed", run });
    return "allowed";
  }

  private record(run: AgentRun, grant: Grant) {
    this.grants.set(run.id, grant);
    run.signal.addEventListener("abort", () => this.grants.delete(run.id), {
      once: true,
    });
  }
}

// Settles as `shared` does, unless `signal` aborts first.
function untilCancelled<T>(shared: Promise<T>, signal: AbortSignal) {
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(new Error(CANCELLED_MESSAGE));
    signal.addEventListener("abort", cancel, { once: true });
    shared
      .finally(() => signal.removeEventListener("abort", cancel))
      .then(resolve, reject);
  });
}
