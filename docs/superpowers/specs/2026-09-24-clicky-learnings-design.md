# Clicky learnings: PR stack design

Approved direction on September 24, 2026: turn the lessons from [farzaa/clicky](https://github.com/farzaa/clicky) into a plan and ship it one PR at a time. Leave out the capybara-as-pointer flight animation for now.

Clicky is a MIT-licensed Swift menu-bar companion. You hold ctrl+option and talk; it screenshots every display, sends the transcript and images to Claude, speaks the reply and flies a cursor to whatever it mentions. Its public source (last commit April 27, 2026) shows how to hit the target the model saw and how to do hold-to-talk voice. It also shows several things this app should not copy.

## Stack

Each PR is based on the previous one. The first is based on `jerel/kite-os-learning` (open PR #1), because the pet chat and notch windows exist only there. Every PR must pass `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build:native` and `npm run build` on its own.

| #   | Branch                              | Change                                          | Needs                       |
| --- | ----------------------------------- | ----------------------------------------------- | --------------------------- |
| 1   | `jerel/pointer-screenshot-contract` | Point where the model looked                    | PR #1                       |
| 2   | `jerel/agents-md`                   | AGENTS.md for coding agents                     | 1                           |
| 3   | `jerel/native-display-capture`      | Capture every display and leave our windows out | 2                           |
| 4   | `jerel/point-at-control`            | Point at controls by their Accessibility label  | 3                           |
| 5   | `jerel/hold-to-talk`                | Hold ctrl+option to ask by voice                | 4, plus the decisions below |
| 6   | `jerel/spoken-replies`              | Speak replies to voice questions                | 5, plus the decisions below |

Deferred: the capybara flying to its target (a click-through overlay at screen-saver level), dropping the approval prompt for pointing, and an onboarding demo that points at something on the user's screen. The demo is only worth building once the flight exists, and it would need a direct vision call outside Codex.

## Boundaries every PR keeps

- Every desktop action still needs the native "Allow once" approval. Pointing does not click or type. (Computer use, added after this stack on `jerel/act-for-me`, asks once per task instead: see `docs/superpowers/plans/2026-09-25-act-for-me.md`.)
- Model and Intelligence keys stay in the Node runtime. Nothing new reaches a renderer or a Codex shell.
- A failure names its real cause. Never mock success or say "out of credits" (Clicky plays that for every error).
- No PR in this stack adds analytics or sends transcripts anywhere new; Clicky sends full transcripts and replies to PostHog. The CopilotKit runtime's built-in usage telemetry predates this stack and is out of its scope.
- Permissions are read live, never cached as a boolean (Clicky caches Screen Recording after one capture).
- The Swift helper stays the only native macOS integration process (the bundled Codex CLI is also native, but it runs the agent), and each new capability is a separate command in its JSONL protocol.
- `com.kite.sprite`, `Application Support/Kite`, the `kite:` IPC namespace and `KITE_*` variables stay as they are.

## 1. Point where the model looked

**Problem.** Before this PR, `point_on_screen` took global screen coordinates, but the model only saw a thumbnail of the primary display capped at 1440×900. It was never told the thumbnail's size, and nothing converted image pixels to screen points. On a 1512×982 display the thumbnail was about 1386×900, so every point landed about 8% toward the top-left.

**Codex resizing.** Codex 0.156.1 re-encodes a prompt image unless its longest side is at most 2048 px and it covers at most 2,500 tiles of 32×32 px (`codex-rs/utils/image`, `PromptImageMode::HIGH_DETAIL`). When it resizes, it may add a developer note giving the new size. Either way the model's pixels would no longer match the size we state. So `captureSize` sizes captures to pass through untouched:

- Keep the display's aspect ratio.
- Never go above the display's size in points; 1:1 when it fits, so one image pixel is one screen point.
- Longest side at most 1920 px.
- Tile count within 2,500.

A 1512×982 display is captured at 1512×982, and a 2560×1440 display at 1920×1080.

**Contract.**

1. **Capture.** The screenshot handler (the `kite:screenshot` IPC call) captures only the primary display; PR 3 handles every display. In order, it:
   - checks Screen Recording permission, read live from the helper, and without it fails with `Allow Screen Recording for OpenMuse Desktop in System Settings > Privacy & Security > Screen & System Audio Recording, then quit and reopen OpenMuse Desktop.` before any window changes;
   - makes the visible workspace, pet, notch and companion chat windows transparent instead of hiding them: `conceal()` sets each window's opacity to 0 at once, with no animation;
   - waits 200 ms, then captures through `desktopCapturer` at `captureSize`. If `desktopCapturer.getSources` doesn't answer within 10 s, the capture fails with `Screen capture didn't respond. Try again, or quit and reopen OpenMuse Desktop.`;
   - restores the windows as soon as the sources come back, before the steps below;
   - takes only the source whose `display_id` matches, with no fallback to another source, because an image of the wrong display would put the pointer in the wrong place; an empty thumbnail is an error too;
   - measures the PNG by reading its header in `fitThumbnail` instead of trusting the requested size. A thumbnail larger than the target, for example a 2x one, is rebuilt from its own pixels and resized to the target, and an image still over the Codex limits is an error;
   - reads the display again, and fails if it is gone or its bounds changed during the capture;
   - registers the capture at the size it measured with `registry.add`, which validates its dimensions and bounds.

   While concealed, the opaque workspace also ignores the mouse. The transparent pet, notch and companion chat windows change only their opacity: once `setIgnoreMouseEvents` is called on a transparent window, it loses AppKit's click-through of its clear pixels for good, and Electron never calls it when it creates the window. The window factories in `electron/main.ts` mark each transparent window with `markTransparent` as soon as they create it, before any fade can reach it, and each fade records whether it made its window ignore the mouse, so restoring undoes exactly that.

   If anything fails before the windows are restored, the 10 s timeout included, they are restored before the error is rethrown, and a restore that fails then doesn't replace the error. Fades nest per window, so a window gets its opacity back, and the workspace stops ignoring the mouse, only once every overlapping fade covering it (including one from the pointer's own conceal in `electron/point-action.ts`) has ended. Fades are exception-safe: if a window fails to fade, `conceal()` puts back that window's opacity if it had already changed, and undoes the fades it had already made, before it rethrows. If a window's opacity fails to come back, `restore()` leaves that window as its fade left it: invisible and, for the workspace, still ignoring the mouse, because invisible and clickable would be worse. If the workspace's opacity comes back but it can't stop ignoring the mouse, it stays visible and ignores clicks. Either way `restore()` still restores the other windows before it rethrows the first error. A fade's record is deleted only once its window is verifiably back, or destroyed, so after a failed restore, or a failed attempt to put the opacity back while fading, the next fade and restore retry with the window's original opacity, not the 0 the failure left. Concurrent capture calls share one in-flight capture, so a burst of clicks makes one capture and one registry entry.

2. **Registry.** The registry is in memory and keeps the 16 most recent captures as `{id, displayId, label, bounds, width, height, capturedAt}`. Each entry and its bounds are frozen, so they can't change after the fact. IDs are `shot_` plus 8 hex characters (32 random bits, for example `shot_1a2b3c4d`), so an ID from an earlier session is vanishingly unlikely to match a new capture. `startRuntime` and `CodexRunner` both take the registry as a required `screenshots` key whose type, `ScreenshotLookup`, doesn't allow `undefined`, so leaving the wiring out of either call, or passing `undefined`, fails the typecheck.

3. **Attachment.** The screenshot IPC call returns `{id, label, width, height, dataUrl}`, and `userContent` puts the ID on the AG-UI binary part's `id`. It survives only because `KiteCodexAgent` reports AG-UI 0.0.59, the `maxVersion` it inherits from `@ag-ui/client`; the 0.0.47 compatibility middleware would rebuild binary parts without it. Tests pin this: `tests/message-content.test.ts` and `tests/codex.test.ts` parse the content with `RunAgentInputSchema`, and `tests/codex.test.ts` also runs a real `KiteCodexAgent.runAgent` round trip. A new conversation clears the attachment, and fresh requests (**Record to skill** and **Use this skill**) don't send it (`requestAttachment` in `src/message-content.ts`). A capture that finishes after a message is sent or a new conversation starts is dropped, and so is its error, so it can't land on the next message (`createEpoch`). A successful capture clears an earlier capture error, but never a run failure or any other message. A capture error is shown without the `Error invoking remote method 'kite:screenshot': Error:` prefix that Electron adds: `ipcErrorMessage` strips the invoke wrapper and then any `<Name>Error:` label, such as `TypeError:`, each only when present. The footer reads `Screenshots shared when sent`.

4. **Notes.** The Codex adapter adds a note for each image and names the image by position, for example `Image 1 in this message is screenshot shot_1a2b3c4d of Built-in Retina Display, 1512×982 pixels`. Position is used because the Codex SDK joins every text part into one prompt and passes images separately, in order. The wording is written on the server, so neither the renderer nor the AG-UI and Intelligence thread message carries prompt text, though the Codex session transcript does keep the notes. The note is chosen in this order:
   1. no ID: unreferenced;
   2. an ID that isn't registered: unknown;
   3. a PNG whose size differs from the registered size: mismatched;
   4. a capture that isn't fresh (`isFresh`): stale;
   5. otherwise the describing note, the only one that offers pointing.

   Before its note, each image is checked, and each problem fails the run with its own error naming its number, which counts every part of the message that isn't text: a binary part that isn't `image/png` (`Attachment <n> is not a PNG screenshot.`), no data, over 12 MB (16,000,000 base64 characters), or not a valid PNG. A part that is neither text nor binary fails the run with `Attachment <n> (<type>) is not supported.`. The PNG check reads only the header, and the size in that header is the one that must match the registered size. The instructions tell the model to pass the screenshot ID, a short label naming the target, and x, y in that screenshot's pixels. When the prompt is rebuilt from history because no native thread was saved, earlier messages keep their text, with `[image omitted]` in place of each image and `[attachment omitted]` in place of any other attachment.

5. **Refusals.** `point_on_screen` takes `{screenshotId, x, y, label}`, with x and y in the image's pixels. The main process snaps the point to its pixel and converts that pixel's center to global screen points. `resolvePoint` and `screenPoint` refuse the point, checking in this order, when:
   - the ID is unknown (the message names the ID);
   - the capture time is in the future, because the clock moved back;
   - the capture is more than 10 minutes old;
   - the display is gone;
   - the display changed position or resolution;
   - the point is outside the image (the message gives the image's size, so the model can retry).

   The point is checked when the model asks and again after "Allow once", because while the prompt is open the display can change, and the capture can expire or be replaced by newer captures; the second check must also find the same capture the user was shown (item 8). Only a clock that moved back to before the capture time is caught; other clock shifts go unnoticed and only change the capture's apparent age. Each refusal except the last tells the model to ask the user for a new screenshot.

6. **Label.** The approval prompt shows the label without escaping it, so it is trimmed and normalized to NFC, must then be 1 to 60 characters long (zod counts code points), and must pass six rules, checked in this order, each with its own message (`server/point-schema.ts` has the exact rules and messages):
   1. no `\p{C}`, `Zl` or `Zp` character, except ZWNJ and ZWJ;
   2. no known blank character, such as a Hangul filler or the Braille blank;
   3. no other invisible (default-ignorable) character, except ZWNJ, ZWJ and the text and emoji style selectors U+FE0E and U+FE0F;
   4. no run of two or more ZWNJ/ZWJ, and no stack of combining marks on one letter: the combining accent blocks (U+0300 to U+036F and its relatives) cap at two marks per letter, even with other marks or joiners between them; in any script, nonspacing and enclosing marks (`Mn`, `Me`) cap at four in a row, with spacing marks (`Mc`) and joiners allowed between them without counting, so real words in Hindi, Burmese, Tibetan or pointed Hebrew still pass; and the same nonspacing mark may not appear three or more times in a row, again with spacing marks and joiners allowed between;
   5. no two spaces (`Zs`) with only marks or joiners between them, because a run of spaces can make the rest of the label look like a line of its own;
   6. at least one letter or number.

   The rules are refinements rather than `.regex()`, because a published JSON Schema pattern has no `u` flag. NFC changes how a label is spelled but not how it renders, so canonically equivalent spellings get the same verdict: decomposed polytonic Greek passes like its precomposed form. The rules count the combining marks left after composition, so `a` plus three acute accents passes: NFC makes it U+00E1 plus two, the same label as U+00E1 typed with two accents after it. A label over 480 UTF-16 units, too long to fit in 60 characters even after NFC, isn't normalized: normalizing takes quadratic time on a long run of combining marks, and the length check rejects the label anyway.

7. **Approval.** `approve` in `electron/main.ts` asks through `askApproval` (`electron/approval.ts`). The prompt is always a sheet attached to an OpenMuse window, never the parentless form: on macOS a parentless message box runs synchronously until it is answered, which would block the main process, and with it the runtime server, MCP, IPC and timers. `approvalHost` picks the host: the companion chat if it is visible, and otherwise the workspace. Before asking, OpenMuse calls `app.focus({ steal: true })`, and then, if the workspace hosts the prompt but isn't on screen, calls `app.show()`, which undoes hiding the app with Command-H, restores the workspace if it is minimized, and shows and focuses it. It doesn't use `openWorkspace()` for this, because that hides a chat that isn't hosting a prompt: after Command-H every window reads as hidden, so the workspace hosts the prompt even when the chat was open, and the chat comes back with it. When the host is the workspace, it also bounces the Dock icon if OpenMuse isn't active yet, and cancels the bounce when the prompt ends; the chat needs no bounce, because it floats above every app on every Space. While the chat hosts a prompt, `openWorkspace()` leaves it on screen (`approvalHosts`), because hiding a window ends its sheet.

   The title is "OpenMuse wants to take an action", and the buttons are Cancel and "Allow once". Cancel is both the default and the cancel button, so Escape declines and Return does nothing; Return never allows. macOS doesn't show the title, so each message says who is asking, and what the model supplied goes on its own attributed line in the detail. For a point the message is `The agent wants to show a pointer on <display>`, with the detail `The agent says it points at: <label>`. To open an app it is `The agent wants to open an app`, with the detail `The agent says the app is: <bundle id>`. `server/tools.ts` and `approvedAction` check a bundle ID with the same `bundleIdSchema` (`server/point-schema.ts`): at most 255 characters, and the pattern `native/Recorder.swift` checks for `--open-app`, so a bundle ID the user allows never fails the helper's own pattern check. A test in `tests/tools.test.ts` compares the two patterns.

   Only "Allow once" approves; Cancel resolves `askApproval` to false, and the caller turns that into its own decline error, worded for the model that reads it rather than the user, so it says not to retry instead of inviting one. Opening an app and a declined point both fail with `The user declined. Don't retry unless they ask.` (`DECLINED_MESSAGE`, exported from `electron/approval.ts` and used by `electron/main.ts` and `electron/point-action.ts`). A prompt that ends because its host window hid, or because the request was cancelled, gets its own error instead of reading as a decline. A prompt whose host window hides before the user answers fails with `The approval prompt closed before the user answered. Don't retry unless the user asks again.`. The server passes each MCP request's `request.signal` to the action (`server/tools.ts`), and the sheet gets that signal. It aborts when the request's connection closes before the response, as it does when the Codex process exits. If it aborts before the user answers, the sheet closes, or never opens, and the call fails with `The request was cancelled before the user answered.`; if it aborts after "Allow once" but before the action runs, the call fails with `The request was cancelled before the action ran.` and nothing runs.

   **Stop agent** closes a pending prompt this way, without acting, and ends the run. It reaches `KiteCodexAgent.abortRun()` (`server/codex-agent.ts`), which aborts the active run. An abort that arrives after `runAgent` has started (`isRunning`) but before the run has subscribed is latched and still stops that run; one that arrives before any run, or after a run has finished, does nothing. `CodexRunner` hands the abort to the Codex SDK, which kills the Codex process. Its exit closes the MCP request, which aborts `request.signal`, which closes the sheet, and the run ends with RUN_ERROR `Run stopped`. If Stop lands while `CodexRunner` is still preparing the prompt, `runStreamed` is never called: the SDK writes the prompt to Codex's stdin with no error listener, so a Codex process killed as it starts could crash the main process with EPIPE (Known limits has the race that remains). A failed removal of the run's temporary screenshots never replaces its result. CopilotKit's Intelligence runner calls the same `abortRun()` when it stops a run and on its failure paths, so those end the local Codex turn too. `tests/runtime-e2e.test.ts` pins the process half: a run-scoped `agent/stop`, carrying `{runId}` as the renderer sends it, kills a fake Codex CLI that would otherwise hang, and the run ends with `Run stopped`. `tests/runtime-http.test.ts` pins the signal half: dropping a real MCP connection while `point_on_screen`'s action is pending aborts the action's signal. `tests/codex.test.ts` covers `abortRun()`, the latch, a Stop during preparation and a failed cleanup.

8. **Ring.** `performPointAction` (`electron/point-action.ts`) resolves the point, builds the prompt with `pointPrompt`, and asks for confirmation. A decline fails with `The user declined. Don't retry unless they ask.`, and if the request has been cancelled by the time the user chooses "Allow once", the point fails with `The request was cancelled before the action ran.`. It then resolves again, and that must return the same capture the user was shown, the registry's own object for it, or the point fails with `That screenshot was replaced while the prompt was open. Ask the user to attach a new one.`. Next it conceals each visible OpenMuse window whose bounds, grown by `RING_MARGIN` (32 pt: half the helper's 48 pt ring panel plus 8 pt of slack), contain the point (`coversPoint`), and runs the helper's `--point`, which shows the ring for 1.2 s. The ring itself reaches about 21 pt from the point, because `native/Recorder.swift` insets its oval 5 pt inside the panel and strokes it 4 pt wide. The helper draws the ring at screen-saver level, above our windows, so only the target needs clearing. The windows are restored whether or not the helper succeeds, and when the helper fails, a restore that fails too doesn't replace the helper's error. When the helper succeeds, a restore that fails afterwards doesn't fail the point: the user has seen the ring, so the point is reported as shown instead of inviting the model to retry, and the window's kept fade record lets a later fade and restore bring it back.

9. **Helper.** Every one-shot helper call goes through `runHelper` (`electron/helper-result.ts`), and a test in `tests/helper-result.test.ts` scans `electron/main.ts` to keep each `exec(helper` inside it. `runHelper` reports the helper's own error line, or names the cause (a timeout, a crash or another signal, a missing helper, a spawn failure, an exit code and so on) without the helper's path, arguments or stderr. That includes the rarer spawn failures Node reports synchronously, with no output attached, such as a helper that isn't a valid program for this Mac (`ENOEXEC`, or `EBADARCH` for a build for another CPU), which fails with `The desktop helper isn't a valid program for this Mac. Rebuild it with npm run build:native, or reinstall OpenMuse Desktop.`. A missing or non-executable helper names the same fix: `The desktop helper is missing or not executable (<code>). Rebuild it with npm run build:native, or reinstall OpenMuse Desktop.`. A failure that gives no reason suggests a retry and then a rebuild: `The desktop helper exited with code <code> and gave no reason. Try again; if it keeps failing, rebuild it with npm run build:native.`, or with no exit code, `The desktop helper failed and gave no reason. Try again; if it keeps failing, rebuild it with npm run build:native.`. A crash signal (`SIGTRAP`, `SIGSEGV`, `SIGBUS`, `SIGILL`, `SIGABRT`, `SIGFPE`, `SIGSYS`, `SIGXCPU` or `SIGEMT`) reads `The desktop helper crashed (<signal>)`, and any other signal `The desktop helper was stopped by <signal>`. The error it throws keeps no `cause`, because Electron logs a failed IPC handler together with its cause. Only `--point` and `--open-app` must also print their success status line; the strings live in `helperStatus`, and a test checks them against the Swift helper's status events. Calls time out after 15 s, except `--open-app` at 60 s, because a first launch can wait on Gatekeeper. The Codex MCP tool-call timeout is pinned at 300 s in our config (`tool_timeout_sec` in `server/codex-agent.ts`), the default of Codex 0.156.1 (`DEFAULT_TOOL_TIMEOUT` in codex-rs `rust-v0.156.1`), so a Codex upgrade can't change it. It covers the approval and the helper together, so if they take longer, Codex fails the tool call; Known limits says what that does to an open prompt.

**Known limits.** Hiding the window that hosts a pending prompt still ends it: clicking the pet or switching placement hides the companion chat, and a prompt on it is reported as closed, not declined. Two approvals pending on the same window, for example one from the workspace's conversation and one from the chat's, stack as sheets on it. Hosting a prompt on the workspace may switch Spaces, because the workspace, unlike the chat, isn't on every Space. Codex's 300 s tool timeout closes a pending prompt only if Codex drops the MCP connection when it gives up on the call, which nothing here verifies; without Stop, a prompt can stay open until it is answered or the Codex process exits, which closes it without acting. A faded transparent window, the pet, notch or chat, can still catch clicks on its opaque pixels, so a click inside the ring during its 1.2 s can land on one that is invisible. Sheets and dialogs, such as the folder picker or the export dialog, are separate windows that aren't faded, so they can appear in a capture or cover a pointer target. The ring is the helper's own window, which `conceal()` doesn't touch, so a capture taken while it's up can include it. The 10 s capture timeout doesn't cancel the underlying `getSources` call, which keeps running in the background, and its result is dropped. A Stop that lands within milliseconds of the Codex SDK spawning Codex with a large prompt can still hit the EPIPE described in item 7; that race is inside `@openai/codex-sdk`, upstream, where our check can't reach it.

**Messages.** Each message below is quoted verbatim from the code, with placeholders for its values. `tests/doc-contract.test.ts` checks that this spec quotes every one, and that the refusals are listed here in the order the code checks them.

- Refusals, in the order they are checked:
  - `No screenshot <id> is available; it may have been replaced by newer captures or the app restarted. Check the id, or ask the user to attach a new screenshot.`
  - `That screenshot's capture time is in the future, so the clock changed since it was taken. Ask the user to attach a new one.`
  - `That screenshot is more than 10 minutes old. Ask the user to attach a new one.`
  - `<display> is no longer connected. Ask the user to attach a new screenshot.`
  - `<display> changed position or resolution since the screenshot. Ask the user to attach a new one.`
  - `(<x>, <y>) is outside the <width>×<height> screenshot.`
- Image notes, in the order they are chosen:
  - `Image <n> in this message has no screen reference, so point_on_screen cannot target it.`
  - `Image <n> in this message names a screenshot OpenMuse doesn't have, so point_on_screen can't target it. Ask the user to attach a new one if you need to point.`
  - `Image <n> in this message doesn't match the screenshot it names, so point_on_screen can't target it. Ask the user to attach a new screenshot if you need to point.`
  - `Image <n> in this message is a screenshot that is too old to point at, or whose capture time is unknown. Ask the user to attach a new one if you need to point.`
  - `Image <n> in this message is screenshot <id> of <display>, <width>×<height> pixels. To point at something in it, call point_on_screen with screenshotId "<id>", a short label, and x, y in that image's pixels (origin at the top-left, x rightward, y downward).`
- The approval: the title `OpenMuse wants to take an action`, the buttons `Cancel` and `Allow once`, for a point the message `The agent wants to show a pointer on <display>` with the detail `The agent says it points at: <label>`, and to open an app the message `The agent wants to open an app` with the detail `The agent says the app is: <bundle id>`.
- Approval and pointer errors: a decline, for a point or to open an app, `The user declined. Don't retry unless they ask.`; a prompt closed without an answer, `The approval prompt closed before the user answered. Don't retry unless the user asks again.`; a request cancelled before the user answered, `The request was cancelled before the user answered.`, or after "Allow once", `The request was cancelled before the action ran.`; and a screenshot replaced while the prompt was open, `That screenshot was replaced while the prompt was open. Ask the user to attach a new one.`
- The capture's errors: without Screen Recording, `Allow Screen Recording for OpenMuse Desktop in System Settings > Privacy & Security > Screen & System Audio Recording, then quit and reopen OpenMuse Desktop.`, and the timeout, `Screen capture didn't respond. Try again, or quit and reopen OpenMuse Desktop.`
- Helper errors: a helper that isn't a valid program for this Mac, `The desktop helper isn't a valid program for this Mac. Rebuild it with npm run build:native, or reinstall OpenMuse Desktop.`; a missing or non-executable one, `The desktop helper is missing or not executable (<code>). Rebuild it with npm run build:native, or reinstall OpenMuse Desktop.`; a crash, `The desktop helper crashed (<signal>)`, and any other signal, `The desktop helper was stopped by <signal>`; and a failure that gives no reason, `The desktop helper exited with code <code> and gave no reason. Try again; if it keeps failing, rebuild it with npm run build:native.`, or with no exit code, `The desktop helper failed and gave no reason. Try again; if it keeps failing, rebuild it with npm run build:native.`
- The composer's footer: `Screenshots shared when sent`.

**Tests.**

- Capture sizing: 1:1, larger displays, ultrawide, portrait, and cases limited by the tile budget; the budget's edge values; invalid display sizes; and the Codex SDK version the limits were checked against.
- PNG header parsing, `exceeds`, and `fitThumbnail`: a fitting thumbnail is left alone, a 2x one is resized once, the measured size is reported, and an image still too large is refused.
- The capture sequence (`electron/screen-capture.ts`) with fakes for Electron: nothing is concealed or captured without Screen Recording, and the refusal says where to allow it; the windows come back right after the sources, before the display is read again, and exactly once after every failure, the 10 s timeout included; a restore that fails after a failure keeps that failure's error, and one that fails after a good capture fails it before anything is registered; another display's source is never used; a display change during capture is refused; and the measured PNG size is what gets registered. `singleFlight` and `withTimeout` are tested there too.
- Registry IDs, eviction, freezing, the default of 16, and limit and dimension validation.
- Pixel-to-point conversion, including a display with a negative origin and fractional points; `sameBounds`; and `isFresh` at the 10-minute boundary and after a clock rewind.
- The refusal state table in `tests/screenshots.test.ts`: `resolvePoint` and `screenPoint` give each cause its own message, and the age is checked before the display.
- The note state table in `tests/codex.test.ts`: each note state through `CodexRunner`, including a capture that is both stale and mismatched and a runner whose registry is empty; each attachment error (not `image/png`, no data, the 16,000,000-character boundary, an invalid PNG, and a part that is neither text nor binary); recovered history with `[image omitted]` and `[attachment omitted]`; the updated instructions; the pinned 300 s tool timeout; and the removal of the temporary screenshot files after a run, where a failed removal never replaces the run's own outcome.
- Stop in `tests/codex.test.ts`: `abortRun()` ends the active run with RUN_ERROR `Run stopped`, including a run it precedes after `isRunning` is set but before `run()` subscribes; it does nothing before any run or after one has finished; and a Stop during prompt preparation never calls `runStreamed`.
- The tool schema in `tests/tools.test.ts`, including the 255-character limit on a bundle ID, a published bundle-ID pattern that matches `native/Recorder.swift`'s `--open-app` check, and that both desktop tools pass the request's own signal to the action; and the label sweep across Unicode categories in `tests/point-schema.test.ts`, with NFC normalization, a long label left unnormalized, the any-script and repeated-mark caps, and `pointPrompt`.
- `requestAttachment`, `createEpoch`, `userContent` and `ipcErrorMessage` in `tests/message-content.test.ts`, and the AG-UI tests that keep the screenshot ID on its image part: `RunAgentInputSchema` in that file and in `tests/codex.test.ts`, and a real `KiteCodexAgent.runAgent` round trip.
- A real `agent/run` request in `tests/runtime-e2e.test.ts`, sent over HTTP through the runtime `startRuntime` builds to a fake Codex CLI (`tests/fixtures/fake-codex.mjs`): a screenshot attached with `userContent` reaches the CLI as its one `--image`, with its note in the prompt; an image without an ID gets the unreferenced note; and two images keep their order. It runs offline, with telemetry off, Intelligence unconfigured and every connection off 127.0.0.1 refused. The same file sends a run-scoped `agent/stop`, carrying `{runId}` as the renderer does, while a fake Codex CLI hangs until it is killed, and checks that the process dies and the run ends with RUN_ERROR `Run stopped`.
- The signal half of Stop in `tests/runtime-http.test.ts`: through the HTTP server `startRuntime` builds, a real MCP connection dropped while `point_on_screen`'s action is pending aborts the action's signal.
- The point pipeline in `tests/point-action.test.ts`: step order, the prompt and the signal passed with it, a decline with `DECLINED_MESSAGE`, a failed prompt, a request cancelled while the prompt is open, a failure in either resolve, a screenshot replaced while the prompt is open, which windows are concealed, a failed conceal that never shows the ring, covering windows restored even when the helper fails, a restore failure that doesn't replace the helper's error, one after the ring showed that doesn't fail the point, and a window destroyed while the ring shows.
- `coversPoint` and `conceal` in `tests/window-occlusion.test.ts`: each edge of the margin; restoring opacity and mouse handling; a destroyed window; fades that nest, restored in either order; transparent windows that never get `setIgnoreMouseEvents`; a failure while fading, including one after the opacity changed and one whose rollback fails too; a failed opacity restore that leaves the window ignoring the mouse, a failed un-ignore after the opacity came back, and a retry whose own fade fails, each followed by a cycle that restores the original opacity; and a window marked transparent while faded.
- The approval in `tests/approval.test.ts`: the exact `DECLINED_MESSAGE`, activation before the prompt, the exact options, the response, a failed message box, the signal passed to the box, a request cancelled before or while the box is open, a host hidden while it is open, cancellation reported ahead of a hidden host, "Allow once" approving even then, and which window `approvalHost` picks, when it must show the workspace, and that it refuses once the workspace is destroyed.
- The Electron pin in `tests/electron-version.test.ts`, which checks that the installed Electron is 44.4.5, because the window, approval and capture code relies on behavior of that version its public API doesn't guarantee. It lists each of those behaviors in one array, `RELIED_ON_BEHAVIOUR`, which its failure message is built from: Electron never calls `setIgnoresMouseEvents` when it creates a window; on macOS a parentless message box blocks, the async box attaches a sheet even to a hidden or minimized parent, hiding a window ends its sheet, and the box ignores `title`; Return and Escape are bound in a set order; a sheet ended from code, by hiding its host or by an aborted signal, resolves as Cancel on a later task; the `hide` event also comes from occlusion; `Focus()` does nothing on a window that isn't visible, and `IsVisible()` is false while a window is occluded or minimized; and a 2x `NativeImage` keeps its scale factor through `resize()`. It checks the version, not the behavior.
- The helper failure table in `tests/helper-result.test.ts`, which runs real processes for a missing, non-executable and unrunnable helper, a timeout and too much output, checks each row's message word for word, including the `npm run build:native` fix that a missing helper and a failure with no reason name, names `SIGTRAP`, `SIGSEGV`, `SIGSYS`, `SIGXCPU` and `SIGEMT` as crashes and `SIGKILL` and `SIGTERM` as stops, and checks that no error keeps a `cause`; the scan that keeps every `exec(helper` call in `electron/main.ts` inside `runHelper(`, never calls `execFile` directly and never runs the helper synchronously; and the check that each `helperStatus` string is a status event in `native/Recorder.swift` and isn't spelled out in `electron/main.ts`.
- The doc contract in `tests/doc-contract.test.ts`: this spec quotes every message listed under **Messages**, with the refusals in the order the code checks them. The code produces each message itself, with fakes where it would need Electron or a process: the capture's errors come from `captureScreenshot`, and the helper's from `runHelper` given failures shaped the way Node reports them. The open-app prompt and the footer, which it can't capture through fakes, are checked against the source of `electron/main.ts` and `src/Assistant.tsx`. Outside the **Messages** and **Tests** sections the spec states the 10-minute age, the 16 most recent captures and the 1920 px cap, and the README states the first two; and it gives `RING_MARGIN` as 32 pt.

**Verification.** A live check with Screen Recording and a model key: attach a screenshot and ask the agent to point at something far from the display's top-left corner, such as a Dock icon at the bottom-right or the menu-bar clock at the top-right. A scale error grows with the distance from that corner, so a target near it would hide one. OpenMuse should come to the front with the approval as a sheet on the companion chat or the workspace, with the agent's label in its detail and Cancel as its default, and Escape should decline it, telling the agent `The user declined. Don't retry unless they ask.`. Ask again and choose "Allow once", and the ring should land on the target. The built-in 1512×982 display is captured 1:1, which doesn't exercise the scaling, so if an external display wider than 1920 points is available, repeat the check with it as the main display, where the capture is scaled. Task 5 of the plan also covers the prompt's host, a minimized workspace, OpenMuse hidden with Command-H, a prompt closed by hiding the chat, Stop closing the prompt, and a click inside the ring over the chat.

## 2. AGENTS.md

Clicky keeps one agent-facing document with architecture, a key-files table, build gotchas and rules for keeping it current; its `CLAUDE.md` is a symlink to it. This repo has none, and its gotchas are spread across the README and `docs/verification.md`.

Add `AGENTS.md` and a `CLAUDE.md` symlink covering:

- what the app is;
- process architecture: Electron main, the four renderer windows, the Swift JSONL helper, the loopback runtime with MCP, the Codex adapter, Intelligence;
- the commands;
- a key-files table with line counts;
- conventions:
  - check the sender and main frame on every IPC call, then validate its arguments with zod;
  - approve native actions;
  - keep keys out of renderers;
  - record privacy boundaries;
  - no mocked success;
  - no silent fallback engine;
- gotchas:
  - ad-hoc rebuilds reset macOS permission grants;
  - the Documents-folder permission prompt can block startup;
  - rebuild the helper after Swift changes;
  - packaged versus development permission identity;
  - identifiers that must not change;
- rules for keeping it current.

Each later PR updates it.

## 3. Capture every display and leave our windows out

After PR 1, a capture makes the visible workspace, pet, chat and notch windows transparent, waits 200 ms, and captures only the primary display. Clicky uses ScreenCaptureKit to leave its own windows out of the image and captures every display, putting the one under the cursor first. PR 3 does the same: it excludes our windows from the capture instead of making them transparent.

- Add a helper command `--capture <outDir> <displayId>:<width>x<height>...`.
  - It uses `SCScreenshotManager` (macOS 14+; `#available` check, with ScreenCaptureKit linked) and leaves out every window belonging to the parent Electron process.
  - It writes private PNGs and prints one JSON line per display: `{kind:"capture", displayId, path, width, height}`.
  - It reports an error when a display is missing or Screen Recording is denied.
- The main process computes each display's target size with PR 1's sizing, calls the helper with a 10-second timeout, and measures and registers every image. The display under the cursor comes first.
- It falls back to PR 1's conceal, capture and restore path, now for all displays, only when the capture command is unavailable: on macOS 13, or with a helper built without the command, which answers `Unknown argument`. It never falls back when the helper reports a real error, such as denied Screen Recording or a missing display; it shows that error instead. The fallback is labeled in the result so the UI can say it happened.
- `screenshot()` returns up to four attachments. The composer shows and removes them one at a time. Each image note says which display the pointer was on. The Codex instructions say the first screenshot is the display under the pointer.
- Tests: parsing the helper's output, ordering, falling back only when the command is unavailable and never on a helper error, per-display sizes, removing attachments, notes for several images.
- Verification: two displays, a capture with no window flicker, and a ring on the secondary display.

## 4. Point at controls by their Accessibility label

Clicky's pointing comes only from the model reading pixels. Its more precise computer-use detector (`ElementLocationDetector.swift`) is never called. This app already records the Accessibility role and label of every click, for example `Click: AXButton · Export`.

- Add a helper command `--point-element <app> <role|*> <label>`.
  - It finds the running app by bundle ID or name, skipping our own process.
  - It searches that app's windows (focused window first) and its menu bar, breadth first, capped at 4,000 elements, depth 30 and 2 seconds.
  - It skips secure text fields and their contents, and never reads values.
  - It matches the label against title or description: exact first, then contained. Case and whitespace are ignored, and a trailing ellipsis is dropped.
  - It keeps only visible, non-empty frames and draws a highlight around the best match.
  - It reports only the matched role, label and center, plus the number of matches.
- MCP tool `point_at_control({app, label, role?})`.
  - Approval text keeps PR 1's rule that the message holds no model text, and `app` comes from the model just as `label` does. The message is fixed, `The agent wants to show a pointer in an app`, and each thing the model supplied goes on its own attributed line in the detail: `The agent says the app is: <app>` and `The agent says it points at: <label>`. The message may name the app only if OpenMuse resolves it before asking and uses the name macOS reports for the running app, never the model's text.
  - Guided-skill instructions prefer it over pixel pointing.
  - Arguments are validated: the app name is at most 100 characters, the label at most 120, and the role matches `^AX[A-Za-z]{2,40}$`.
- Privacy: this reads the named app's Accessibility tree outside a recording, but only after approval, only for that app, and only to find one control. The README boundary text says so.
- Tests: the tool schema, approval text, argument building (no shell), and the protocol schema for helper output.
- Verification:
  - the Finder File menu, with the terminal's Accessibility permission;
  - a recorded skill step pointed at in its app.

## 5. Hold ctrl+option to ask by voice (decisions needed)

Recommended design:

- **Hotkey:** a long-running helper mode `--voice <dir>` with a listen-only CGEvent tap. It turns itself back on when macOS disables it.
  - Pressing Control+Option alone starts it; releasing either key ends it.
  - Any other key pressed during the hold cancels it, so real ctrl+option shortcuts still work.
  - It is off while VoiceOver is running, because VoiceOver uses those keys.
- **Recording:** AVAudioEngine records 16 kHz mono audio to a private WAV file.
  - It reports levels about 15 times a second for the pet's waveform.
  - Recordings under 300 ms are ignored, and recording stops at 60 seconds.
- **Transcription:** the runtime sends the WAV to OpenAI `gpt-4o-transcribe` with the session key.
  - The request includes a vocabulary prompt: approved skill names, the frontmost app's name, "OpenMuse", "Codex".
  - It times out after 20 seconds.
- **Where the question goes:** the transcript goes to the pet chat in floating placement, or to the workspace chat in notch placement.
- **Faster turns:** voice turns ask Codex for lower reasoning effort and a short plain-speech answer.
- **Setup:**
  - Microphone permission joins `permissions()` (helper `--request-microphone`), and `NSMicrophoneUsageDescription` is added to the app's Info.plist.
  - Settings gets a Voice section, and onboarding gets an optional Microphone step.
  - Voice is opt-in (`voice: false` by default in preferences).

Decisions:

1. Does holding the key include the screen automatically? Today screenshots go only when attached, a stated privacy rule. Without the screen, "where's Export?" can't be answered. Recommendation: yes, capture when the key goes down, show a "screen included" mark while listening, and add a setting to turn it off.
2. Should voice turns run Codex at low reasoning effort? Recommendation: yes; high effort is built for multi-step file work and would feel slow spoken.

## 6. Speak replies to voice questions (decision needed)

Codex sends each agent message whole at the end, not as a stream. So the reply is split into sentences. The first sentence is synthesized and played while the rest are synthesized.

- Voice: OpenAI `gpt-4o-mini-tts` with the session key.
- Markdown is stripped before speaking.
- Audio plays in the chat window.
- Pressing the hotkey again, or sending a new message, stops playback.

Decision 3: speak only when the question was spoken? Recommendation: yes, with a Settings toggle.

## Out of scope

Streaming transcription, on-device Apple Speech, a configurable hotkey, sound effects, analytics, and a proxy that ships keys for end users. If a keyless build is ever needed, the proxy must authenticate each install and fix the model and limits on the server. Clicky's proxy forwards any request with the owner's key.
