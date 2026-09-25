# Clean Onboarding Implementation Plan

**Status:** Executed on `jerel/clean-onboarding`. Where the shipped code differs from the blocks below, see Review amendments.

> **Historical record.** This plan has been executed and must not be run again. The shipped code differs where Review amendments say so.

**Goal:** Remove the notch tour and the notch placement, and replace them with a three-screen setup window shown on first launch.

**Architecture:** Task 1 deletes every notch path (window, geometry, native inset command, placement preference, IPC, styles) and migrates stored preferences that still name a placement. Task 2 adds an on-demand Electron setup window that loads the renderer with `?onboarding=1`, a new `Onboarding` React component (Welcome → Permissions → Ready), one validated IPC to open a System Settings pane, and flips the missing-preferences default so new installs see setup.

**Tech Stack:** Electron 44, React 19, TypeScript, zod 4, lucide-react, `tsx --test` unit tests, Playwright Electron smoke (`scripts/smoke.mjs`), Swift helper (`native/Recorder.swift`).

**Spec:** `docs/superpowers/specs/2026-09-24-clean-onboarding-design.md`

## Global Constraints

- Work only in the `jerel/clean-onboarding` worktree. Never `cd` to the main checkout. Never use bare `git stash`.
- Never add co-author or attribution trailers to commits.
- Keep `com.kite.sprite`, `Application Support/Kite`, the `kite:` IPC namespace and environment variable names unchanged.
- IPC stays validated: every renderer-supplied value is parsed with zod in the main process, and URLs opened by the main process are constants chosen in the main process.
- Match existing style: 2-space indent, double quotes, Prettier formatting (`npx prettier --write <files>`), no comments beyond the density already in each file.
- Copy uses typographic apostrophes (`’`) like the rest of the UI.
- Full check suite for each task, run from the worktree root in this order: `npx prettier --write <changed files>`, `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build:native`, `npm run build`, `npm run smoke`. The smoke test opens real windows on the Mac for about a minute; that is expected. Do not click **Allow** in real macOS permission prompts and do not change System Settings.

---

### Task 1: Remove the notch placement and notch tour, migrate stored preferences

After this task the floating companion (Capybara or Kite) is the only placement and only the legacy-migration references to the notch remain. Onboarding has no UI until Task 2: `completeOnboarding`/`replayOnboarding` still persist the flag, and the companion is shown regardless of it.

**Files:**

- Modify: `electron/preferences.ts`
- Test: `tests/preferences.test.ts`
- Modify: `src/types.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/main.ts`
- Modify: `server/runtime.ts` (the `settings` object near line 141)
- Modify: `src/App.tsx`
- Modify: `src/styles.css`
- Modify: `native/Recorder.swift`
- Modify: `scripts/smoke.mjs`
- Modify: `README.md`
- Delete: `src/Notch.tsx`, `electron/notch-geometry.ts`, `tests/notch-geometry.test.ts`

**Interfaces:**

- Consumes: nothing from other tasks.
- Produces (Task 2 relies on these exact names):
  - `electron/preferences.ts`: `export type Preferences = { companion: Companion; onboardingComplete: boolean }`, `loadPreferences(path): Promise<Preferences>`, `savePreferences(path, input): Promise<Preferences>`, `companionSchema`. No `placementSchema` export.
  - `src/types.ts`: `Settings` without `placement`; no `Placement` type; `KiteAPI` without `setPlacement`, `startAppDrag`, `openAccessibilitySettings`, `closeAccessibilityGuide`, `revealAppInFinder`, `setNotchExpanded`. `completeOnboarding()` and `replayOnboarding()` remain.
  - `electron/main.ts`: module-level `function syncCompanionWindows()` (called from the buddy's `ready-to-show`, from `updatePreferences`, and from the tray's **Show companion**); the `handle(name, fn)` trusted-IPC helper whose sender allowlist is `[workspace, buddy, companionChat]`; `updatePreferences(change: Partial<Preferences>)` inside the `whenReady` callback.

- [x] **Step 1: Replace the preference tests with the post-notch expectations**

Replace the whole of `tests/preferences.test.ts` with:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadCompanion,
  loadPreferences,
  saveCompanion,
  savePreferences,
} from "../electron/preferences";

test("companion defaults to capybara and persists both choices privately", async () => {
  const directory = await mkdtemp(join(tmpdir(), "companion-"));
  try {
    const path = join(directory, "preferences.json");
    assert.equal(await loadCompanion(path), "capybara");
    await saveCompanion(path, "kite");
    assert.equal(await loadCompanion(path), "kite");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(saveCompanion(path, "other"));
    assert.equal(await loadCompanion(path), "kite");
    await saveCompanion(path, "capybara");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      companion: "capybara",
      onboardingComplete: true,
    });
    await writeFile(path, '{"companion":"invalid"}');
    await assert.rejects(loadCompanion(path));
    await writeFile(path, "broken json");
    await assert.rejects(loadCompanion(path));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("legacy preferences load without the removed notch placement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preferences-"));
  try {
    const path = join(directory, "preferences.json");
    assert.deepEqual(await loadPreferences(path), {
      companion: "capybara",
      onboardingComplete: true,
    });
    await writeFile(path, '{"companion":"kite"}');
    assert.deepEqual(await loadPreferences(path), {
      companion: "kite",
      onboardingComplete: true,
    });
    for (const placement of ["notch", "floating"]) {
      await writeFile(
        path,
        JSON.stringify({
          companion: "kite",
          placement,
          onboardingComplete: false,
        }),
      );
      assert.deepEqual(await loadPreferences(path), {
        companion: "kite",
        onboardingComplete: false,
      });
    }
    await saveCompanion(path, "capybara");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      companion: "capybara",
      onboardingComplete: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preferences persist all fields atomically and privately", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preferences-"));
  try {
    const path = join(directory, "preferences.json");
    const preferences = {
      companion: "kite" as const,
      onboardingComplete: true,
    };
    assert.deepEqual(await savePreferences(path, preferences), preferences);
    assert.deepEqual(await loadPreferences(path), preferences);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await saveCompanion(path, "capybara");
    assert.deepEqual(await loadPreferences(path), {
      ...preferences,
      companion: "capybara",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed present preference fields fail rather than resetting onboarding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preferences-"));
  try {
    const path = join(directory, "preferences.json");
    for (const contents of [
      '{"companion":"kite","placement":"invalid"}',
      '{"companion":"kite","onboardingComplete":"true"}',
      '{"companion":"kite","unknown":true}',
      '{"companion":"invalid"}',
    ]) {
      await writeFile(path, contents);
      await assert.rejects(loadPreferences(path));
    }
    await assert.rejects(
      savePreferences(path, {
        companion: "kite",
        placement: "floating",
        onboardingComplete: true,
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
```

- [x] **Step 2: Run the tests to confirm they fail**

Run: `npx tsx --test tests/preferences.test.ts`
Expected: FAIL. The deep-equal assertions report an extra `placement: "floating"` key, and saving with `placement` resolves instead of rejecting.

- [x] **Step 3: Drop `placement` from the preferences module**

In `electron/preferences.ts`, replace everything from the `import type` line through the `defaultPreferences` constant with:

```ts
import type { Companion } from "../src/types";

export const companionSchema = z.enum(["capybara", "kite"]);
export type Preferences = {
  companion: Companion;
  onboardingComplete: boolean;
};
const preferencesSchema = z.strictObject({
  companion: companionSchema,
  onboardingComplete: z.boolean(),
});
// Files written before the notch placement was removed may still name it.
const storedPreferencesSchema = z
  .strictObject({
    companion: companionSchema,
    onboardingComplete: z.boolean().default(true),
    placement: z.enum(["notch", "floating"]).optional(),
  })
  .transform(({ companion, onboardingComplete }): Preferences => ({
    companion,
    onboardingComplete,
  }));
const defaultPreferences: Preferences = {
  companion: "capybara",
  onboardingComplete: true,
};
```

Leave `loadPreferences`, `savePreferences`, `loadCompanion` and `saveCompanion` unchanged.

- [x] **Step 4: Run the tests to confirm they pass**

Run: `npx tsx --test tests/preferences.test.ts`
Expected: PASS, 4 tests.

- [x] **Step 5: Remove notch types and preload entries**

In `src/types.ts`:

- Delete the line `export type Placement = "notch" | "floating";`.
- In `Settings`, delete `placement: Placement;`.
- In `KiteAPI`, delete these six members: `setPlacement(placement: Placement): Promise<void>;`, `startAppDrag(): void;`, `openAccessibilitySettings(): Promise<void>;`, `closeAccessibilityGuide(): Promise<void>;`, `revealAppInFinder(): Promise<void>;`, `setNotchExpanded(expanded: boolean): Promise<void>;`.

In `electron/preload.ts`, delete the matching entries: `setPlacement`, `startAppDrag`, `openAccessibilitySettings`, `closeAccessibilityGuide`, `revealAppInFinder`, `setNotchExpanded` (each is a two- or one-line property). Keep `completeOnboarding` and `replayOnboarding`.

In `server/runtime.ts`, delete the line `placement: "floating" as "notch" | "floating",` from the `settings` object. Keep `onboardingComplete: true,`.

- [x] **Step 6: Remove the notch window and its state from the main process**

Make these exact edits in `electron/main.ts`:

1. Imports. Change `import { join, dirname, resolve } from "node:path";` to `import { join, dirname } from "node:path";`. In the `./preferences` import, delete `placementSchema,`. Delete the line `import { notchPosition } from "./notch-geometry";`.

2. Module state. Delete these lines: `let notch: BrowserWindow;`, `let notchExpanded = false;`, `let accessibilityGuideActive = false;`, `let notchTopInset = 0;`, `let appDragIcon: Electron.NativeImage;`, and `const appBundlePath = () => resolve(app.getPath("exe"), "../../..");`.

3. Delete the four functions `notchSize`, `fittedNotchBounds`, `positionNotch` and `refreshNotchInset` entirely.

4. Replace the whole `syncCompanionWindows` function with:

```ts
function syncCompanionWindows() {
  if (!buddy || !settings) return;
  buddy.showInactive();
}
```

5. In `openCompanionTray`, delete its first two lines (the `if (settings.placement !== "floating" || !settings.onboardingComplete)` guard and its `throw`). The buddy is the only caller and its sender is already verified.

6. In `makeWindow`, change the `ready-to-show` handler body from

```ts
if (isBuddy) syncCompanionWindows();
else if (settings.placement !== "floating" || !settings.onboardingComplete)
  win.show();
```

to

```ts
if (isBuddy) syncCompanionWindows();
else if (!settings.onboardingComplete) win.show();
```

7. Delete the whole `makeNotchWindow` function.

8. In `handle`, delete `notch?.webContents,` from the sender allowlist so it reads `[workspace?.webContents, buddy?.webContents, companionChat?.webContents]`.

9. In the `whenReady` callback, replace the preferences block from `settings.companion = savedPreferences.companion;` through the end of `updatePreferences` with:

```ts
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
    syncCompanionWindows();
    broadcast();
  });
  // Return the failed write to this caller while keeping later saves retryable.
  preferenceQueue = update.catch(() => {});
  return update;
}
```

10. Delete these handlers entirely: `handle("setPlacement", ...)`, `handle("revealAppInFinder", ...)`, `ipcMain.handle("kite:openAccessibilitySettings", ...)`, `ipcMain.handle("kite:closeAccessibilityGuide", ...)`, `handle("setNotchExpanded", ...)`, `ipcMain.on("kite:startAppDrag", ...)`. Keep `setCompanion`, `completeOnboarding`, `replayOnboarding`.

11. In the `screenshot` handler, delete `const restoreNotch = notch.isVisible();`, `notch.hide();` and `if (restoreNotch) notch.showInactive();`.

12. Delete `await refreshNotchInset();` and the `bundledIcon`/`appDragIcon` block that follows it (the `nativeImage.createFromPath(...)` statement and the `appDragIcon = ...` assignment). `nativeImage` stays imported for the tray icon.

13. Delete `notch = makeNotchWindow();`.

14. Replace the `reflowDisplays` function and its three `screen.on(...)` registrations with:

```ts
screen.on("display-removed", restoreVisibleBuddy);
screen.on("display-added", restoreVisibleBuddy);
screen.on("display-metrics-changed", restoreVisibleBuddy);
```

After these edits, `grep -n -i "notch\|placement\|appDrag\|accessibilityGuide\|appBundlePath" electron/main.ts` must print nothing.

- [x] **Step 7: Remove the notch from the renderer, styles and native helper**

Delete the files: `git rm src/Notch.tsx electron/notch-geometry.ts tests/notch-geometry.test.ts`.

In `src/App.tsx`:

- Delete `import { Notch } from "./Notch";` and the line `const isNotch = new URLSearchParams(location.search).get("notch") === "1";`.
- Change `<div className={isNotch ? "loading notch-loading" : "loading"}>` to `<div className="loading">`.
- Delete `if (isNotch) return <Notch data={data} refresh={refresh} />;`.
- In the Settings tab, replace the whole first `settings-card` (the one whose heading is `Desktop companion`) with:

```tsx
<div className="settings-card">
  <h2>Desktop companion</h2>
  <p>Choose a little companion for your desktop.</p>
  <div className="companion-options" aria-label="Desktop companion">
    {(["capybara", "kite"] as const).map((companion) => (
      <button
        key={companion}
        className="companion-option"
        aria-pressed={data.settings.companion === companion}
        disabled={working}
        onClick={() => void perform(() => window.kite!.setCompanion(companion))}
      >
        <span className="companion-preview" aria-hidden="true">
          <Sprite companion={companion} small />
        </span>
        <span>{companion === "capybara" ? "Capybara" : "Kite"}</span>
        {data.settings.companion === companion && (
          <Check size={14} aria-hidden="true" />
        )}
      </button>
    ))}
  </div>
  <button
    className="text-button setup-replay"
    disabled={working}
    onClick={() => void perform(() => window.kite!.replayOnboarding())}
  >
    Replay setup <ArrowRight size={14} />
  </button>
</div>
```

- Remove any lucide import that is now unused (run `npm run lint`; `Monitor` and `MousePointer2` are still used by the permission rows).

In `src/styles.css`, delete everything from the line `.placement-options {` to the end of the file (the placement rules, the notch comment, every `.notch*` rule and the final notch reduced-motion block). Then append:

```css
.setup-replay {
  margin-top: 14px;
}
```

In `native/Recorder.swift`, delete the `--notch-inset` case (four lines, starting with `case "--notch-inset":` and ending with its `exit(EXIT_SUCCESS)`).

- [x] **Step 8: Update the smoke test for the notch-free app**

In `scripts/smoke.mjs`:

1. Replace the comment and `writeFile(...)` call at the top (currently writing `placement: "notch"` and `onboardingComplete: false`) with:

```js
// A preferences file written before the notch placement was removed must still load.
await writeFile(
  join(dataDir, "preferences.json"),
  JSON.stringify({
    companion: "capybara",
    placement: "notch",
    onboardingComplete: true,
  }),
);
```

2. In both window filters for the workspace `page` (the `expect.poll` and the `.find`), delete the `!p.url().includes("notch=1") &&` condition.

3. Delete everything from `await expect.poll(() => app.windows().some((p) => p.url().includes("notch=1")), {` through `await expect(notch.locator(".notch-home-panel")).toHaveCount(0);` (the whole notch tour, drag guide and replay section, including the `--packaged` drag check).

4. The workspace is hidden at launch when setup is complete, so open it before the workspace assertions. Replace

```js
await page.waitForSelector(".app-shell", { timeout: 30000 });
```

with

```js
await page.waitForSelector(".app-shell", { timeout: 30000 });
await page.evaluate(() => window.kite.openWorkspace());
```

5. Replace the block that starts with `await page.getByRole("button", { name: /Floating companion/ }).click();` and ends with the `.toBe(false);` of the notch-visibility poll with:

```js
await expect(
  page.getByRole("button", { name: /By the notch|Floating companion/ }),
).toHaveCount(0);
const reported = (await page.evaluate(() => window.kite.state())).settings;
if ("placement" in reported)
  throw new Error("Removed placement is still reported");
await page.getByRole("button", { name: "Kite", exact: true }).click();
await page.getByRole("button", { name: "Capybara", exact: true }).click();
await expect
  .poll(async () =>
    JSON.parse(await readFile(join(dataDir, "preferences.json"), "utf8")),
  )
  .toEqual({ companion: "capybara", onboardingComplete: true });
```

6. Change the final success message to:

```js
    "Desktop smoke passed: legacy preferences, pet hover/reduced motion, chat persistence, recording flow, workspace, permissions, learning setup.",
```

- [x] **Step 9: Remove notch mentions from the README**

In `README.md`:

- In the paragraph starting "A macOS desktop companion powered by the official Codex SDK", change "Electron hosts the floating sprite, compact chat, optional notch companion, and workspace" to "Electron hosts the floating sprite, compact chat, and workspace".
- Replace the paragraph starting "On first launch, OpenMuse shows the floating capybara." with: "On first launch, OpenMuse shows the floating capybara. Grant Accessibility when you want to record workflows across apps; Screen Recording is optional and used only for screenshots you explicitly attach. Both can be enabled from **Settings → macOS permissions**. If OpenMuse is already listed but recording still fails, toggle its permission off and on and restart rather than adding a duplicate."
- In the paragraph starting "Drag the sprite to move it", delete the last two sentences ("Use **Settings → Desktop companion → Notch** if you prefer the notch placement. The capybara and Kite artwork choices work in either placement.").

- [x] **Step 10: Run the full check suite**

Run, from the worktree root, in order: `npx prettier --write electron src server tests scripts README.md`, `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build:native`, `npm run build`, `npm run smoke`.
Expected: every command succeeds; `npm test` reports 32 passing tests (36 before, minus the 4 deleted notch-geometry tests; the preference file still has 4 tests); the smoke prints the new success message. `grep -rn -i "notch" electron src server native scripts tests` still finds the legacy-migration comment, enum, test name and smoke assertion this same task adds — see Review amendments for why they stay.

- [x] **Step 11: Commit**

```bash
git add -A electron src server native scripts tests README.md
git commit -m "refactor: remove notch placement and notch setup tour"
```

---

### Task 2: Add the three-screen setup window

**Files:**

- Modify: `electron/preferences.ts`
- Test: `tests/preferences.test.ts`
- Modify: `src/types.ts`
- Modify: `electron/preload.ts`
- Modify: `electron/main.ts`
- Create: `src/Onboarding.tsx`
- Modify: `src/App.tsx`
- Modify: `src/styles.css`
- Modify: `scripts/smoke.mjs`
- Modify: `README.md`

**Interfaces:**

- Consumes (from Task 1): `Preferences = { companion; onboardingComplete }`; `syncCompanionWindows()`; `handle(name, fn)` with allowlist `[workspace, buddy, companionChat]`; `updatePreferences(change)`; `KiteAPI.completeOnboarding()`, `replayOnboarding()`, `permissions(kind)`, `state()`, `openWorkspace()`; `Sprite({ companion, small })` from `src/Sprite.tsx`.
- Produces:
  - `src/types.ts`: `export type PermissionKind = keyof Permissions;` and `KiteAPI.openPermissionSettings(kind: PermissionKind): Promise<void>`; `permissions(kind: PermissionKind): Promise<Permissions>`.
  - IPC channel `kite:openPermissionSettings`.
  - Renderer route `?onboarding=1` rendering `export function Onboarding({ data }: { data: Snapshot })` from `src/Onboarding.tsx`.
  - CSS classes `.onboarding`, `.onboarding-titlebar`, `.onboarding-dots`, `.onboarding-screen`, `.onboarding-art`, `.onboarding-check`, `.onboarding-actions`, `.onboarding-permissions`, `.onboarding-permission`, `.onboarding-permission-icon`, `.onboarding-granted`, `.onboarding-waiting`, `.onboarding-note`, `.onboarding-error`.

- [x] **Step 1: Write the failing test for the new-install default**

In `tests/preferences.test.ts`:

- In the first test, change the expected file contents after `await saveCompanion(path, "capybara");` to `{ companion: "capybara", onboardingComplete: false }`.
- Rename the second test to `"new installs start setup; legacy preferences load without the removed notch placement"` and change its first assertion (the missing file) to expect `{ companion: "capybara", onboardingComplete: false }`. The rest of that test is unchanged: a file without `onboardingComplete` still loads as `true`.

- [x] **Step 2: Run the test to confirm it fails**

Run: `npx tsx --test tests/preferences.test.ts`
Expected: FAIL, the missing-file assertions report `onboardingComplete: true` instead of `false`.

- [x] **Step 3: New installs start with setup**

In `electron/preferences.ts`, change `defaultPreferences` to:

```ts
// A new install starts with setup; stored files without the field predate it.
const defaultPreferences: Preferences = {
  companion: "capybara",
  onboardingComplete: false,
};
```

- [x] **Step 4: Run the test to confirm it passes**

Run: `npx tsx --test tests/preferences.test.ts`
Expected: PASS, 4 tests.

- [x] **Step 5: Add the permission-settings IPC contract**

In `src/types.ts`, directly below `export type Permissions = ...`, add:

```ts
export type PermissionKind = keyof Permissions;
```

In `KiteAPI`, change `permissions(kind: "accessibility" | "screenCapture"): Promise<Permissions>;` to `permissions(kind: PermissionKind): Promise<Permissions>;` and add below it:

```ts
  openPermissionSettings(kind: PermissionKind): Promise<void>;
```

In `electron/preload.ts`, below the `permissions:` entry, add:

```ts
  openPermissionSettings: (kind) =>
    ipcRenderer.invoke("kite:openPermissionSettings", kind),
```

- [x] **Step 6: Add the setup window to the main process**

Make these exact edits in `electron/main.ts`:

1. Below `let companionChat: BrowserWindow;`, add:

```ts
let onboarding: BrowserWindow | undefined;
// Assigned once preferences load; closing the setup window skips setup.
let skipOnboarding: (() => Promise<void>) | undefined;
```

2. Directly above `async function permissions(): Promise<Permissions> {`, add:

```ts
const permissionKindSchema = z.enum(["accessibility", "screenCapture"]);
const permissionPanes = {
  accessibility:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  screenCapture:
    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
} as const;
```

3. Replace the whole `syncCompanionWindows` function with:

```ts
function syncCompanionWindows() {
  if (!buddy || !settings) return;
  if (!settings.onboardingComplete) {
    buddy.hide();
    companionChat?.hide();
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
```

4. In `makeWindow`, change the `ready-to-show` handler body to only:

```ts
if (isBuddy) syncCompanionWindows();
```

The workspace no longer opens at launch; it opens from the tray, the shortcut, the companion tray or the setup window. Activating the app from the Dock opens the workspace only once setup is complete; while setup is incomplete, the Dock focuses the setup window instead.

5. Directly below the `makeCompanionChatWindow` function, add:

```ts
function makeOnboardingWindow() {
  const win = new BrowserWindow({
    width: 520,
    height: 600,
    show: false,
    center: true,
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
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  const loaded = process.env.KITE_DEV_URL
    ? win.loadURL(process.env.KITE_DEV_URL + "?onboarding=1")
    : win.loadFile(join(root, "dist/renderer/index.html"), {
        query: { onboarding: "1" },
      });
  void loaded.catch((error: unknown) =>
    dialog.showErrorBox(
      "OpenMuse setup could not load",
      error instanceof Error ? error.message : "Unknown loading error",
    ),
  );
  win.once("ready-to-show", () => {
    win.show();
    win.focus();
  });
  win.on("close", (event) => {
    if ((app as typeof app & { quitting?: boolean }).quitting) return;
    // Closing skips setup; it never marks a permission as granted.
    event.preventDefault();
    if (!skipOnboarding) return;
    void skipOnboarding().catch((error: unknown) =>
      dialog.showErrorBox(
        "Could not skip setup",
        error instanceof Error ? error.message : "Unknown error",
      ),
    );
  });
  return win;
}
```

6. In `handle`, add `onboarding?.webContents,` to the sender allowlist so it reads `[workspace?.webContents, buddy?.webContents, onboarding?.webContents, companionChat?.webContents]`.

7. In the `whenReady` callback, directly after the `updatePreferences` function, add:

```ts
skipOnboarding = () => updatePreferences({ onboardingComplete: true });
```

8. Directly after `handle("replayOnboarding", ...)`, add:

```ts
handle("openPermissionSettings", (kind) =>
  shell.openExternal(permissionPanes[permissionKindSchema.parse(kind)]),
);
```

9. In the existing `handle("permissions", async (kind) => { ... })`, replace `z.enum(["accessibility", "screenCapture"]).parse(kind);` with `permissionKindSchema.parse(kind);`.

10. Replace `app.on("activate", openWorkspace);` with:

```ts
app.on("activate", () => {
  if (settings.onboardingComplete) openWorkspace();
  else syncCompanionWindows();
});
```

- [x] **Step 7: Create the onboarding screens**

Create `src/Onboarding.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowRight,
  Check,
  LoaderCircle,
  Monitor,
  MousePointer2,
} from "lucide-react";
import { Sprite } from "./Sprite";
import type { PermissionKind, Permissions, Snapshot } from "./types";

type Step = "welcome" | "permissions" | "ready";
const steps: Step[] = ["welcome", "permissions", "ready"];
const rows = [
  {
    kind: "accessibility",
    title: "Accessibility",
    detail: "Follow along while you record a workflow.",
    hint: "Already on? Turn it off and on again.",
    icon: MousePointer2,
  },
  {
    kind: "screenCapture",
    title: "Screen Recording",
    detail: "Attach a screenshot to a message when you choose.",
    hint: "macOS may ask to reopen OpenMuse.",
    icon: Monitor,
  },
] as const;

export function Onboarding({ data }: { data: Snapshot }) {
  const [step, setStep] = useState<Step>("welcome");
  const [permissions, setPermissions] = useState<Permissions>(data.permissions);
  const [requested, setRequested] = useState<PermissionKind[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [checkFailed, setCheckFailed] = useState(false);
  const checking = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => heading.current?.focus(), [step]);

  const check = useCallback(async () => {
    if (checking.current) return;
    checking.current = true;
    try {
      setPermissions((await window.kite!.state()).permissions);
      setCheckFailed(false);
    } catch {
      setCheckFailed(true);
    } finally {
      checking.current = false;
    }
  }, []);

  useEffect(() => {
    if (step !== "permissions") return;
    void check();
    const timer = window.setInterval(() => void check(), 2000);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [check, step]);

  async function run(action: () => Promise<unknown>, fallback: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  function allow(kind: PermissionKind) {
    setRequested((kinds) => (kinds.includes(kind) ? kinds : [...kinds, kind]));
    void run(async () => {
      setPermissions(await window.kite!.permissions(kind));
    }, "Could not ask macOS for permission. Try again.");
  }

  const index = steps.indexOf(step);
  return (
    <main className="onboarding">
      <div className="onboarding-titlebar" />
      <div
        className="onboarding-dots"
        role="img"
        aria-label={`Step ${index + 1} of ${steps.length}`}
      >
        {steps.map((name, position) => (
          <span key={name} className={position <= index ? "current" : ""} />
        ))}
      </div>
      <section className="onboarding-screen" key={step}>
        {step === "welcome" && (
          <>
            <div className="onboarding-art">
              <Sprite companion={data.settings.companion} />
            </div>
            <h1 ref={heading} tabIndex={-1}>
              Meet your new work buddy.
            </h1>
            <p>
              Show OpenMuse a workflow once, and it becomes a skill you can use
              again.
            </p>
            <div className="onboarding-actions">
              <button
                className="button primary"
                onClick={() => setStep("permissions")}
              >
                Get started <ArrowRight size={15} />
              </button>
            </div>
          </>
        )}
        {step === "permissions" && (
          <>
            <h1 ref={heading} tabIndex={-1}>
              Two quick permissions.
            </h1>
            <p>Nothing is observed until you start a recording.</p>
            <ul className="onboarding-permissions">
              {rows.map(({ kind, title, detail, hint, icon: Icon }) => {
                const granted = permissions[kind];
                const waiting = !granted && requested.includes(kind);
                return (
                  <li key={kind} className="onboarding-permission">
                    <span className="onboarding-permission-icon">
                      <Icon size={18} />
                    </span>
                    <div>
                      <strong>
                        {title}
                        {kind === "screenCapture" && <small> · Optional</small>}
                      </strong>
                      <p>{detail}</p>
                      {waiting && (
                        <p className="onboarding-waiting">
                          <LoaderCircle size={12} aria-hidden="true" /> Waiting
                          for System Settings. {hint}
                        </p>
                      )}
                    </div>
                    {granted ? (
                      <span className="onboarding-granted">
                        <Check size={14} aria-hidden="true" /> Allowed
                      </span>
                    ) : waiting ? (
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () => window.kite!.openPermissionSettings(kind),
                            "Could not open System Settings. Try again.",
                          )
                        }
                      >
                        Open System Settings
                      </button>
                    ) : (
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() => allow(kind)}
                      >
                        Allow
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
            {checkFailed && (
              <p className="onboarding-error" role="alert">
                Couldn’t check permissions.{" "}
                <button className="text-button" onClick={() => void check()}>
                  Try again
                </button>
              </p>
            )}
            {!permissions.accessibility && (
              <p className="onboarding-note">
                Recording needs Accessibility. You can allow it later in
                Settings.
              </p>
            )}
            <div className="onboarding-actions">
              <button
                className="button primary"
                onClick={() => setStep("ready")}
              >
                Continue <ArrowRight size={15} />
              </button>
            </div>
          </>
        )}
        {step === "ready" && (
          <>
            <div className="onboarding-art">
              <Sprite companion={data.settings.companion} />
              <span className="onboarding-check" aria-hidden="true">
                <Check size={16} />
              </span>
            </div>
            <h1 ref={heading} tabIndex={-1}>
              You’re all set.
            </h1>
            <p>
              Look for me on your desktop. Click me to chat, or hover to record
              a workflow.
            </p>
            <div className="onboarding-actions">
              <button
                className="button primary"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => window.kite!.completeOnboarding(),
                    "Could not finish setup. Try again.",
                  )
                }
              >
                Start using OpenMuse <ArrowRight size={15} />
              </button>
              <button
                className="text-button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    // Finishing destroys this window, so open the workspace first.
                    await window.kite!.openWorkspace();
                    await window.kite!.completeOnboarding();
                  }, "Could not finish setup. Try again.")
                }
              >
                Open the workspace
              </button>
            </div>
          </>
        )}
      </section>
      {error && (
        <p className="onboarding-error" role="alert">
          {error}
        </p>
      )}
    </main>
  );
}
```

- [x] **Step 8: Route the setup window in the renderer**

In `src/App.tsx`:

- Add `import { Onboarding } from "./Onboarding";` below `import { CompanionChat } from "./CompanionChat";`.
- Below the `isBuddy` constant, add:

```tsx
const isOnboarding =
  new URLSearchParams(location.search).get("onboarding") === "1";
```

- Directly after the `if (isBuddy) return (...);` block, add:

```tsx
if (isOnboarding) return <Onboarding data={data} />;
```

- [x] **Step 9: Style the setup window**

Append to `src/styles.css`:

```css
/* First-run setup window: 520×600 with a hidden-inset title bar. */
body:has(.onboarding) {
  background: var(--white);
}
.onboarding {
  height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0 44px 32px;
  background: var(--white);
  user-select: none;
}
.onboarding-titlebar {
  align-self: stretch;
  flex: 0 0 38px;
  -webkit-app-region: drag;
}
.onboarding button {
  -webkit-app-region: no-drag;
}
.onboarding-dots {
  display: flex;
  gap: 6px;
  margin-bottom: 14px;
}
.onboarding-dots span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--line);
}
.onboarding-dots span.current {
  background: var(--blue-dark);
}
.onboarding-screen {
  flex: 1;
  width: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  animation: onboarding-in 220ms ease-out;
}
.onboarding-screen h1 {
  margin-top: 6px;
  font-size: 26px;
  letter-spacing: -0.4px;
  outline: none;
}
.onboarding-screen > p {
  max-width: 340px;
  margin-top: 8px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.5;
}
.onboarding-art {
  position: relative;
  height: 190px;
  display: grid;
  place-items: center;
  margin: 16px 0 8px;
}
.onboarding-art .sprite-capybara {
  width: 170px;
  height: 170px;
}
.onboarding-check {
  position: absolute;
  right: -4px;
  bottom: 22px;
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 2px solid var(--white);
  border-radius: 50%;
  color: #26714b;
  background: var(--green);
}
.onboarding-actions {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.onboarding-actions .button {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 11px 20px;
  font-size: 13px;
  font-weight: 600;
}
.onboarding-actions .text-button {
  font-size: 12px;
  font-weight: 600;
}
.onboarding-permissions {
  width: 100%;
  margin: 22px 0 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 10px;
  text-align: left;
}
.onboarding-permission {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--line);
  border-radius: 12px;
}
.onboarding-permission > div {
  flex: 1;
  min-width: 0;
}
.onboarding-permission strong {
  font-size: 13px;
}
.onboarding-permission small {
  color: var(--muted);
  font-weight: 500;
}
.onboarding-permission p {
  margin-top: 3px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.4;
}
.onboarding-permission-icon {
  flex: 0 0 36px;
  height: 36px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  color: var(--blue-dark);
  background: var(--sky);
}
.onboarding-granted {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: #26714b;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
}
.onboarding-waiting svg {
  vertical-align: -2px;
  animation: onboarding-spin 1s linear infinite;
}
.onboarding-note {
  margin-top: 12px;
  color: var(--muted);
  font-size: 11px;
}
.onboarding-error {
  width: 100%;
  margin-top: 12px;
  padding: 9px 12px;
  border: 1px solid #ebc2bb;
  border-radius: 8px;
  background: #fff3f0;
  color: #8c3f33;
  font-size: 11px;
  line-height: 1.4;
  text-align: left;
}
@keyframes onboarding-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}
@keyframes onboarding-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .onboarding-screen,
  .onboarding-waiting svg {
    animation: none;
  }
}
```

- [x] **Step 10: Cover first launch, replay and close in the smoke test**

In `scripts/smoke.mjs`:

1. Delete the Task 1 comment and `writeFile(...)` call at the top so the data directory starts empty (a fresh install). Keep `writeFile` in the `node:fs/promises` import only if still used; otherwise remove it from the import. Legacy preference loading stays covered by `tests/preferences.test.ts`.

2. In both window filters for the workspace `page`, add `!p.url().includes("onboarding=1") &&` beside the other exclusions.

3. Directly after the `const page = app.windows().find(...)` statement, insert:

```js
const visibility = () =>
  app.evaluate(({ BrowserWindow }) =>
    Object.fromEntries(
      BrowserWindow.getAllWindows().map((window) => {
        const url = window.webContents.getURL();
        const name = url.includes("onboarding=1")
          ? "setup"
          : url.includes("buddy=1")
            ? "buddy"
            : url.includes("companionChat=1")
              ? "chat"
              : "workspace";
        return [name, window.isVisible()];
      }),
    ),
  );
const setupWindow = async () => {
  await expect
    .poll(() => app.windows().some((p) => p.url().includes("onboarding=1")), {
      timeout: 30000,
    })
    .toBe(true);
  return app.windows().find((p) => p.url().includes("onboarding=1"));
};
const setup = await setupWindow();
await expect(
  setup.getByRole("heading", { name: "Meet your new work buddy." }),
).toBeVisible();
await expect
  .poll(visibility)
  .toMatchObject({ setup: true, buddy: false, workspace: false });
await mkdir("artifacts", { recursive: true });
await setup.screenshot({ path: "artifacts/onboarding-welcome.png" });
await setup.getByRole("button", { name: /Get started/ }).click();
await expect(
  setup.getByRole("heading", { name: "Two quick permissions." }),
).toBeVisible();
// Never open real System Settings panes or macOS permission prompts.
await app.evaluate(({ shell, ipcMain }) => {
  globalThis.__smokeOpened = [];
  shell.openExternal = async (url) => {
    globalThis.__smokeOpened.push(url);
  };
  ipcMain.removeHandler("kite:permissions");
  ipcMain.handle("kite:permissions", () => ({
    accessibility: false,
    screenCapture: false,
  }));
});
const lastOpened = () => app.evaluate(() => globalThis.__smokeOpened.at(-1));
const pane = (name) =>
  `x-apple.systempreferences:com.apple.preference.security?${name}`;
const granted = (await setup.evaluate(() => window.kite.state())).permissions;
for (const [kind, title, name] of [
  ["accessibility", "Accessibility", "Privacy_Accessibility"],
  ["screenCapture", "Screen Recording", "Privacy_ScreenCapture"],
]) {
  const row = setup.locator(".onboarding-permission", { hasText: title });
  if (granted[kind]) {
    await expect(row.getByText("Allowed")).toBeVisible();
    continue;
  }
  await row.getByRole("button", { name: "Allow" }).click();
  await expect(row.getByText(/Waiting for System Settings/)).toBeVisible();
  await row.getByRole("button", { name: "Open System Settings" }).click();
  await expect.poll(lastOpened).toBe(pane(name));
}
await setup.evaluate(() => window.kite.openPermissionSettings("accessibility"));
await expect.poll(lastOpened).toBe(pane("Privacy_Accessibility"));
const rejectedUnknownPane = await setup.evaluate(() =>
  window.kite.openPermissionSettings("microphone").then(
    () => false,
    () => true,
  ),
);
if (!rejectedUnknownPane)
  throw new Error("openPermissionSettings accepted an unknown pane");
await setup.screenshot({ path: "artifacts/onboarding-permissions.png" });
await setup.getByRole("button", { name: /Continue/ }).click();
await expect(
  setup.getByRole("heading", { name: "You’re all set." }),
).toBeVisible();
await setup.screenshot({ path: "artifacts/onboarding-ready.png" });
await setup.getByRole("button", { name: "Open the workspace" }).click();
await expect
  .poll(visibility)
  .toEqual({ workspace: true, buddy: true, chat: false });
await expect
  .poll(async () =>
    JSON.parse(await readFile(join(dataDir, "preferences.json"), "utf8")),
  )
  .toEqual({ companion: "capybara", onboardingComplete: true });
```

4. Delete the Task 1 line `await page.evaluate(() => window.kite.openWorkspace());` (the setup window's **Open the workspace** now opens it).

5. Replace the Task 1 block that starts with `await expect(page.getByRole("button", { name: /By the notch|Floating companion/ })).toHaveCount(0);` and ends with the preferences `.toEqual({ companion: "capybara", onboardingComplete: true });` poll with:

```js
await expect(
  page.getByRole("button", { name: /By the notch|Floating companion/ }),
).toHaveCount(0);
await page.getByRole("button", { name: /Replay setup/ }).click();
const replay = await setupWindow();
await expect(
  replay.getByRole("heading", { name: "Meet your new work buddy." }),
).toBeVisible();
await expect.poll(visibility).toMatchObject({ setup: true, buddy: false });
await app.evaluate(({ BrowserWindow }) =>
  BrowserWindow.getAllWindows()
    .find((window) => window.webContents.getURL().includes("onboarding=1"))
    ?.close(),
);
await expect.poll(visibility).not.toHaveProperty("setup");
await expect.poll(visibility).toMatchObject({ buddy: true });
await expect
  .poll(async () => (await page.evaluate(() => window.kite.state())).settings)
  .toMatchObject({ onboardingComplete: true });
```

6. Change the final success message to:

```js
    "Desktop smoke passed: setup window, pet hover/reduced motion, chat persistence, recording flow, workspace, permissions, learning setup.",
```

- [x] **Step 11: Describe first launch in the README**

In `README.md`, replace the paragraph starting "On first launch, OpenMuse shows the floating capybara." with:

"On first launch, OpenMuse opens a short setup window: a welcome, the two macOS permissions it uses, and where to find your companion. Accessibility is needed to record workflows across apps; Screen Recording is optional and used only for screenshots you explicitly attach. **Allow** asks macOS directly, and each permission shows as allowed once it is on in System Settings. If OpenMuse is already listed but recording still fails, toggle its permission off and on and restart rather than adding a duplicate. Closing the window skips setup; replay it from **Settings → Desktop companion** or the menu-bar item. When setup ends, the floating capybara appears."

- [x] **Step 12: Run the full check suite**

Run, from the worktree root, in order: `npx prettier --write electron src server tests scripts README.md`, `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test`, `npm run build:native`, `npm run build`, `npm run smoke`.
Expected: every command succeeds; `npm test` reports 32 passing tests; the smoke prints the setup-window success message and writes `artifacts/onboarding-welcome.png`, `artifacts/onboarding-permissions.png` and `artifacts/onboarding-ready.png`.

- [x] **Step 13: Commit**

```bash
git add -A electron src scripts tests README.md
git commit -m "feat: add three-screen setup window for first launch"
```

---

## Review amendments

Wave reviews and the final integration review found problems in this plan's code. The branch ships these corrections instead of the blocks above:

- `src/styles.css`: the intro-paragraph selector is `.onboarding-screen > p:not([class])`, so `.onboarding-note` and `.onboarding-error` keep their own styles inside the screen.
- `src/Onboarding.tsx`: `allow()` records a request only after `permissions(kind)` resolves, so a failed request keeps **Allow**. A `go(next)` helper clears the action error on every screen change.
- The waiting spinner uses the shared `.spin` class; `@keyframes onboarding-spin` is gone.
- `scripts/smoke.mjs`: the onboarding screenshots pass `animations: "disabled"` and wait for the sprite image to decode. The `kite:permissions` stub answers with a snapshot of the machine's permission status, read once before the stub is installed, not a live read on every call; it answers after 400 ms, as macOS would (`f8bf647`). The smoke calls `openPermissionSettings` for each kind and expects exactly that kind's pane, and an unknown name is refused and opens nothing, so both panes are checked whatever the Mac has granted (`0845568`).
- `electron/main.ts`: the screenshot handler also hides the setup window during capture. It restores the window with `showInactive()` before the other windows, so the workspace ends up in front once both are shown again. At first it restored the window only if it had been visible and still existed; `fe21dde` below restores it whenever it still exists. `makeOnboardingWindow` blocks `page-title-updated`, so the window keeps the title "Welcome to OpenMuse" instead of the page's `<title>`.
- Task 1 Step 10 first expected `grep -rn -i "notch"` to print nothing, which cannot hold: the legacy-migration comment, enum, test and smoke assertion keep the word on purpose. The step now says so.

A further code-review round (`git log --oneline 6a86bfb..7aa5308`) corrected:

- Preferences: unknown keys written by other builds (for example `activeThreadId`) are dropped instead of throwing and crashing startup; known-field validation and the strict save schema are unchanged (`010e157`).
- `updatePreferences` only calls `syncCompanionWindows()` when the change touches `onboardingComplete`, so picking a companion in Settings no longer re-raises or refocuses an open setup window (`5153281`).
- `.onboarding-titlebar` gets `margin: 0 -44px` so the drag strip spans the window's full width instead of the padded content width (`697d366`).
- `replaySetup()` throws "Stop the recording before replaying setup." while `store.active` is set, before touching preferences; both the Settings button and the tray item route through it (`175fdb1`; `7ce2c8f` below also refuses while a recording is starting).
- `completeOnboarding` takes an optional `{ openWorkspace }` flag and opens the workspace only after the preferences save resolves, so a failed save's error stays visible in the setup window (`e1e27b7`).
- Setup-window actions always show their fixed fallback message on failure and log the real cause with `console.error`, instead of surfacing raw IPC error text (`c146b2d`; `9382d45` below rewords the message shown when finishing setup fails).
- `openCompanionTray()` throws while setup is incomplete, and the screenshot handler's restore step re-shows the companion and chat only if `onboardingComplete` is still true (`75ad705`).
- The setup window centers explicitly on `screen.getPrimaryDisplay().workArea` instead of `center: true`, and clears the module-level `onboarding` reference in a `closed` handler guarded by identity (`1f898e0`).
- Permissions-screen copy fix ("Nothing is captured until you record or attach a screenshot."), `disabled={busy}` on Continue, `aria-live="polite"` on the list, and per-row `aria-label`s (`684f8b3`).
- Settings → macOS permissions rows gained their own **Open System Settings** button, shown whenever that permission is not granted; unlike the setup window's button, it does not wait for an **Allow** request first (`f74a3c3`).
- `server/runtime.ts`'s placeholder `settings.onboardingComplete` default changed from `true` to `false`, matching the real preferences default; main.ts overwrites it either way before any window can read it (`65f030c`).
- `loadPreferences` takes a `returningInstall` flag; main.ts checks for the `library` folder before `Store.load()` creates it, so an existing install without a preferences file skips setup instead of running it (`c3b810e`; `5e6642f` below stops a relaunch mid-setup from counting as one, and `fa51656` moves the check into `startupPreferences`).
- Explanatory comments added for the setup window's lifecycle: `skipOnboarding`'s role, the workspace never opening at launch, the title lock, quit-vs-close, and the screenshot restore order (`7aa5308`).

Another review round (`git log --oneline 7aa5308..0845568`) corrected:

- `startupPreferences(path, returningInstall)` saves a new install's defaults at startup, so quitting during setup and relaunching shows setup again. The `library` check decides the default only when no preferences file exists, and only ENOENT counts as a missing folder (`5e6642f`; `fa51656` below makes it take the library path and check the folder itself).
- When the setup window fails to load, the cause is logged, the window is destroyed and an alert points to the menu bar's **Replay setup**; Replay setup, Show companion or Dock activation then builds a fresh window. A close-to-skip save failure logs the cause and shows a sheet on the setup window, which stays open. The menu bar's **Replay setup** failure opens the workspace and shows the main process's message in a sheet there. These paths no longer use the blocking `dialog.showErrorBox` (`df1a09a`).
- Workspace error banners drop Electron's "Error invoking remote method…" prefix (`9382d45` below moves this into the preload, for every window); Settings → **Replay setup** is disabled, with a tooltip, while a recording is active; Settings' **Open System Settings** buttons get per-row accessible names; `.onboarding` scrolls instead of clipping (`1d81eac`).
- `electron/setup-guards.ts` holds both rules, with unit tests in `tests/setup-guards.test.ts`: replay is refused while a recording is active or still starting, and `startRecording` refuses with "Finish setup before starting a recording." before its permission check, because the workspace can be open during setup (`7ce2c8f`).
- Unreadable, malformed or invalid preferences fail startup with a detail that names the file and says to fix or delete it, and strict saving (unknown keys and missing fields rejected) is unit-tested (`c57e04a`).
- `scripts/smoke.mjs` checks the setup-window fixes end to end, with separate launches for a legacy preferences file and a returning install (`f8bf647`), allows 4 points of centering error on scaled displays (`00670ee`), adds a relaunch mid-setup, and prints one ledger line per check with the reason for each skip; its effect checks now fail when the effect is missing (`0845568`).

The third review round (`git log --oneline ec71164..b5a28d7`) corrected:

- `replaySetup` counts itself in `setupReopenings` from the moment it passes its guard until its save settles, because `onboardingComplete` only changes once that save lands. Until then `startRecording` refuses with "Finish setup before starting a recording." and `openCompanionTray` refuses too; `recordingBlockedReason` takes `{ complete, reopening }`. The screenshot handler restores the setup window whenever it still exists, because macOS can report a covered window as not visible (`fe21dde`).
- `startupPreferences(path, libraryPath)` checks the library itself, and main.ts calls it before `Store.load()`, so a first launch that fails or is quit once the library exists still shows setup next time. A library that cannot be checked fails startup with its path and a recovery hint. A failed save names the preferences file (`Could not save <path>: <reason> Check free disk space and folder permissions, then try again.`), and the temporary file is removed only when the write or rename fails. `loadCompanion` and `saveCompanion` are gone, so the tests from Task 1 Step 1 call `loadPreferences` and `savePreferences` instead (`fa51656`).
- The preload strips Electron's `Error invoking remote method` prefix once, for every call, and App.tsx drops its `ipcMessage` helper. The New recording dialog says "Finish setup before starting a recording." and disables **Start recording** while setup is incomplete, and it shows the workspace error; opening it clears an old error. When finishing setup fails, the setup window says "Could not save your settings. Check free disk space and folder permissions, then try again." instead of Step 7's "Could not finish setup. Try again." The drag strip stays at the top while setup scrolls, and setup errors can be selected (`9382d45`).
- `scripts/smoke.mjs` covers both orders of a replay and a recording, the companion tray during a replay and the setup-first recording dialog, and compares refusals and errors as whole messages in every window. A quit that takes over 20 s is killed and fails the run, a renderer error in any window of any launch fails the run, and the last line reads `Desktop smoke passed: <n> checks covered, <m> skipped.` (`bcb1270`).
- Quitting while the setup or chat window is still loading no longer shows a load-failure dialog, which held up the quit (`b5a28d7`).

Corrections that no round above recorded:

- `makeOnboardingWindow`'s close handler returns before it blocks the close (`event.preventDefault()`) when `skipOnboarding` is unset, as it already did while the app quits. Task 2 Step 6's block blocked the close first, which would leave such a window unable to close; every setup window is in fact created after `skipOnboarding` is set (`df1a09a`).
- Test counts: Step 4 of both tasks expects 4 tests in `tests/preferences.test.ts`, and Task 1 Step 10 and Task 2 Step 12 expect 32 unit tests. The branch now has 46: 13 in `tests/preferences.test.ts` and 5 in the new `tests/setup-guards.test.ts`.
- `README.md` does not use the text that Task 1 Step 9 and Task 2 Step 11 quote. It says Electron hosts the "first-run setup window", and its first-launch paragraph also covers Settings' **Open System Settings** button, existing installs, and the replay and recording rules.

Merged with `main` after PR #1 (`b98c668`) and the pointer/screenshot contract (PR #2, `1c68d2e`) landed there:

- The screenshot handler is now `main`'s concealing `captureScreenshot` pipeline (`electron/screen-capture.ts`), so the setup-window hide and restore described above (`1f898e0`, `75ad705`, `fe21dde`) is gone. The setup window takes the removed notch window's place in `openMuseWindows()`, so captures and pointer overlays fade it out and back in like the other OpenMuse windows, and a replay during a capture leaves the companion hidden because nothing is re-shown.
- `kite:action` and `KiteAPI.action` stay removed, and the unit suite now includes `main`'s tests (247 in total).
- ⌘⇧K is registered after the menu bar item and the Dock handler, retried 1 s and then 3 s later, and a failure is only logged: on macOS a parentless alert freezes the main process until it is dismissed. Startup used to await that warning as a sheet on the workspace, which this branch keeps hidden at launch, so a taken shortcut stalled setup and later the quit.
- `restoreVisibleBuddy` returns early once the companion window is destroyed. macOS sends display changes while the app quits; touching the destroyed window threw, and Electron's uncaught-exception dialog held the quit up (4 of 6 short launches in a diagnostic, 0 of 6 after the fix).
- The menu bar’s replay refusal opens the workspace and shows as a sheet there, and `syncCompanionWindows` returns early once quitting has started or the companion is destroyed (`e576061`).
