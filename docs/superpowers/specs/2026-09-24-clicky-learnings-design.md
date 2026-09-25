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

- Every desktop action still needs the native "Allow once" approval. Pointing does not click or type.
- Model and Intelligence keys stay in the Node runtime. Nothing new reaches a renderer or a Codex shell.
- A failure names its real cause. Never mock success or say "out of credits" (Clicky plays that for every error).
- No PR in this stack adds analytics or sends transcripts anywhere new; Clicky sends full transcripts and replies to PostHog. The CopilotKit runtime's built-in usage telemetry predates this stack and is out of its scope.
- Permissions are read live, never cached as a boolean (Clicky caches Screen Recording after one capture).
- The Swift helper stays the only native macOS integration process (the bundled Codex CLI is also native, but it runs the agent), and each new capability is a separate command in its JSONL protocol.
- `com.kite.sprite`, `Application Support/Kite`, the `kite:` IPC namespace and `KITE_*` variables stay as they are.

## 1. Point where the model looked

**Problem.** `point_on_screen` takes global screen coordinates, but the model only sees a thumbnail of the primary display capped at 1440×900. It is never told the thumbnail's size, and nothing converts image pixels to screen points. On a 1512×982 display the thumbnail is about 1386×900, so every point lands about 8% toward the top-left.

**Codex resizing.** Codex 0.156.1 re-encodes a prompt image unless its longest side is at most 2048 px and it covers at most 2,500 tiles of 32×32 px (`codex-rs/utils/image`, `PromptImageMode::HIGH_DETAIL`). When it resizes, it may add a developer note giving the new size. Either way the model's pixels would no longer match the size we state. So `captureSize` sizes captures to pass through untouched:

- Keep the display's aspect ratio.
- Never go above the display's size in points; 1:1 when it fits, so one image pixel is one screen point.
- Longest side at most 1920 px.
- Tile count within 2,500.

A 1512×982 display is captured at 1512×982, and a 2560×1440 display at 1920×1080.

**Contract.**

1. **Capture.** The screenshot handler in `electron/main.ts` captures only the primary display; PR 3 handles every display. In order, it:
   - checks Screen Recording permission, read live from the helper;
   - fades out every visible OpenMuse window instead of hiding it: `conceal()` sets the window's opacity to 0 and makes it click-through;
   - waits 200 ms, then captures through `desktopCapturer` at `captureSize`;
   - takes only the source whose `display_id` matches, with no fallback to another source, because an image of the wrong display would put the pointer in the wrong place; an empty thumbnail is an error too;
   - measures the PNG by its header in `fitThumbnail` instead of trusting the requested size. A thumbnail larger than the target, for example a 2x one, is rebuilt from its own pixels and resized to the target, and an image still over the Codex limits is an error;
   - reads the display again, and fails if it is gone or its bounds changed during the capture;
   - registers the capture with `registry.add`, which validates its dimensions and bounds.

   The `restore()` that `conceal()` returns runs in `finally`. Fades nest per window, so a window gets its opacity back and stops ignoring clicks only once every overlapping fade covering it (including one from the pointer's own conceal in `electron/point-action.ts`) has ended. Concurrent capture calls share one in-flight capture, so a second click can't capture the windows the first is still restoring.

2. **Registry.** The registry is in memory and keeps the 16 most recent captures as `{id, displayId, label, bounds, width, height, capturedAt}`. Each entry and its bounds are frozen, so they can't change after the fact. IDs are `shot_` plus 8 hex characters (32 random bits, for example `shot_1a2b3c4d`), so an ID from an earlier session is vanishingly unlikely to match a new capture.

3. **Attachment.** The screenshot IPC call returns `{id, label, width, height, dataUrl}`, and `userContent` puts the ID on the AG-UI binary part's `id`. It survives only because `KiteCodexAgent` reports AG-UI 0.0.59, the `maxVersion` it inherits from `@ag-ui/client`; the 0.0.47 compatibility middleware would rebuild binary parts without it. Two tests pin this: `tests/message-content.test.ts` parses the content with `RunAgentInputSchema`, and `tests/codex.test.ts` runs a real `KiteCodexAgent.runAgent` round trip. A new conversation clears the attachment, and fresh requests (**Record to skill** and **Use this skill**) don't send it. The footer reads "Screenshots shared when sent".

4. **Notes.** The Codex adapter adds a note for each image and names the image by position, for example `Image 1 in this message is screenshot shot_1a2b3c4d of Built-in Retina Display, 1512×982 pixels`. Position is used because the Codex SDK joins every text part into one prompt and passes images separately, in order. The wording is written on the server, so neither the renderer nor the AG-UI and Intelligence thread message carries prompt text, though the Codex session transcript does keep the notes. The note is chosen in this order:
   1. no ID: unreferenced;
   2. an ID that isn't registered: unknown;
   3. a PNG whose size differs from the registered size: mismatched;
   4. a capture that isn't fresh (`isFresh`): stale;
   5. otherwise the describing note, the only one that offers pointing.

   Before its note, each image is checked, and each problem fails the run with its own error naming the image number: not a PNG, no data, over 12 MB, or an invalid PNG. The instructions tell the model to pass the screenshot ID, a short label naming the target, and x, y in that screenshot's pixels. When the prompt is rebuilt from history because no native thread was saved, earlier messages that had images keep their text, with `[image omitted]` in place of each image.

5. **Refusals.** `point_on_screen` takes `{screenshotId, x, y, label}`, with x and y in the image's pixels. The main process snaps the point to its pixel and converts that pixel's center to global screen points. `resolvePoint` and `screenPoint` refuse the point when:
   - the ID is unknown (the message names the ID);
   - the capture is more than 10 minutes old;
   - the capture time is in the future, because the clock moved back;
   - the display is gone;
   - the display changed position or resolution;
   - the point is outside the image (the message gives the image's size, so the model can retry).

   The point is checked when the model asks and again after "Allow once", because the display can change or the capture expire while the prompt is open. Only a clock that moved back to before the capture time is caught; other clock shifts go unnoticed and only change the capture's apparent age. Each refusal except the last tells the model to ask the user for a new screenshot.

6. **Label.** The approval prompt shows the label verbatim, so it is trimmed, must be 1 to 60 characters long (zod counts code points), and must pass four rules, checked in this order, each with its own message (`server/point-schema.ts` has the exact rules and messages):
   1. no `\p{C}`, `Zl` or `Zp` character, except ZWNJ and ZWJ;
   2. no known blank character, such as a Hangul filler or the Braille blank;
   3. no run of two or more ZWNJ/ZWJ, and no run of three or more combining marks;
   4. at least one letter or number.

   The rules are refinements rather than `.regex()`, because a published JSON Schema pattern has no `u` flag.

7. **Approval.** `askApproval` (`electron/approval.ts`) shows a parentless alert, and activates OpenMuse first (`app.focus({ steal: true })`) because that alert would not bring it forward on its own. Its title is "OpenMuse wants to take an action", and its buttons are Cancel and "Allow once". Cancel is both the default and the cancel button, so a Return pressed while typing declines. For a point, OpenMuse writes the message, `Show a pointer on <display>`, and the model's label goes on its own attributed line in the detail: `The agent says it points at: <label>`.

8. **Ring.** `performPointAction` (`electron/point-action.ts`) resolves the point, builds the prompt, asks for confirmation (a decline fails with "User declined action"), and resolves again. It then fades out each visible OpenMuse window whose bounds, grown by `RING_MARGIN` (32 pt: the ring's 24 pt radius plus 8 pt of slack), contain the point (`coversPoint`), and runs the helper's `--point`. The helper draws the ring at screen-saver level, above our windows, so only the target needs clearing. The windows are restored in `finally`.

9. **Helper.** Every one-shot helper call goes through `runHelper` (`electron/helper-result.ts`), and a test in `tests/helper-result.test.ts` scans `electron/main.ts` to keep each `exec(helper` inside it. `runHelper` reports the helper's own error line, or names the cause (a timeout, a signal, a missing helper, an exit code and so on) without the helper's path, arguments or stderr. Only `--point` and `--open-app` must also print their success status line. Calls time out after 15 s, except `--open-app` at 60 s, because a first launch can wait on Gatekeeper.

**Messages.** Each message below is quoted verbatim from the code, with placeholders for its values. `tests/doc-contract.test.ts` checks that this spec quotes every one.

- Refusals, in the order they are checked:
  - `No screenshot <id> is available; it may have been replaced by newer captures or the app restarted. Check the id, or ask the user to attach a new screenshot.`
  - `That screenshot is more than 10 minutes old. Ask the user to attach a new one.`
  - `That screenshot's capture time is in the future, so the clock changed since it was taken. Ask the user to attach a new one.`
  - `<display> is no longer connected. Ask the user to attach a new screenshot.`
  - `<display> changed position or resolution since the screenshot. Ask the user to attach a new one.`
  - `(<x>, <y>) is outside the <width>×<height> screenshot.`
- Image notes, in the order they are chosen:
  - `Image <n> in this message has no screen reference, so point_on_screen cannot target it.`
  - `Image <n> in this message names a screenshot OpenMuse doesn't have, so point_on_screen can't target it. Ask the user to attach a new one if you need to point.`
  - `Image <n> in this message doesn't match the screenshot it names, so point_on_screen can't target it. Ask the user to attach a new screenshot if you need to point.`
  - `Image <n> in this message is a screenshot that is too old to point at, or whose capture time is unknown. Ask the user to attach a new one if you need to point.`
  - `Image <n> in this message is screenshot <id> of <display>, <width>×<height> pixels. To point at something in it, call point_on_screen with screenshotId "<id>", a short label, and x, y in that image's pixels (origin at the top-left, x rightward, y downward).`
- The approval alert: the title `OpenMuse wants to take an action`, the buttons `Cancel` and `Allow once`, and for a point the message `Show a pointer on <display>` with the detail `The agent says it points at: <label>`.

**Tests.**

- Capture sizing: 1:1, larger displays, ultrawide, portrait, and cases limited by the tile budget; the budget's edge values; and the Codex SDK version the limits were checked against.
- PNG header parsing, `exceeds`, and `fitThumbnail`: a fitting thumbnail is left alone, a 2x one is resized once, the measured size is reported, and an image still too large is refused.
- Registry IDs, eviction, freezing, the default of 16, and limit and dimension validation.
- Pixel-to-point conversion, including a display with a negative origin and fractional points; `sameBounds`; and `isFresh` at the 10-minute boundary and after a clock rewind.
- The refusal state table in `tests/screenshots.test.ts`: `resolvePoint` and `screenPoint` give each cause its own message.
- The note state table in `tests/codex.test.ts`: each note state through `CodexRunner`, plus an invalid PNG, recovered history and the updated instructions.
- The tool schema, and the label sweep across Unicode categories together with `pointPrompt`.
- `userContent`, and the two AG-UI tests that keep the screenshot ID on its image part.
- The point pipeline in `tests/point-action.test.ts`: step order, the prompt, a decline, a failure in either resolve, and covering windows restored even when the helper fails.
- `coversPoint` and `conceal` in `tests/window-occlusion.test.ts`.
- The approval alert in `tests/approval.test.ts`: activation before the alert, the exact options, and the response.
- The helper failure table in `tests/helper-result.test.ts`, the scan that keeps every `exec(helper` call in `electron/main.ts` inside `runHelper(`, and the status strings in `native/Recorder.swift`.
- The doc contract in `tests/doc-contract.test.ts`: the messages above, and the limits this spec and the README state.

**Verification.** A live check with Screen Recording and a model key: attach a screenshot and ask to point at the Apple menu. OpenMuse should come to the front with the approval alert, Cancel as its default. Choose "Allow once", and the ring should land on the Apple menu.

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

After PR 1, a capture fades out the visible workspace, pet, chat and notch windows, waits 200 ms, and captures only the primary display. Clicky uses ScreenCaptureKit to leave its own windows out of the image and captures every display, putting the one under the cursor first. PR 3 does the same: it excludes our windows from the capture instead of fading them out.

- Add a helper command `--capture <outDir> <displayId>:<width>x<height>...`.
  - It uses `SCScreenshotManager` (macOS 14+; `#available` check, with ScreenCaptureKit linked) and leaves out every window belonging to the parent Electron process.
  - It writes private PNGs and prints one JSON line per display: `{kind:"capture", displayId, path, width, height}`.
  - It reports an error when a display is missing or Screen Recording is denied.
- The main process computes each display's target size with PR 1's sizing, calls the helper with a 10-second timeout, and measures and registers every image. The display under the cursor comes first.
- On macOS 13, or if the helper fails, it falls back to PR 1's fade, capture and restore path, now for all displays. The fallback is labeled in the result so the UI can say it happened.
- `screenshot()` returns up to four attachments. The composer shows and removes them one at a time. Each image note says which display the pointer was on. The Codex instructions say the first screenshot is the display under the pointer.
- Tests: parsing the helper's output, ordering, choosing the fallback, per-display sizes, removing attachments, notes for several images.
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
  - Approval text uses PR 1's attributed format: OpenMuse writes a fixed message, `Show a pointer in <app>`, and the model's label goes on its own line in the detail: `The agent says it points at: <label>`.
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
