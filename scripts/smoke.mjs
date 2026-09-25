import { _electron as electron, expect } from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  chmod,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

function launch(dir) {
  return electron.launch({
    ...(process.argv.includes("--packaged")
      ? {
          executablePath:
            "release/mac-arm64/OpenMuse Desktop.app/Contents/MacOS/OpenMuse Desktop",
          args: [],
        }
      : { args: ["."] }),
    env: {
      ...process.env,
      KITE_DATA_DIR: dir,
      // Always the built renderer, even when the shell names a dev server.
      KITE_DEV_URL: "",
      OPENAI_API_KEY: "",
      ...(process.argv.includes("--cloud")
        ? {}
        : { CPK_INTELLIGENCE_API_KEY: "" }),
    },
  });
}
// The saved preferences, or null when there is no preferences file. Any other failure to read or
// parse it throws, so a broken file never passes for a missing one.
const readPreferences = (dir) =>
  readFile(join(dir, "preferences.json"), "utf8").then(
    (text) => JSON.parse(text),
    (error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    },
  );
const pane = (name) =>
  `x-apple.systempreferences:com.apple.preference.security?${name}`;
const permissionRows = [
  ["accessibility", "Accessibility", "Privacy_Accessibility"],
  ["screenCapture", "Screen Recording", "Privacy_ScreenCapture"],
];
const ACCESSIBILITY_REFUSAL =
  "Enable Accessibility for OpenMuse Desktop in System Settings, then retry.";
// The message a renderer gets when zod refuses an IPC argument: the issues as indented JSON.
const zodMessage = (...issues) => JSON.stringify(issues, null, 2);

// Every check records exactly one ledger entry and a passing run prints them all, so the output
// shows what this run exercised on this Mac and what it skipped, not a one-line summary.
const ledger = [];
function record(name, reason) {
  if (ledger.some((entry) => entry.name === name))
    throw new Error(`Smoke check recorded twice: ${name}`);
  ledger.push({ name, reason });
}
const covered = (name) => record(name, undefined);
const skipped = (name, reason) => record(name, reason);

// True when no single value can match both `before` and `after` the way toMatchObject matches them.
// An asymmetric matcher (an object with an asymmetricMatch function) is compatible with anything,
// so it is never a conflict by itself. Two arrays conflict only if their lengths differ or some
// element conflicts. Two objects conflict only if some key that both of them name conflicts. Any
// other pair conflicts unless the two are deeply equal.
function conflicts(before, after) {
  const isMatcher = (value) => typeof value?.asymmetricMatch === "function";
  if (isMatcher(before) || isMatcher(after)) return false;
  if (Array.isArray(before) && Array.isArray(after))
    return (
      before.length !== after.length ||
      before.some((item, index) => conflicts(item, after[index]))
    );
  const isRecord = (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  if (isRecord(before) && isRecord(after))
    return Object.keys(after).some(
      (key) => key in before && conflicts(before[key], after[key]),
    );
  return !isDeepStrictEqual(before, after);
}

// Waits for read() to match `before`, runs act(), then waits for read() to match `after`, both with
// toMatchObject semantics. Two kinds of check are refused at once, because they would pass even if
// act() changed nothing: one whose `after` names a top-level key that `before` does not (that value
// may have held before act() ran), and a pair that one state could satisfy (identical objects
// included).
async function expectChange(read, before, act, after) {
  const unchecked = Object.keys(after).filter((key) => !(key in before));
  if (unchecked.length)
    throw new Error(
      `Change check expects ${unchecked.join(", ")} afterwards without checking it before: ${JSON.stringify(before)} then ${JSON.stringify(after)}`,
    );
  if (!conflicts(before, after))
    throw new Error(
      `Vacuous change check: one state can match both ${JSON.stringify(before)} and ${JSON.stringify(after)}`,
    );
  await expect.poll(read).toMatchObject(before);
  await act();
  await expect.poll(read).toMatchObject(after);
}

// Runs every cleanup step even when an earlier one fails. A cleanup failure fails the smoke only if
// the checks passed; after a failed check it is printed, so it never hides that failure.
async function cleanUp(checksPassed, ...steps) {
  const failures = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (!failures.length) return;
  if (checksPassed) throw new AggregateError(failures, "Smoke cleanup failed");
  for (const error of failures)
    console.error("Smoke cleanup also failed:", error);
}

const QUIT_TIMEOUT_MS = 20000;
// Resolves true once `promise` settles, or false if it is still pending after `ms` milliseconds.
function settlesWithin(promise, ms) {
  let timer;
  return Promise.race([
    promise.then(
      () => true,
      () => true,
    ),
    new Promise((resolve) => {
      timer = setTimeout(resolve, ms, false);
    }),
  ]).finally(() => clearTimeout(timer));
}
// Quits an app and waits for it to exit. electronApp.close() waits forever when the quit never
// completes (a window cancels it, or a dialog blocks it), so after 20 s this kills the app and throws
// instead. Closing an app that already exited is a no-op.
async function closeApp(electronApp) {
  const closing = electronApp.close();
  if (await settlesWithin(closing, QUIT_TIMEOUT_MS)) return closing;
  electronApp.process()?.kill("SIGKILL");
  // close() settles once the killed app has exited; never wait forever for that either.
  await settlesWithin(closing, 5000);
  throw new Error(
    `The app did not quit within ${QUIT_TIMEOUT_MS / 1000} s (a window may be cancelling the quit)`,
  );
}

// Gives `checks` a fresh data folder and a launcher for it. Every window of every app the launcher
// starts (those already open and those opened later) is tracked for renderer errors. Afterwards it
// prints the tracked renderer errors (even when a check failed first), restores the folder's
// permissions, closes every app it launched and deletes the folder. Any renderer error fails the run.
async function withDataDir(prefix, checks) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  const launched = [];
  const pageErrors = [];
  const trackPageErrors = (page) =>
    page.on("pageerror", (error) =>
      pageErrors.push(`${roleOf(page.url()) ?? page.url()}: ${error.message}`),
    );
  let passed = false;
  try {
    await checks({
      dir,
      launchApp: async () => {
        const electronApp = await launch(dir);
        launched.push(electronApp);
        electronApp.windows().forEach(trackPageErrors);
        electronApp.on("window", trackPageErrors);
        return electronApp;
      },
    });
    passed = true;
  } finally {
    if (pageErrors.length)
      console.error(`Renderer errors:\n  ${pageErrors.join("\n  ")}`);
    await cleanUp(
      passed,
      () => chmod(dir, 0o700),
      ...launched.map((electronApp) => () => closeApp(electronApp)),
      () => rm(dir, { recursive: true, force: true }),
    );
  }
  if (pageErrors.length)
    throw new Error(`Renderer errors: ${pageErrors.join("; ")}`);
}

// A window's role by its URL. Every window loads the renderer's index.html: setup, the companion and
// the chat add a query flag, and the workspace is the one with no query string. Anything else, such
// as a window with no URL yet (mid-construction), has no role, so it never masquerades as the workspace.
function roleOf(url) {
  if (url.includes("onboarding=1")) return "setup";
  if (url.includes("buddy=1")) return "buddy";
  if (url.includes("companionChat=1")) return "chat";
  if (url.startsWith("file:") && !url.includes("?")) return "workspace";
  return undefined;
}
// Every app window that has a role: its BrowserWindow id, its role and whether it is visible.
async function appWindows(electronApp) {
  const all = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((window) => ({
      id: window.id,
      url: window.webContents.getURL(),
      visible: window.isVisible(),
    })),
  );
  return all.flatMap(({ id, url, visible }) => {
    const role = roleOf(url);
    return role ? [{ id, role, visible }] : [];
  });
}
// Each app window by role, true when visible.
const visibility = async (electronApp) =>
  Object.fromEntries(
    (await appWindows(electronApp)).map(({ role, visible }) => [role, visible]),
  );
// visibility() with a missing setup window reported as "closed", so a check can require it. The
// other windows are never destroyed while the app runs; closing one only hides it.
const windows = async (electronApp) => ({
  setup: "closed",
  ...(await visibility(electronApp)),
});
// Waits for the renderer page of a window role, skipping closed pages such as a replaced setup window.
async function waitForWindow(electronApp, role) {
  let found;
  await expect
    .poll(
      () => {
        found = electronApp
          .windows()
          .find((p) => !p.isClosed() && roleOf(p.url()) === role);
        return Boolean(found);
      },
      { timeout: 30000, message: `The ${role} window did not open` },
    )
    .toBe(true);
  return found;
}
// Calls a BrowserWindow method in the main process on the window with that role. It does nothing
// when no window has the role, so a check that needs the effect must assert it afterwards.
async function onWindow(electronApp, role, method) {
  const target = (await appWindows(electronApp)).find(
    (window) => window.role === role,
  );
  if (!target) return;
  await electronApp.evaluate(
    ({ BrowserWindow }, [id, name]) => {
      BrowserWindow.fromId(id)?.[name]();
    },
    [target.id, method],
  );
}
// Calls window.kite[method](...args) in a renderer; returns the rejection message, or null if it resolved.
const rejectionOf = (target, method, args) =>
  target.evaluate(
    ([name, values]) =>
      window.kite[name](...values).then(
        () => null,
        (error) => (error && error.message) || String(error),
      ),
    [method, args],
  );
// Requires the call to be refused with exactly `reason`: the whole message, nothing before or after it.
async function expectRefusal(target, method, args, reason) {
  // A call that is wrongly accepted can close its own window (e.g. completing setup), failing the evaluate.
  const message = await rejectionOf(target, method, args).catch(
    (error) => `no answer: ${error.message}`,
  );
  if (message !== reason)
    throw new Error(
      `window.kite.${method}() was not refused with exactly ${JSON.stringify(reason)}: ${message === null ? "it was accepted" : `got ${JSON.stringify(message)}`}`,
    );
}
// Makes the window.kite calls from one renderer task, in order, so the main process receives them
// back to back. Returns how each call settled: { status: "fulfilled" } or { status: "rejected", message }.
const settle = (target, calls) =>
  target.evaluate(
    (list) =>
      Promise.allSettled(
        list.map(([name, args]) => window.kite[name](...args)),
      ).then((results) =>
        results.map((result) =>
          result.status === "fulfilled"
            ? { status: "fulfilled" }
            : {
                status: "rejected",
                message: result.reason?.message ?? String(result.reason),
              },
        ),
      ),
    calls,
  );
// The setup step a setup window shows, by its heading.
const stepOf = (target) => async () => ({
  heading: await target.evaluate(
    () => document.querySelector("h1")?.textContent ?? null,
  ),
});

async function firstLaunch({ dir: dataDir, launchApp }) {
  const app = await launchApp();
  const page = await waitForWindow(app, "workspace");
  // What setup and recording can change: the windows, the main process's onboardingComplete and
  // active recording, and the saved preferences.
  const appState = async () => {
    const state = await page.evaluate(() => window.kite.state());
    return {
      windows: await windows(app),
      onboardingComplete: state.settings.onboardingComplete,
      active: state.active,
      preferences: await readPreferences(dataDir),
    };
  };
  const setupWindowTitleAndBounds = () =>
    app.evaluate(({ BrowserWindow, screen }) => {
      const win = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().includes("onboarding=1"),
      );
      return win
        ? {
            title: win.getTitle(),
            bounds: win.getBounds(),
            workArea: screen.getPrimaryDisplay().workArea,
          }
        : null;
    });

  const setup = await waitForWindow(app, "setup");
  const setupErrors = async () => ({
    errors: await setup.locator(".onboarding-error").allTextContents(),
  });
  await expect(
    setup.getByRole("heading", { name: "Meet your new work buddy." }),
  ).toBeVisible();
  await expect
    .poll(() => visibility(app))
    .toMatchObject({
      setup: true,
      buddy: false,
      workspace: false,
      chat: false,
    });

  // Measure the setup window's placement before anything (e.g. a later show()) could perturb it.
  const windowInfo = await setupWindowTitleAndBounds();
  if (!windowInfo) throw new Error("Setup window disappeared");
  if (windowInfo.title !== "Welcome to OpenMuse")
    throw new Error(`Unexpected setup window title: ${windowInfo.title}`);
  const expectedX = Math.round(
    windowInfo.workArea.x +
      (windowInfo.workArea.width - windowInfo.bounds.width) / 2,
  );
  const expectedY = Math.round(
    windowInfo.workArea.y +
      (windowInfo.workArea.height - windowInfo.bounds.height) / 2,
  );
  // Window bounds and work areas are in points. A non-native "scaled" display resolution (a
  // non-integer backing-store downscale) makes macOS round the placement: on this Mac's scaled
  // display (1800x1169 points on a 3024x1964 panel) the window has landed 0 or 1 point off
  // center vertically. Allow a few points either way.
  const CENTER_TOLERANCE_POINTS = 4;
  if (
    Math.abs(windowInfo.bounds.x - expectedX) > CENTER_TOLERANCE_POINTS ||
    Math.abs(windowInfo.bounds.y - expectedY) > CENTER_TOLERANCE_POINTS
  )
    throw new Error(
      `Setup window is more than ${CENTER_TOLERANCE_POINTS} points off center: ${JSON.stringify(windowInfo)}`,
    );
  covered("setup window opens centered on a fresh install");

  // A Dock activation while setup is incomplete must bring setup back, not the workspace or the
  // companion. The Dock click is simulated by emitting the app's activate event
  // (app.emit("activate")). Setup is hidden first; otherwise the activation would have nothing to change.
  await onWindow(app, "setup", "hide");
  await expectChange(
    () => visibility(app),
    { setup: false, workspace: false, buddy: false },
    () => app.evaluate(({ app: electronApp }) => electronApp.emit("activate")),
    { setup: true, workspace: false, buddy: false },
  );
  covered("Dock activation reopens a hidden setup window");

  // While setup is open nothing may use the companion or start a recording, and each refusal must
  // leave the windows, onboardingComplete, the active recording and the saved preferences as they were.
  const duringSetup = {
    windows: { setup: true, workspace: false, buddy: false, chat: false },
    onboardingComplete: false,
    active: null,
    preferences: { companion: "capybara", onboardingComplete: false },
  };
  expect(await appState()).toMatchObject(duringSetup);
  const buddyDuringSetup = await waitForWindow(app, "buddy");
  for (const [method, args] of [
    ["openCompanionTray", ["chat"]],
    ["openCompanionTray", ["record"]],
    ["toggleCompanionChat", []],
  ]) {
    await expectRefusal(
      buddyDuringSetup,
      method,
      args,
      "Finish setup to use the companion.",
    );
    expect(await appState()).toMatchObject(duringSetup);
  }
  covered("companion trays refused while setup is open");
  await expectRefusal(
    page,
    "start",
    ["Smoke"],
    "Finish setup before starting a recording.",
  );
  expect(await appState()).toMatchObject(duringSetup);
  covered("recording refused while setup is open");

  // The workspace can be shown while setup is open (⌘⇧K does). Its recording dialog must then say
  // that setup comes first and keep Start disabled even with a title typed. Start is also disabled
  // while Accessibility is missing, which would hide whether setup disables it, so for this check
  // the workspace is told that Accessibility is granted; the rest of its state is read live through
  // the companion window.
  const windowIds = Object.fromEntries(
    (await appWindows(app)).map(({ role, id }) => [role, id]),
  );
  await app.evaluate(
    ({ BrowserWindow }, [workspaceId, companionId]) => {
      const companion = BrowserWindow.fromId(companionId).webContents;
      const contents = BrowserWindow.fromId(workspaceId).webContents;
      // A handler on the window's own ipc answers before the app's ipcMain handler.
      contents.ipc.handle("kite:state", async () => {
        const state = await companion.executeJavaScript("window.kite.state()");
        return {
          ...state,
          permissions: { ...state.permissions, accessibility: true },
        };
      });
      contents.send("kite:update");
    },
    [windowIds.workspace, windowIds.buddy],
  );
  try {
    await onWindow(app, "workspace", "show");
    await expect.poll(() => visibility(app)).toMatchObject({ workspace: true });
    await page
      .getByRole("button", { name: "Record a workflow", exact: true })
      .click();
    await page.getByPlaceholder("e.g. Prepare my weekly report").fill("Smoke");
    // Only the setup line is left once the workspace has re-read its state with Accessibility granted.
    await expect(page.locator(".modal .inline-error")).toHaveText([
      "Finish setup before starting a recording.",
    ]);
    await expect(
      page.getByRole("button", { name: "Start recording", exact: true }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Show OpenMuse your way." }),
    ).toHaveCount(0);
  } finally {
    await app.evaluate(({ BrowserWindow }, id) => {
      const contents = BrowserWindow.fromId(id).webContents;
      contents.ipc.removeHandler("kite:state");
      contents.send("kite:update");
    }, windowIds.workspace);
    await onWindow(app, "workspace", "hide");
  }
  expect(await appState()).toMatchObject(duringSetup);
  covered("recording dialog explains that setup comes first");

  await expectRefusal(
    setup,
    "completeOnboarding",
    [{ openWorkspace: true, extra: 1 }],
    zodMessage({
      code: "unrecognized_keys",
      keys: ["extra"],
      path: [],
      message: 'Unrecognized key: "extra"',
    }),
  );
  expect(await appState()).toMatchObject(duringSetup);
  covered("setup refuses unknown completion options");

  // Closing the setup window skips setup only once that is saved. When the save fails, the window
  // stays open, a dialog says why, and the saved preferences do not change.
  const savedBeforeSkip = await readPreferences(dataDir);
  expect(savedBeforeSkip).toEqual({
    companion: "capybara",
    onboardingComplete: false,
  });
  await app.evaluate(({ dialog }) => {
    globalThis.__smokeDialogs = [];
    globalThis.__smokeShowMessageBox = dialog.showMessageBox;
    dialog.showMessageBox = async (...args) => {
      globalThis.__smokeDialogs.push({ message: args.at(-1)?.message });
      return { response: 0, checkboxChecked: false };
    };
  });
  await chmod(dataDir, 0o500);
  try {
    await onWindow(app, "setup", "close");
    await expect
      .poll(() => app.evaluate(() => globalThis.__smokeDialogs))
      .toEqual([{ message: "Could not skip setup" }]);
    expect(await appState()).toMatchObject({
      ...duringSetup,
      preferences: savedBeforeSkip,
    });
  } finally {
    try {
      await chmod(dataDir, 0o700);
    } finally {
      await app.evaluate(({ dialog }) => {
        dialog.showMessageBox = globalThis.__smokeShowMessageBox;
      });
    }
  }
  covered("closing setup stays open when skipping cannot be saved");

  await mkdir("artifacts", { recursive: true });
  await setup
    .locator(".onboarding-art img")
    .evaluate((image) => image.decode());
  await setup.screenshot({
    path: "artifacts/onboarding-welcome.png",
    animations: "disabled",
  });
  await expectChange(
    stepOf(setup),
    { heading: "Meet your new work buddy." },
    () => setup.getByRole("button", { name: /Get started/ }).click(),
    { heading: "Two quick permissions." },
  );
  await expect(
    setup.getByText(
      "Nothing is captured until you record or attach a screenshot.",
    ),
  ).toBeVisible();
  // This Mac's permission status, read once here: every check below assumes it stays the same for
  // the rest of the run.
  const granted = (await setup.evaluate(() => window.kite.state())).permissions;
  const grantedRows = permissionRows.filter(([kind]) => granted[kind]);
  // Never open real System Settings panes or macOS permission prompts. A permission request answers
  // with this Mac's real status after a short delay, as macOS would.
  await app.evaluate(({ shell, ipcMain }, status) => {
    globalThis.__smokeOpened = [];
    globalThis.__smokeRequested = [];
    shell.openExternal = async (url) => {
      globalThis.__smokeOpened.push(url);
    };
    globalThis.__smokeAnswerPermissions = (_event, kind) =>
      new Promise((resolve) => {
        globalThis.__smokeRequested.push(kind);
        setTimeout(() => resolve(status), 400);
      });
    ipcMain.removeHandler("kite:permissions");
    ipcMain.handle("kite:permissions", globalThis.__smokeAnswerPermissions);
  }, granted);
  const opened = () =>
    app.evaluate(() => ({ opened: globalThis.__smokeOpened }));
  const requested = () =>
    app.evaluate(() => ({ requested: globalThis.__smokeRequested }));
  const resetStubLogs = () =>
    app.evaluate(() => {
      globalThis.__smokeOpened = [];
      globalThis.__smokeRequested = [];
    });
  const continueButton = setup.getByRole("button", { name: /Continue/ });

  // A permission request that fails must say so and keep offering Allow instead of stranding the row.
  const ungranted = permissionRows.find(([kind]) => !granted[kind]);
  if (ungranted) {
    const [kind, title] = ungranted;
    const row = setup.locator(".onboarding-permission", { hasText: title });
    const allow = row.getByRole("button", {
      name: `Allow ${title}`,
      exact: true,
    });
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("kite:permissions");
      ipcMain.handle("kite:permissions", (_event, requestedKind) => {
        globalThis.__smokeRequested.push(requestedKind);
        throw new Error("The permission request failed");
      });
    });
    try {
      await expectChange(setupErrors, { errors: [] }, () => allow.click(), {
        errors: ["Could not ask macOS for permission. Try again."],
      });
      await expect(allow).toBeEnabled();
      await expect(row.getByText(/Waiting for System Settings/)).toHaveCount(0);
      expect(await requested()).toEqual({ requested: [kind] });
    } finally {
      await app.evaluate(({ ipcMain }) => {
        ipcMain.removeHandler("kite:permissions");
        ipcMain.handle("kite:permissions", globalThis.__smokeAnswerPermissions);
      });
    }
    covered("failed Allow keeps the Allow button");
  } else
    skipped(
      "failed Allow keeps the Allow button",
      "both permissions are already granted on this Mac",
    );

  for (const [kind, title, name] of permissionRows) {
    const check = `setup Allow asks macOS for ${title}`;
    if (granted[kind]) {
      skipped(check, `${title} is already granted on this Mac`);
      continue;
    }
    const row = setup.locator(".onboarding-permission", { hasText: title });
    await resetStubLogs();
    await expectChange(
      async () => ({
        ...(await requested()),
        waiting: await row.getByText(/Waiting for System Settings/).count(),
      }),
      { requested: [], waiting: 0 },
      async () => {
        await row
          .getByRole("button", { name: `Allow ${title}`, exact: true })
          .click();
        // The stub answers after 400 ms; until then Continue stays locked.
        await expect(continueButton).toBeDisabled();
      },
      { requested: [kind], waiting: 1 },
    );
    await expect(continueButton).toBeEnabled();
    await expectChange(
      opened,
      { opened: [] },
      () =>
        row
          .getByRole("button", {
            name: `Open System Settings for ${title}`,
            exact: true,
          })
          .click(),
      { opened: [pane(name)] },
    );
    covered(check);
  }
  for (const [, title] of grantedRows)
    await expect(
      setup
        .locator(".onboarding-permission", { hasText: title })
        .getByText("Allowed"),
    ).toBeVisible();
  if (grantedRows.length) covered("setup shows granted permissions as Allowed");
  else
    skipped(
      "setup shows granted permissions as Allowed",
      "neither permission is granted on this Mac",
    );

  // openPermissionSettings opens exactly the pane it is asked for, and nothing for an unknown name.
  for (const [kind, , name] of permissionRows) {
    await resetStubLogs();
    await expectChange(
      opened,
      { opened: [] },
      () =>
        setup.evaluate(
          (permission) => window.kite.openPermissionSettings(permission),
          kind,
        ),
      { opened: [pane(name)] },
    );
  }
  await resetStubLogs();
  await expectRefusal(
    setup,
    "openPermissionSettings",
    ["microphone"],
    zodMessage({
      code: "invalid_value",
      values: ["accessibility", "screenCapture"],
      path: [],
      message:
        'Invalid option: expected one of "accessibility"|"screenCapture"',
    }),
  );
  expect(await opened()).toEqual({ opened: [] });
  covered("setup opens only the known System Settings panes");

  await setup.screenshot({
    path: "artifacts/onboarding-permissions.png",
    animations: "disabled",
  });
  await expectChange(
    stepOf(setup),
    { heading: "Two quick permissions." },
    () => continueButton.click(),
    { heading: "You’re all set." },
  );
  covered("Get started and Continue advance setup");
  await setup
    .locator(".onboarding-art img")
    .evaluate((image) => image.decode());
  await setup.screenshot({
    path: "artifacts/onboarding-ready.png",
    animations: "disabled",
  });

  // A failed save must keep setup open, with its error shown in the setup window, instead of
  // opening the workspace.
  const openTheWorkspace = setup.getByRole("button", {
    name: "Open the workspace",
  });
  await chmod(dataDir, 0o500);
  try {
    await expectChange(
      setupErrors,
      { errors: [] },
      () => openTheWorkspace.click(),
      {
        errors: [
          "Could not save your settings. Check free disk space and folder permissions, then try again.",
        ],
      },
    );
    expect(await appState()).toMatchObject(duringSetup);
  } finally {
    await chmod(dataDir, 0o700);
  }
  covered("failed setup save keeps setup open with an error");
  await expectChange(
    appState,
    {
      windows: { setup: true, workspace: false, buddy: false },
      onboardingComplete: false,
      preferences: { onboardingComplete: false },
    },
    () => openTheWorkspace.click(),
    {
      windows: { setup: "closed", workspace: true, buddy: true, chat: false },
      onboardingComplete: true,
      preferences: { companion: "capybara", onboardingComplete: true },
    },
  );
  await page.waitForSelector(".app-shell", { timeout: 30000 });
  await expect(
    page.getByRole("heading", { name: "Good things take practice." }),
  ).toBeVisible();
  await page.screenshot({ path: "artifacts/kite-workspace.png" });
  covered("Open the workspace finishes setup");

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "macOS permissions" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /By the notch|Floating companion/ }),
  ).toHaveCount(0);
  covered("Settings has no removed placement options");

  // Every window gets the main process's own error message: the preload strips Electron's "Error
  // invoking remote method …" prefix from every call. A companion change that cannot be saved gives
  // a known message, which the workspace banner must show exactly.
  const errorBanner = async () => ({
    errors: await page.locator(".error-banner").allTextContents(),
  });
  await chmod(dataDir, 0o500);
  try {
    await expectChange(
      errorBanner,
      { errors: [] },
      () => page.getByRole("button", { name: "Kite", exact: true }).click(),
      {
        errors: [
          `Could not save ${join(dataDir, "preferences.json")}: Permission denied. Check free disk space and folder permissions, then try again.`,
        ],
      },
    );
  } finally {
    await chmod(dataDir, 0o700);
  }
  expect(await readPreferences(dataDir)).toMatchObject({
    companion: "capybara",
  });
  await page.getByTitle("Dismiss error").click();
  await expect(page.locator(".error-banner")).toHaveCount(0);
  covered("errors show without Electron's IPC prefix");

  // Picking a companion while setup is complete must not disturb a hidden companion window.
  await onWindow(app, "buddy", "hide");
  await expect.poll(() => visibility(app)).toMatchObject({ buddy: false });
  for (const [from, to, label] of [
    ["capybara", "kite", "Kite"],
    ["kite", "capybara", "Capybara"],
  ]) {
    const option = page.getByRole("button", { name: label, exact: true });
    await expectChange(
      () => readPreferences(dataDir),
      { companion: from },
      () => option.click(),
      { companion: to },
    );
    // The workspace shows the pick once the main process has finished handling it.
    await expect(option).toHaveAttribute("aria-pressed", "true");
    expect(await visibility(app)).toMatchObject({ buddy: false });
  }
  await onWindow(app, "buddy", "showInactive");
  await expect.poll(() => visibility(app)).toMatchObject({ buddy: true });
  covered("picking a companion keeps a hidden companion hidden");

  // Settings offers "Open System Settings for …" only for permissions not yet granted.
  for (const [kind, title, name] of permissionRows) {
    const check = `Settings opens System Settings for ${title}`;
    const settingsRow = page.locator(".permission-row", { hasText: title });
    if (granted[kind]) {
      await expect(
        settingsRow.getByRole("button", { name: /Open System Settings/ }),
      ).toHaveCount(0);
      skipped(check, `${title} is already granted on this Mac`);
      continue;
    }
    await resetStubLogs();
    await expectChange(
      opened,
      { opened: [] },
      () =>
        settingsRow
          .getByRole("button", {
            name: `Open System Settings for ${title}`,
            exact: true,
          })
          .click(),
      { opened: [pane(name)] },
    );
    covered(check);
  }
  if (grantedRows.length)
    covered("Settings hides System Settings for granted permissions");
  else
    skipped(
      "Settings hides System Settings for granted permissions",
      "neither permission is granted on this Mac",
    );

  const replaySetup = page.getByRole("button", { name: /Replay setup/ });
  await expectChange(
    appState,
    {
      windows: { setup: "closed", buddy: true },
      onboardingComplete: true,
      preferences: { onboardingComplete: true },
    },
    () => replaySetup.click(),
    {
      windows: { setup: true, buddy: false },
      onboardingComplete: false,
      preferences: { onboardingComplete: false },
    },
  );
  const replay = await waitForWindow(app, "setup");
  await expect(
    replay.getByRole("heading", { name: "Meet your new work buddy." }),
  ).toBeVisible();
  covered("Replay setup reopens setup and hides the companion");
  await expectChange(
    appState,
    {
      windows: { setup: true, buddy: false },
      onboardingComplete: false,
      preferences: { onboardingComplete: false },
    },
    () => onWindow(app, "setup", "close"),
    {
      windows: { setup: "closed", buddy: true },
      onboardingComplete: true,
      preferences: { onboardingComplete: true },
    },
  );
  covered("closing setup skips it");

  // Finishing setup via "Start using OpenMuse" (never exercised above) must also complete cleanly.
  await expectChange(
    appState,
    { windows: { setup: "closed", buddy: true } },
    () => replaySetup.click(),
    { windows: { setup: true, buddy: false } },
  );
  const replay2 = await waitForWindow(app, "setup");
  await expect(
    replay2.getByRole("heading", { name: "Meet your new work buddy." }),
  ).toBeVisible();
  await expectChange(
    stepOf(replay2),
    { heading: "Meet your new work buddy." },
    () => replay2.getByRole("button", { name: /Get started/ }).click(),
    { heading: "Two quick permissions." },
  );
  await expectChange(
    stepOf(replay2),
    { heading: "Two quick permissions." },
    () => replay2.getByRole("button", { name: /Continue/ }).click(),
    { heading: "You’re all set." },
  );
  await expectChange(
    appState,
    {
      windows: { setup: true, buddy: false },
      onboardingComplete: false,
      preferences: { onboardingComplete: false },
    },
    () => replay2.getByRole("button", { name: "Start using OpenMuse" }).click(),
    {
      windows: { setup: "closed", buddy: true },
      onboardingComplete: true,
      preferences: { onboardingComplete: true },
    },
  );
  covered("Start using OpenMuse finishes setup");

  const buddy = await waitForWindow(app, "buddy");
  const chat = await waitForWindow(app, "chat");

  // A replay and a recording must not overlap even when their calls reach the main process back to
  // back: whichever is handled first refuses the other, and the companion refuses its trays while a
  // replay is saving. Each check ends with setup complete again.
  const setupComplete = {
    windows: { setup: "closed", buddy: true, chat: false },
    onboardingComplete: true,
    active: null,
    preferences: { onboardingComplete: true },
  };
  expect(await appState()).toMatchObject(setupComplete);
  const [started, replayWhileStarting] = await settle(page, [
    ["start", ["Smoke"]],
    ["replayOnboarding", []],
  ]);
  expect(replayWhileStarting).toEqual({
    status: "rejected",
    message: "Stop the recording before replaying setup.",
  });
  if (granted.accessibility) {
    expect(started).toEqual({ status: "fulfilled" });
    await page.evaluate(() => window.kite.stop());
    await expect
      .poll(async () => (await page.evaluate(() => window.kite.state())).active)
      .toBeNull();
  } else
    expect(started).toEqual({
      status: "rejected",
      message: ACCESSIBILITY_REFUSAL,
    });
  expect(await appState()).toMatchObject(setupComplete);
  covered("replay refused while a recording is starting");

  // Closes the setup window a replay opened, which skips setup and brings the companion back.
  const skipReopenedSetup = () =>
    expectChange(
      appState,
      { windows: { setup: true, buddy: false }, onboardingComplete: false },
      () => onWindow(app, "setup", "close"),
      { windows: { setup: "closed", buddy: true }, onboardingComplete: true },
    );
  const [replayed, startWhileReplaying] = await settle(page, [
    ["replayOnboarding", []],
    ["start", ["Smoke"]],
  ]);
  expect(replayed).toEqual({ status: "fulfilled" });
  expect(startWhileReplaying).toEqual({
    status: "rejected",
    message: "Finish setup before starting a recording.",
  });
  await expect.poll(appState).toMatchObject({
    windows: { setup: true, buddy: false },
    onboardingComplete: false,
    active: null,
  });
  await skipReopenedSetup();
  expect(await appState()).toMatchObject(setupComplete);
  covered("recording refused while setup is reopening");

  const [replayedFromCompanion, trayWhileReplaying] = await settle(buddy, [
    ["replayOnboarding", []],
    ["openCompanionTray", ["chat"]],
  ]);
  expect(replayedFromCompanion).toEqual({ status: "fulfilled" });
  expect(trayWhileReplaying).toEqual({
    status: "rejected",
    message: "Finish setup to use the companion.",
  });
  await expect.poll(appState).toMatchObject({
    windows: { setup: true, buddy: false, chat: false },
    onboardingComplete: false,
  });
  await skipReopenedSetup();
  expect(await appState()).toMatchObject(setupComplete);
  covered("companion tray refused while setup is reopening");

  await buddy
    .getByRole("button", { name: /Chat with OpenMuse or drag/ })
    .hover();
  await expect
    .poll(() =>
      buddy
        .locator(".sprite-capybara img")
        .evaluate((element) => getComputedStyle(element).animationName),
    )
    .toBe("capybara-greet");
  await buddy.emulateMedia({ reducedMotion: "reduce" });
  await expect
    .poll(() =>
      buddy
        .locator(".sprite-capybara img")
        .evaluate((element) => getComputedStyle(element).animationName),
    )
    .toBe("none");
  await buddy.emulateMedia({ reducedMotion: "no-preference" });
  await expect(
    buddy.getByRole("button", { name: "Chat with OpenMuse", exact: true }),
  ).toBeVisible();
  await expect(
    buddy.getByRole("button", { name: "Record a workflow", exact: true }),
  ).toBeVisible();
  await buddy.screenshot({ path: "artifacts/pet-hover.png" });
  covered("companion hover greets and respects reduced motion");

  const askOpenMuse = chat.getByRole("textbox", { name: "Ask OpenMuse" });
  await expectChange(
    () => visibility(app),
    { chat: false },
    () =>
      buddy.getByRole("button", { name: /Chat with OpenMuse or drag/ }).click(),
    { chat: true },
  );
  await expect(askOpenMuse).toBeVisible();
  await chat.screenshot({ path: "artifacts/pet-chat.png" });
  await askOpenMuse.fill("Remember this draft");
  await expectChange(
    () => visibility(app),
    { chat: true },
    () => chat.getByRole("button", { name: "Close chat" }).click(),
    { chat: false },
  );
  covered("companion chat opens and closes");

  await expectChange(
    () => visibility(app),
    { chat: false },
    () =>
      buddy
        .getByRole("button", { name: "Record a workflow", exact: true })
        .click(),
    { chat: true },
  );
  await expect(
    chat.getByRole("textbox", { name: "What should I learn?" }),
  ).toBeVisible();
  await chat
    .getByRole("textbox", { name: "What should I learn?" })
    .fill("Organize a file");
  await chat.getByRole("button", { name: "Start recording" }).click();
  // Any error the chat shows is an outcome of its own, so an unexpected one fails with its text.
  const recordingOutcome = async () => {
    if (await chat.getByText("Recording now").isVisible()) return "started";
    const errors = await chat.locator(".inline-error").allTextContents();
    return errors.length ? `error: ${errors.join(" | ")}` : "pending";
  };
  await expect.poll(recordingOutcome, { timeout: 15000 }).not.toBe("pending");
  // Recording needs Accessibility, so the outcome must match what this Mac has granted.
  const outcome = await recordingOutcome();
  const expectedOutcome = granted.accessibility
    ? "started"
    : `error: ${ACCESSIBILITY_REFUSAL}`;
  if (outcome !== expectedOutcome)
    throw new Error(
      `Start recording ended with ${JSON.stringify(outcome)}, not ${JSON.stringify(expectedOutcome)}, while Accessibility is ${granted.accessibility ? "granted" : "not granted"} on this Mac`,
    );
  if (outcome === "started") {
    // Setup hides the companion, which carries the always-visible recording indicator and its Stop
    // button, so replaying setup mid-recording must be refused, in Settings and over IPC.
    await expect(replaySetup).toBeDisabled();
    await expectRefusal(
      page,
      "replayOnboarding",
      [],
      "Stop the recording before replaying setup.",
    );
    expect(await appState()).toMatchObject({
      windows: { setup: "closed", buddy: true },
      onboardingComplete: true,
      preferences: { onboardingComplete: true },
    });
    await expectChange(
      async () => ({ recording: (await appState()).active !== null }),
      { recording: true },
      () => chat.getByRole("button", { name: "Stop recording" }).click(),
      { recording: false },
    );
  } else {
    await expect(chat.locator(".inline-error")).toHaveText([
      ACCESSIBILITY_REFUSAL,
    ]);
    await expect(chat.locator(".inline-error")).toBeVisible();
    expect(await appState()).toMatchObject({ active: null });
  }
  const withoutAccessibility =
    "needs Accessibility, which this Mac has not granted";
  if (outcome === "started") {
    skipped(
      "chat asks for Accessibility before recording",
      "Accessibility is granted on this Mac",
    );
    covered("chat records and stops a workflow");
    covered("replay refused while a recording is active");
  } else {
    covered("chat asks for Accessibility before recording");
    skipped("chat records and stops a workflow", withoutAccessibility);
    skipped("replay refused while a recording is active", withoutAccessibility);
  }

  await chat.getByRole("button", { name: "Close chat" }).click();
  await buddy
    .getByRole("button", { name: /Chat with OpenMuse or drag/ })
    .click();
  await expect(askOpenMuse).toHaveValue("Remember this draft");
  const keyPrompt = chat.getByText(
    "Connect your OpenAI API key in Settings to start this session.",
  );
  const composer = async () => ({
    draft: await askOpenMuse.inputValue(),
    keyPrompt: await keyPrompt.count(),
  });
  await expectChange(
    composer,
    { keyPrompt: 0 },
    () => chat.getByRole("button", { name: "Send" }).click(),
    { keyPrompt: 1 },
  );
  await expectChange(
    composer,
    { draft: "Remember this draft", keyPrompt: 1 },
    () => chat.getByRole("button", { name: "New conversation" }).click(),
    { draft: "", keyPrompt: 0 },
  );
  covered("chat keeps its draft and asks for an API key");
  // The workspace is hidden first, so the check fails if the button only hides the chat.
  await onWindow(app, "workspace", "hide");
  await expectChange(
    () => visibility(app),
    { chat: true, workspace: false },
    () => chat.getByRole("button", { name: "Workspace" }).click(),
    { chat: false, workspace: true },
  );
  covered("chat Workspace button hides the chat");

  await page.getByRole("button", { name: "Learning", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Practice makes progress." }),
  ).toBeVisible();
  if (process.argv.includes("--cloud")) {
    await page
      .getByRole("button", { name: "Verify connection", exact: true })
      .click();
    await expect(page.getByText(/Verified · revision/)).toBeVisible({
      timeout: 20000,
    });
    await page.screenshot({ path: "artifacts/kite-learning.png" });
    skipped(
      "Learning shows Intelligence as not configured",
      "--cloud configures it",
    );
    covered("Learning verifies the Intelligence connection");
  } else {
    await expect(page.getByText("Not configured", { exact: true })).toHaveCount(
      2,
    );
    covered("Learning shows Intelligence as not configured");
    skipped(
      "Learning verifies the Intelligence connection",
      "only runs with --cloud",
    );
  }

  await page.getByRole("button", { name: "Overview", exact: true }).click();
  const recordDialog = async () => ({
    open: await page
      .getByRole("heading", { name: "Show OpenMuse your way." })
      .count(),
  });
  await expectChange(
    recordDialog,
    { open: 0 },
    () =>
      page
        .getByRole("button", { name: "Record a workflow", exact: true })
        .click(),
    { open: 1 },
  );
  await expectChange(
    recordDialog,
    { open: 1 },
    () => page.getByRole("button", { name: "Close", exact: true }).click(),
    { open: 0 },
  );
  covered("workspace opens the recording dialog");

  const recordToSkill = "record, note, stop, draft, approve and export";
  if (!process.argv.includes("--record"))
    skipped(recordToSkill, "only runs with --record");
  // Start recording stays disabled without Accessibility, so there is nothing to click.
  else if (!granted.accessibility) skipped(recordToSkill, withoutAccessibility);
  else {
    await page.bringToFront();
    await page
      .getByRole("button", { name: "Record a workflow", exact: true })
      .click();
    await page
      .getByPlaceholder("e.g. Prepare my weekly report")
      .fill("Kite verification workflow");
    await page
      .getByRole("button", { name: "Start recording", exact: true })
      .click();
    await page
      .getByLabel("Add a recording note")
      .fill("Verify the output before finishing.");
    await page.getByRole("button", { name: "Add note", exact: true }).click();
    await page
      .getByRole("button", { name: "Stop & review", exact: true })
      .click();
    await expect(
      page.getByText("Verify the output before finishing.", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Manual draft", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Approve skill", exact: true })
      .click();
    await expect(page.getByText("Approved", { exact: true })).toBeVisible();
    const persisted = await page.evaluate(() => window.kite.state());
    if (
      persisted.active !== null ||
      persisted.skills.length !== 1 ||
      !persisted.skills[0].approvedAt
    )
      throw new Error("Recording-to-approved-skill persistence failed");
    const exported = join(dataDir, "SKILL.md");
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    }, exported);
    await page.getByTitle("Export SKILL.md").click();
    await expect
      .poll(async () => readFile(exported, "utf8").catch(() => ""))
      .toContain("Verify the output");
    console.log(
      "Record → note → stop → manual draft → approve → export passed.",
    );
    covered(recordToSkill);
  }
}

// Quitting mid-setup is not a skip. A new install saves its defaults at startup, so the relaunch
// finds setup unfinished instead of taking the library the first launch created for a returning install.
async function relaunchMidSetup({ dir, launchApp }) {
  const first = await launchApp();
  await waitForWindow(first, "setup");
  await expect
    .poll(() => visibility(first), { timeout: 30000 })
    .toMatchObject({ setup: true });
  // closeApp fails the check with its timeout message if the first launch never exits.
  await closeApp(first);
  // The quit must leave setup unfinished on disk. A setup close handler that treats the quit as a
  // skip saves it as finished, and the app still exits once that skip destroys its last window.
  const unfinishedSetup = { companion: "capybara", onboardingComplete: false };
  expect(await readPreferences(dir)).toEqual(unfinishedSetup);
  const second = await launchApp();
  await expect
    .poll(() => visibility(second), { timeout: 30000 })
    .toMatchObject({ setup: true, buddy: false, workspace: false });
  const setup = await waitForWindow(second, "setup");
  await expect(
    setup.getByRole("heading", { name: "Meet your new work buddy." }),
  ).toBeVisible();
  expect(await readPreferences(dir)).toEqual(unfinishedSetup);
  covered("relaunch mid-setup shows setup again");
}

// A legacy install with a preferences file (even one naming the removed notch placement) must skip setup.
async function legacyLaunch({ dir, launchApp }) {
  await writeFile(
    join(dir, "preferences.json"),
    JSON.stringify({ companion: "kite", placement: "notch" }),
  );
  const legacyApp = await launchApp();
  await expect
    .poll(() => visibility(legacyApp), { timeout: 30000 })
    .toEqual({ workspace: false, buddy: true, chat: false });
  const legacyPage = await waitForWindow(legacyApp, "buddy");
  const legacySettings = (await legacyPage.evaluate(() => window.kite.state()))
    .settings;
  if ("placement" in legacySettings)
    throw new Error("placement should not leak into settings");
  if (
    legacySettings.companion !== "kite" ||
    legacySettings.onboardingComplete !== true
  )
    throw new Error(
      `Unexpected legacy settings: ${JSON.stringify(legacySettings)}`,
    );
  covered("legacy preferences file skips setup");
}

// A returning install (an existing library, no preferences file) must skip setup without writing one.
async function returningLaunch({ dir, launchApp }) {
  await mkdir(join(dir, "library"), { recursive: true });
  const returningApp = await launchApp();
  await expect
    .poll(() => visibility(returningApp), { timeout: 30000 })
    .toEqual({ workspace: false, buddy: true, chat: false });
  const returningPage = await waitForWindow(returningApp, "buddy");
  const returningSettings = (
    await returningPage.evaluate(() => window.kite.state())
  ).settings;
  if (returningSettings.onboardingComplete !== true)
    throw new Error(
      `Expected onboardingComplete true, got ${JSON.stringify(returningSettings)}`,
    );
  const preferencesWritten = await stat(join(dir, "preferences.json")).then(
    () => true,
    () => false,
  );
  if (preferencesWritten)
    throw new Error(
      "preferences.json should not be written for an unmodified returning install",
    );
  covered("returning install without preferences skips setup");
}

await withDataDir("kite-smoke-", firstLaunch);
await withDataDir("kite-smoke-midsetup-", relaunchMidSetup);
await withDataDir("kite-smoke-legacy-", legacyLaunch);
await withDataDir("kite-smoke-returning-", returningLaunch);

for (const { name, reason } of ledger)
  console.log(
    reason === undefined ? `✓ ${name}` : `– ${name} (skipped: ${reason})`,
  );
const skippedCount = ledger.filter(({ reason }) => reason !== undefined).length;
console.log(
  `Desktop smoke passed: ${ledger.length - skippedCount} checks covered, ${skippedCount} skipped.`,
);
