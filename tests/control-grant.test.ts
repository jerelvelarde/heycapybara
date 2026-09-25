import { test } from "node:test";
import assert from "node:assert/strict";
import { DECLINED_MESSAGE, type ApprovalPrompt } from "../electron/approval";
import {
  CONTROL_ALLOW,
  CONTROL_DETAIL,
  CONTROL_MESSAGE,
  ControlGrants,
  RUN_ENDED_MESSAGE,
  controlPrompt,
  staleScreenshotMessage,
} from "../electron/control-grant";
import type { AgentRun } from "../server/run-registry";

function fakeRun(id = "run-1") {
  const ended = new AbortController();
  const run: AgentRun = Object.freeze({ id, signal: ended.signal });
  return { run, end: () => ended.abort() };
}

// A user who gives these answers in order, and fails the test if asked
// more often than that.
function user(answers: boolean[]) {
  const prompts: ApprovalPrompt[] = [];
  const signals: AbortSignal[] = [];
  const confirm = async (prompt: ApprovalPrompt, signal: AbortSignal) => {
    prompts.push(prompt);
    signals.push(signal);
    const answer = answers.shift();
    if (answer === undefined) assert.fail("asked more often than expected");
    return answer;
  };
  return { prompts, signals, confirm };
}

const live = () => new AbortController().signal;

test("the prompt is OpenMuse's text, with the model's label on its own attributed line", () => {
  assert.equal(
    CONTROL_MESSAGE,
    "The agent wants to control your Mac for this task",
  );
  assert.equal(CONTROL_ALLOW, "Allow for this task");
  assert.deepEqual(controlPrompt("Report spam button"), {
    message: CONTROL_MESSAGE,
    detail: `${CONTROL_DETAIL}\nThe agent says its first step is: Report spam button`,
    allow: CONTROL_ALLOW,
  });
  assert.deepEqual(controlPrompt(), {
    message: CONTROL_MESSAGE,
    detail: CONTROL_DETAIL,
    allow: CONTROL_ALLOW,
  });
});

test("the first action of a run asks once; later actions in that run don't ask", async () => {
  const { prompts, confirm } = user([true]);
  const grants = new ControlGrants(confirm);
  const { run } = fakeRun();
  assert.equal(grants.has(run), false);
  await grants.ensure(run, live(), "Inbox");
  await grants.ensure(run, live());
  await grants.ensure(run, live(), "Report spam");
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].detail?.endsWith("its first step is: Inbox"), true);
  assert.equal(grants.has(run), true);
});

test("the prompt gets the signal of the call that asked", async () => {
  const { signals, confirm } = user([true]);
  const grants = new ControlGrants(confirm);
  const call = new AbortController();
  await grants.ensure(fakeRun().run, call.signal);
  assert.equal(signals[0], call.signal);
});

test("a new run asks again", async () => {
  const { prompts, confirm } = user([true, true]);
  const grants = new ControlGrants(confirm);
  const first = fakeRun("run-1");
  const second = fakeRun("run-2");
  await grants.ensure(first.run, live());
  assert.equal(grants.has(second.run), false);
  await grants.ensure(second.run, live());
  assert.equal(prompts.length, 2);
});

test("the grant ends with its run, and the ended run can't ask again", async () => {
  const { prompts, confirm } = user([true]);
  const grants = new ControlGrants(confirm);
  const { run, end } = fakeRun();
  await grants.ensure(run, live());
  end();
  assert.equal(grants.has(run), false);
  await assert.rejects(grants.ensure(run, live()), {
    message: RUN_ENDED_MESSAGE,
  });
  assert.equal(prompts.length, 1);
});

test("a decline tells the model not to retry, and holds for the rest of the run without asking again", async () => {
  const { prompts, confirm } = user([false]);
  const grants = new ControlGrants(confirm);
  const { run } = fakeRun();
  await assert.rejects(grants.ensure(run, live()), {
    message: DECLINED_MESSAGE,
  });
  await assert.rejects(grants.ensure(run, live()), {
    message: DECLINED_MESSAGE,
  });
  assert.equal(prompts.length, 1);
  assert.equal(grants.has(run), false);
});

test("calls that arrive while the prompt is open share its one answer", async () => {
  const prompts: ApprovalPrompt[] = [];
  let answer!: (allowed: boolean) => void;
  const grants = new ControlGrants((prompt) => {
    prompts.push(prompt);
    return new Promise((resolve) => (answer = resolve));
  });
  const { run } = fakeRun();
  const first = grants.ensure(run, live(), "Inbox");
  const second = grants.ensure(run, live(), "Report spam");
  answer(true);
  await Promise.all([first, second]);
  assert.equal(prompts.length, 1);
  assert.equal(grants.has(run), true);
});

test("a prompt that closes without an answer is not a decline: the next action asks again", async () => {
  let calls = 0;
  const grants = new ControlGrants(async () => {
    calls += 1;
    if (calls === 1)
      throw new Error("The request was cancelled before the user answered.");
    return true;
  });
  const { run } = fakeRun();
  await assert.rejects(
    grants.ensure(run, live()),
    /cancelled before the user answered/,
  );
  assert.equal(grants.has(run), false);
  await grants.ensure(run, live());
  assert.equal(calls, 2);
  assert.equal(grants.has(run), true);
});

test("a run that ends while its prompt is open gets no grant, even if the user then allows", async () => {
  let answer!: (allowed: boolean) => void;
  const grants = new ControlGrants(
    () => new Promise((resolve) => (answer = resolve)),
  );
  const { run, end } = fakeRun();
  const pending = grants.ensure(run, live());
  end();
  answer(true);
  await assert.rejects(pending, { message: RUN_ENDED_MESSAGE });
  assert.equal(grants.has(run), false);
});

test("after the run sends input, only screenshots captured since then are fresh", async () => {
  const { confirm } = user([true]);
  const grants = new ControlGrants(confirm);
  const { run } = fakeRun();
  await grants.ensure(run, live());
  // Before any input, any screenshot will do, such as one the user attached.
  grants.requireFresh(run, "shot_00000001");
  grants.acting(run);
  assert.throws(() => grants.requireFresh(run, "shot_00000001"), {
    message: staleScreenshotMessage("shot_00000001"),
  });
  grants.captured(run, "shot_00000002");
  grants.requireFresh(run, "shot_00000002");
  grants.acting(run);
  assert.throws(() => grants.requireFresh(run, "shot_00000002"), {
    message: staleScreenshotMessage("shot_00000002"),
  });
});

test("acting, captured and requireFresh do nothing for a run without a grant", () => {
  const grants = new ControlGrants(async () => true);
  const { run } = fakeRun();
  grants.acting(run);
  grants.captured(run, "shot_00000001");
  grants.requireFresh(run, "shot_00000002");
  assert.equal(grants.has(run), false);
});
