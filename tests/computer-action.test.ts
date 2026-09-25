import { test } from "node:test";
import assert from "node:assert/strict";
import { DECLINED_MESSAGE, type ApprovalPrompt } from "../electron/approval";
import {
  AFTER_INPUT_NOTE,
  PROMPT_OPEN_MESSAGE,
  STOPPED_MESSAGE,
  openUrl,
  openUrlPrompt,
  pressKeys,
  takeScreenshot,
  toActionScreenshot,
  typeText,
  type ActionWindow,
  type ComputerDeps,
} from "../electron/computer-action";
import {
  CONTROL_MESSAGE,
  ControlGrants,
  RUN_ENDED_MESSAGE,
  staleScreenshotMessage,
} from "../electron/control-grant";
import { BLOCKED_CHORD_MESSAGE } from "../server/computer-schema";
import type { AgentRun } from "../server/run-registry";
import { describeToolScreenshot } from "../server/screenshots";
import type { ActionScreenshot } from "../src/types";

// resolve() returns the registry's own screenshot object, so a capture that
// is still there is the same object on every resolve.
const shot = { label: "Built-in Retina Display" };
const after: ActionScreenshot = {
  id: "shot_5e6f7a8b",
  label: "Built-in Retina Display",
  width: 1512,
  height: 982,
  png: "iVBORw0KGgo=",
};

function fakeRun(id = "run-1") {
  const ended = new AbortController();
  const run: AgentRun = Object.freeze({ id, signal: ended.signal });
  return { run, end: () => ended.abort() };
}

const live = () => new AbortController().signal;

// A real ControlGrants with a scripted user. Everything else records, in
// `events`, what it was asked to do. resolve() doubles the pixel
// coordinates, so a test can tell screen points from pixels.
function harness(
  options: {
    answers?: boolean[];
    windows?: ActionWindow[];
    promptOpen?: () => boolean;
    capture?: () => Promise<ActionScreenshot>;
    resolve?: ComputerDeps["resolve"];
    click?: ComputerDeps["click"];
  } = {},
) {
  const events: string[] = [];
  const prompts: ApprovalPrompt[] = [];
  const answers = [...(options.answers ?? [true])];
  const confirm = async (prompt: ApprovalPrompt) => {
    prompts.push(prompt);
    events.push("ask");
    const answer = answers.shift();
    if (answer === undefined)
      assert.fail(`asked more often than expected: ${prompt.message}`);
    return answer;
  };
  const deps: ComputerDeps = {
    grants: new ControlGrants(confirm),
    resolve:
      options.resolve ??
      ((request) => {
        events.push("resolve");
        return { shot, point: { x: request.x * 2, y: request.y * 2 } };
      }),
    windows: () => options.windows ?? [],
    promptOpen: options.promptOpen ?? (() => false),
    confirm,
    capture:
      options.capture ??
      (async () => {
        events.push("capture");
        return after;
      }),
    wait: async (ms) => {
      events.push(`wait:${ms}`);
    },
    click:
      options.click ??
      (async (point, button, clicks) => {
        events.push(`click:${point.x},${point.y}:${button}:${clicks}`);
      }),
    scroll: async (point, direction, amount) => {
      events.push(`scroll:${point.x},${point.y}:${direction}:${amount}`);
    },
    type: async (text) => {
      events.push(`type:${text}`);
    },
    keys: async (key, modifiers) => {
      events.push(`keys:${[...modifiers, key].join("+")}`);
    },
    openUrl: async (url, bundleId) => {
      events.push(`open:${url}:${bundleId}`);
    },
  };
  return { deps, events, prompts };
}

test("take_screenshot asks once for the task, then captures and describes the screenshot", async () => {
  const { deps, events, prompts } = harness();
  const { run } = fakeRun();
  const result = await takeScreenshot(run, live(), deps);
  assert.deepEqual(events, ["ask", "capture"]);
  assert.equal(prompts[0].message, CONTROL_MESSAGE);
  assert.equal(result.text, describeToolScreenshot(after));
  assert.equal(result.screenshot, after);
  await takeScreenshot(run, live(), deps);
  assert.equal(prompts.length, 1);
});

test("a declined grant captures nothing and tells the model not to retry", async () => {
  const { deps, events } = harness({ answers: [false] });
  await assert.rejects(takeScreenshot(fakeRun().run, live(), deps), {
    message: DECLINED_MESSAGE,
  });
  assert.deepEqual(events, ["ask"]);
});

test("type_text sends the text and says to take a screenshot before the next click", async () => {
  const { deps, events } = harness();
  const smile = String.fromCodePoint(0x1f600);
  const result = await typeText("hi" + smile, fakeRun().run, live(), deps);
  assert.deepEqual(events, ["ask", "type:hi" + smile]);
  assert.equal(
    result.text,
    `OpenMuse typed 3 characters into the focused field. ${AFTER_INPUT_NOTE}`,
  );
  assert.equal(result.screenshot, undefined);
});

test("keys and text wait while any OpenMuse prompt is open, and send nothing", async () => {
  const { deps, events } = harness({ promptOpen: () => true });
  const { run } = fakeRun();
  await assert.rejects(typeText("hello", run, live(), deps), {
    message: PROMPT_OPEN_MESSAGE,
  });
  await assert.rejects(
    pressKeys(
      { type: "keys", key: "return", modifiers: [] },
      run,
      live(),
      deps,
    ),
    { message: PROMPT_OPEN_MESSAGE },
  );
  assert.deepEqual(events, ["ask"]);
});

test("press_keys sends the chord; a blocked shortcut is refused before the user is asked", async () => {
  const { deps, events } = harness();
  const { run } = fakeRun();
  await assert.rejects(
    pressKeys(
      { type: "keys", key: "q", modifiers: ["command", "shift"] },
      run,
      live(),
      deps,
    ),
    { message: BLOCKED_CHORD_MESSAGE },
  );
  assert.deepEqual(events, []);
  const result = await pressKeys(
    { type: "keys", key: "l", modifiers: ["command"] },
    run,
    live(),
    deps,
  );
  assert.deepEqual(events, ["ask", "keys:command+l"]);
  assert.equal(result.text, `OpenMuse pressed command+l. ${AFTER_INPUT_NOTE}`);
});

test("open_url outside a grant asks about that page alone, and allowing it grants nothing more", async () => {
  const { deps, events, prompts } = harness({ answers: [true, true] });
  const { run } = fakeRun();
  const result = await openUrl(
    {
      type: "open-url",
      url: "https://mail.google.com",
      bundleId: "com.google.Chrome",
    },
    run,
    live(),
    deps,
  );
  assert.deepEqual(prompts[0], {
    message: "The agent wants to open a web page",
    detail:
      "The agent says the page is: https://mail.google.com/\nThe agent says the app is: com.google.Chrome",
  });
  assert.deepEqual(
    prompts[0],
    openUrlPrompt("https://mail.google.com/", "com.google.Chrome"),
  );
  assert.deepEqual(events, [
    "ask",
    "open:https://mail.google.com/:com.google.Chrome",
  ]);
  assert.equal(
    result.text,
    `OpenMuse opened https://mail.google.com/ in com.google.Chrome. ${AFTER_INPUT_NOTE}`,
  );
  assert.equal(deps.grants.has(run), false);
  await takeScreenshot(run, live(), deps);
  assert.equal(prompts[1].message, CONTROL_MESSAGE);
});

test("open_url under a grant doesn't ask, and makes older screenshots stale", async () => {
  const { deps, events, prompts } = harness();
  const { run } = fakeRun();
  await takeScreenshot(run, live(), deps);
  await openUrl(
    {
      type: "open-url",
      url: "https://mail.google.com",
      bundleId: "com.google.Chrome",
    },
    run,
    live(),
    deps,
  );
  assert.equal(prompts.length, 1);
  assert.deepEqual(events.slice(-1), [
    "open:https://mail.google.com/:com.google.Chrome",
  ]);
  assert.throws(() => deps.grants.requireFresh(run, after.id), {
    message: staleScreenshotMessage(after.id),
  });
});

test("a declined web page opens nothing", async () => {
  const { deps, events } = harness({ answers: [false] });
  await assert.rejects(
    openUrl(
      {
        type: "open-url",
        url: "https://example.com",
        bundleId: "com.apple.Safari",
      },
      fakeRun().run,
      live(),
      deps,
    ),
    { message: DECLINED_MESSAGE },
  );
  assert.deepEqual(events, ["ask"]);
});

test("Stop during typing reports the stop, not the helper's own reason", async () => {
  const { deps } = harness();
  const call = new AbortController();
  deps.type = async () => {
    call.abort();
    throw new Error("The desktop helper could not run (ABORT_ERR)");
  };
  await assert.rejects(typeText("hello", fakeRun().run, call.signal, deps), {
    message: STOPPED_MESSAGE,
  });
});

test("an ended run can't act at all", async () => {
  const { deps } = harness();
  const { run, end } = fakeRun();
  await takeScreenshot(run, live(), deps);
  end();
  await assert.rejects(typeText("hello", run, live(), deps), {
    message: RUN_ENDED_MESSAGE,
  });
});

test("a capture becomes a tool screenshot with the PNG as bare base64", () => {
  assert.deepEqual(
    toActionScreenshot({
      id: after.id,
      label: after.label,
      width: after.width,
      height: after.height,
      dataUrl: "data:image/png;base64," + after.png,
    }),
    after,
  );
  assert.throws(
    () =>
      toActionScreenshot({ ...after, dataUrl: "data:image/jpeg;base64,AAAA" }),
    /not a PNG image/,
  );
});
