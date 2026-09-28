import { test } from "node:test";
import assert from "node:assert/strict";
import { DECLINED_MESSAGE, type ApprovalPrompt } from "../electron/approval";
import {
  AFTER_INPUT_NOTE,
  PROMPT_OPEN_MESSAGE,
  REPLACED_MESSAGE,
  SETTLE_MS,
  STOPPED_MESSAGE,
  WINDOW_RESTORE_NOTE,
  clearAround,
  clickOnScreen,
  openUrl,
  openUrlPrompt,
  pressKeys,
  scrollOnScreen,
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
import { markTransparent } from "../electron/window-occlusion";
import { BLOCKED_CHORD_MESSAGE } from "../server/computer-schema";
import type { AgentRun } from "../server/run-registry";
import { describeToolScreenshot, type Rect } from "../server/screenshots";
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
    { message: "Screen capture is not a PNG image." },
  );
});

const click = {
  type: "click" as const,
  screenshotId: "shot_1a2b3c4d",
  x: 100,
  y: 200,
  label: "Report spam",
  button: "left" as const,
  clicks: 1,
};

// A window whose visibility, opacity and mouse handling are real state, so
// conceal() and clearAround() act on it as they would on a BrowserWindow.
function fakeWindow(name: string, bounds: Rect, events: string[]) {
  const state = {
    visible: true,
    opacity: 1,
    ignoring: false,
    destroyed: false,
  };
  const win: ActionWindow = {
    isVisible: () => state.visible,
    isDestroyed: () => state.destroyed,
    getBounds: () => bounds,
    getOpacity: () => state.opacity,
    setOpacity: (opacity) => {
      state.opacity = opacity;
      events.push(`${opacity === 0 ? "fade" : "unfade"}:${name}`);
    },
    setIgnoreMouseEvents: (ignore) => {
      state.ignoring = ignore;
    },
    hide: () => {
      state.visible = false;
      events.push(`hide:${name}`);
    },
    showInactive: () => {
      state.visible = true;
      events.push(`show:${name}`);
    },
  };
  return { win, state };
}

test("a click resolves, asks once for the task, resolves again, sends the click at the screen point, then returns a screenshot", async () => {
  const { deps, events, prompts } = harness();
  const { run } = fakeRun();
  const result = await clickOnScreen(click, run, live(), deps);
  assert.deepEqual(events, [
    "resolve",
    "ask",
    "resolve",
    "click:200,400:left:1",
    `wait:${SETTLE_MS}`,
    "capture",
  ]);
  assert.equal(prompts[0].message, CONTROL_MESSAGE);
  assert.match(
    prompts[0].detail ?? "",
    /\nThe agent says its first step is: Report spam$/,
  );
  assert.equal(result.screenshot, after);
  assert.equal(
    result.text,
    `OpenMuse sent a left click to "Report spam" at (100, 200) in shot_1a2b3c4d. ${describeToolScreenshot(after)} It was taken after the click: check it to see what happened, and use it for your next click or scroll.`,
  );
});

test("the screenshot a click returns is the one the next click must use", async () => {
  const { deps, prompts } = harness();
  const { run } = fakeRun();
  await clickOnScreen(click, run, live(), deps);
  await assert.rejects(clickOnScreen(click, run, live(), deps), {
    message: staleScreenshotMessage(click.screenshotId),
  });
  await clickOnScreen(
    { ...click, screenshotId: after.id, clicks: 2 },
    run,
    live(),
    deps,
  );
  assert.equal(prompts.length, 1);
});

test("after typing, a click with an older screenshot is refused until a new one is taken", async () => {
  const { deps, events } = harness();
  const { run } = fakeRun();
  await takeScreenshot(run, live(), deps);
  await typeText("newsletter", run, live(), deps);
  await assert.rejects(
    clickOnScreen({ ...click, screenshotId: after.id }, run, live(), deps),
    { message: staleScreenshotMessage(after.id) },
  );
  assert.equal(
    events.some((event) => event.startsWith("click:")),
    false,
  );
  await takeScreenshot(run, live(), deps);
  await clickOnScreen({ ...click, screenshotId: after.id }, run, live(), deps);
});

test("a screenshot that can't be used is refused before the user is asked", async () => {
  const refusal =
    "That screenshot is more than 10 minutes old. Ask the user to attach a new one.";
  const { deps, prompts } = harness({
    resolve: () => {
      throw new Error(refusal);
    },
  });
  await assert.rejects(clickOnScreen(click, fakeRun().run, live(), deps), {
    message: refusal,
  });
  assert.equal(prompts.length, 0);
});

test("a screenshot replaced while the prompt was open is refused, and nothing is clicked", async () => {
  let resolves = 0;
  const { deps, events } = harness({
    resolve: () => ({
      shot: resolves++ === 0 ? shot : { ...shot },
      point: { x: 1, y: 1 },
    }),
  });
  await assert.rejects(clickOnScreen(click, fakeRun().run, live(), deps), {
    message: REPLACED_MESSAGE,
  });
  assert.deepEqual(events, ["ask"]);
});

test("a declined grant clicks nothing, and a retry in the same run doesn't ask again", async () => {
  const { deps, events, prompts } = harness({ answers: [false] });
  const { run } = fakeRun();
  await assert.rejects(clickOnScreen(click, run, live(), deps), {
    message: DECLINED_MESSAGE,
  });
  await assert.rejects(clickOnScreen(click, run, live(), deps), {
    message: DECLINED_MESSAGE,
  });
  assert.equal(prompts.length, 1);
  assert.equal(
    events.some((event) => event.startsWith("click:")),
    false,
  );
});

test("clicks and scrolls wait while any OpenMuse prompt is open", async () => {
  const { deps, events } = harness({ promptOpen: () => true });
  const { run } = fakeRun();
  await assert.rejects(clickOnScreen(click, run, live(), deps), {
    message: PROMPT_OPEN_MESSAGE,
  });
  await assert.rejects(
    scrollOnScreen(
      { ...click, type: "scroll", direction: "down", amount: 3 },
      run,
      live(),
      deps,
    ),
    { message: PROMPT_OPEN_MESSAGE },
  );
  assert.equal(
    events.some((event) => /^(click|scroll):/.test(event)),
    false,
  );
});

test("an opaque covering window is faded and click-through, a transparent one is hidden, and both come back", async () => {
  const events: string[] = [];
  const workspace = fakeWindow(
    "workspace",
    { x: 0, y: 0, width: 1240, height: 820 },
    events,
  );
  const chat = fakeWindow(
    "chat",
    { x: 150, y: 350, width: 380, height: 520 },
    events,
  );
  const pet = fakeWindow(
    "pet",
    { x: 1200, y: 800, width: 240, height: 170 },
    events,
  );
  markTransparent(chat.win);
  markTransparent(pet.win);
  const during: { workspaceIgnoring?: boolean; chatVisible?: boolean } = {};
  const { deps } = harness({
    windows: [workspace.win, chat.win, pet.win],
    click: async (point) => {
      events.push(`click:${point.x},${point.y}`);
      during.workspaceIgnoring = workspace.state.ignoring;
      during.chatVisible = chat.state.visible;
    },
  });
  await clickOnScreen(click, fakeRun().run, live(), deps);
  assert.deepEqual(events, [
    "fade:workspace",
    "hide:chat",
    "click:200,400",
    "show:chat",
    "unfade:workspace",
  ]);
  assert.deepEqual(during, { workspaceIgnoring: true, chatVisible: false });
  assert.equal(workspace.state.ignoring, false);
  assert.equal(pet.state.visible, true);
});

test("a window destroyed while the click was under way is skipped when windows come back", async () => {
  const events: string[] = [];
  const chat = fakeWindow(
    "chat",
    { x: 150, y: 350, width: 380, height: 520 },
    events,
  );
  markTransparent(chat.win);
  const { deps } = harness({
    windows: [chat.win],
    click: async () => {
      // Quitting destroys windows while runs are still being stopped.
      chat.state.destroyed = true;
    },
  });
  await clickOnScreen(click, fakeRun().run, live(), deps);
  assert.deepEqual(events, ["hide:chat"]);
});

test("Stop during a click reports the stop, brings the windows back and takes no screenshot", async () => {
  const events: string[] = [];
  const chat = fakeWindow(
    "chat",
    { x: 150, y: 350, width: 380, height: 520 },
    events,
  );
  markTransparent(chat.win);
  const call = new AbortController();
  const { deps } = harness({
    windows: [chat.win],
    click: async () => {
      call.abort();
      throw new Error("The desktop helper could not run (ABORT_ERR)");
    },
  });
  await assert.rejects(clickOnScreen(click, fakeRun().run, call.signal, deps), {
    message: STOPPED_MESSAGE,
  });
  assert.deepEqual(events, ["hide:chat", "show:chat"]);
});

test("a click whose screenshot then fails still reports the click, and says to take one", async () => {
  const reason =
    "Screen capture didn't respond. Try again, or quit and reopen OpenMuse Desktop.";
  const { deps } = harness({
    capture: async () => {
      throw new Error(reason);
    },
  });
  const result = await clickOnScreen(click, fakeRun().run, live(), deps);
  assert.equal(
    result.text,
    `OpenMuse sent a left click to "Report spam" at (100, 200) in shot_1a2b3c4d. OpenMuse couldn't take a screenshot afterwards: ${reason} Call take_screenshot before your next click or scroll.`,
  );
  assert.equal(result.screenshot, undefined);
});

test("a stop that lands after the click has been sent skips the screenshot", async () => {
  const call = new AbortController();
  const { deps, events } = harness({
    click: async () => {
      call.abort();
    },
  });
  const result = await clickOnScreen(click, fakeRun().run, call.signal, deps);
  assert.equal(events.includes("capture"), false);
  assert.equal(result.screenshot, undefined);
});

test("a scroll sends its direction and notches at the screen point, then returns a screenshot", async () => {
  const { deps, events } = harness();
  const result = await scrollOnScreen(
    { ...click, type: "scroll", label: "Inbox", direction: "down", amount: 3 },
    fakeRun().run,
    live(),
    deps,
  );
  assert.deepEqual(events.slice(2), [
    "resolve",
    "scroll:200,400:down:3",
    `wait:${SETTLE_MS}`,
    "capture",
  ]);
  assert.match(
    result.text,
    /^OpenMuse scrolled down 3 notches over "Inbox" at \(100, 200\) in shot_1a2b3c4d\. /,
  );
  assert.equal(result.screenshot, after);
});

test("clearAround leaves hidden and faraway windows alone", () => {
  const events: string[] = [];
  const hidden = fakeWindow(
    "hidden",
    { x: 0, y: 0, width: 500, height: 500 },
    events,
  );
  hidden.state.visible = false;
  const far = fakeWindow(
    "far",
    { x: 2000, y: 2000, width: 100, height: 100 },
    events,
  );
  clearAround({ x: 10, y: 10 }, [hidden.win, far.win])();
  assert.deepEqual(events, []);
});

test("a window that fails to come back is retried on the next clearAround, even far from where it failed", () => {
  const events: string[] = [];
  const chat = fakeWindow(
    "chat",
    { x: 150, y: 350, width: 380, height: 520 },
    events,
  );
  markTransparent(chat.win);
  let showAttempts = 0;
  chat.win.showInactive = () => {
    showAttempts += 1;
    if (showAttempts === 1) throw new Error("boom");
    chat.state.visible = true;
    events.push("show:chat");
  };
  assert.throws(clearAround({ x: 150, y: 350 }, [chat.win]));
  assert.equal(chat.state.visible, false);
  // Nowhere near the window, and it's still reporting isVisible() === false,
  // so only the earlier failure being remembered gets it retried here.
  clearAround({ x: 9000, y: 9000 }, [chat.win])();
  assert.equal(chat.state.visible, true);
  assert.equal(showAttempts, 2);
});

test("a destroyed window is skipped, not tracked for retry", () => {
  const events: string[] = [];
  const chat = fakeWindow(
    "chat",
    { x: 150, y: 350, width: 380, height: 520 },
    events,
  );
  markTransparent(chat.win);
  chat.win.showInactive = () => {
    throw new Error("boom");
  };
  assert.throws(clearAround({ x: 150, y: 350 }, [chat.win]));
  chat.state.destroyed = true;
  // A destroyed window can't come back and isn't retried; a later
  // clearAround call must not touch it at all (isVisible()/getBounds()
  // would throw on a real destroyed BrowserWindow).
  chat.win.isVisible = () => {
    throw new Error("Object has been destroyed");
  };
  chat.win.getBounds = () => {
    throw new Error("Object has been destroyed");
  };
  clearAround({ x: 150, y: 350 }, [chat.win])();
});

test("a click whose window fails to come back still succeeds, and tells the model it may be hidden", async () => {
  const events: string[] = [];
  const chat = fakeWindow(
    "chat",
    { x: 150, y: 350, width: 380, height: 520 },
    events,
  );
  markTransparent(chat.win);
  chat.win.showInactive = () => {
    throw new Error("window-specific detail that must not leak to the model");
  };
  const { deps } = harness({ windows: [chat.win] });
  const originalConsoleError = console.error;
  const logged: unknown[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args);
  };
  try {
    const result = await clickOnScreen(click, fakeRun().run, live(), deps);
    assert.ok(result.text.includes(WINDOW_RESTORE_NOTE));
    assert.ok(!result.text.includes("must not leak"));
    assert.equal(logged.length, 1);
  } finally {
    console.error = originalConsoleError;
  }
});
