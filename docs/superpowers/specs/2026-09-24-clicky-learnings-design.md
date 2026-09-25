# Clicky learnings: PR stack design

Approved direction on September 24, 2026: turn the lessons from [farzaa/clicky](https://github.com/farzaa/clicky) into a plan and ship it one PR at a time. Leave out the capybara-as-pointer flight animation for now.

Clicky is a MIT-licensed Swift menu-bar companion. You hold ctrl+option and talk; it screenshots every display, sends the transcript and images to Claude, speaks the reply and flies a cursor to whatever it mentions. Its public source (last commit April 27, 2026) shows how to hit the target the model saw and how to do hold-to-talk voice. It also shows several things this app should not copy.

## Stack

Each PR is based on the previous one. The first is based on `jerel/kite-os-learning` (open PR #1), because the pet chat and notch windows exist only there. Every PR must pass `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run build:native` and `npm run build` on its own.

| #   | Branch                              | Change                                           | Needs                       |
| --- | ----------------------------------- | ------------------------------------------------ | --------------------------- |
| 1   | `jerel/pointer-screenshot-contract` | Point where the model looked                     | PR #1                       |
| 2   | `jerel/agents-md`                   | AGENTS.md for coding agents                      | 1                           |
| 3   | `jerel/native-display-capture`      | Capture every display without hiding our windows | 2                           |
| 4   | `jerel/point-at-control`            | Point at controls by their Accessibility label   | 3                           |
| 5   | `jerel/hold-to-talk`                | Hold ctrl+option to ask by voice                 | 4, plus the decisions below |
| 6   | `jerel/spoken-replies`              | Speak replies to voice questions                 | 5, plus the decisions below |

Deferred: the capybara flying to its target (a click-through overlay at screen-saver level), dropping the approval prompt for pointing, and an onboarding demo that points at something on the user's screen. The demo is only worth building once the flight exists, and it would need a direct vision call outside Codex.

## Boundaries every PR keeps

- Every desktop action still needs the native "Allow once" approval. Pointing does not click or type.
- Model and Intelligence keys stay in the Node runtime. Nothing new reaches a renderer or a Codex shell.
- A failure names its real cause. Never mock success or say "out of credits" (Clicky plays that for every error).
- Nothing is sent to analytics. Clicky sends full transcripts and replies to PostHog.
- Permissions are read live, never cached as a boolean (Clicky caches Screen Recording after one capture).
- The Swift helper stays the only native process, and each new capability is a separate command in its JSONL protocol.
- `com.kite.sprite`, `Application Support/Kite`, the `kite:` IPC namespace and `KITE_*` variables stay as they are.

## 1. Point where the model looked

**Problem.** `point_on_screen` takes global screen coordinates, but the model only sees a thumbnail of the primary display capped at 1440×900. It is never told the thumbnail's size, and nothing converts image pixels to screen points. On a 1512×982 display the thumbnail is about 1386×900, so every point lands about 8% toward the top-left.

**Codex resizing.** Codex 0.156.1 re-encodes a prompt image unless its longest side is at most 2048 px and it covers at most 2,500 tiles of 32×32 px (`codex-rs/utils/image`, `PromptImageMode::HIGH_DETAIL`). When it resizes, it may add a developer note giving the new size. Either way the model's pixels would no longer match the size we state. So captures are sized to pass through untouched:

- Keep the display's aspect ratio.
- Never go above the display's size in points; 1:1 when it fits, so one image pixel is one screen point.
- Longest side at most 1920 px.
- Tile count within 2,500.

If a capture comes back larger than its target, for example a 2x thumbnail, it is resized to the target. A 1512×982 display is captured at 1512×982, and a 2560×1440 display at 1920×1080.

**Contract.**

1. The main process captures a display and measures the PNG it produced by reading the header, instead of trusting the requested size.
2. It registers `{id, displayId, label, bounds, width, height, capturedAt}` in an in-memory registry that keeps the 16 most recent captures. IDs look like `shot_1a2b3c4d`, so an ID from an earlier session is vanishingly unlikely to match a new capture.
3. The screenshot IPC call returns `{id, label, width, height, dataUrl}`. The renderer puts the ID on the image part (AG-UI binary content allows `id`).
4. The Codex adapter adds a note for each image and names the image by position, for example `Image 1 in this message is screenshot shot_1a2b3c4d of Built-in Retina Display, 1512×982 pixels`. Position is used because the Codex SDK joins every text part into one prompt and passes images separately, in order. The wording is written on the server, so neither the renderer nor the stored thread message carries prompt text. Images without a known ID get a note saying they can't be pointed into.
5. `point_on_screen` takes `{screenshotId, x, y, label}`, with x and y in the image's pixels. The main process converts the center of that pixel to global screen points. It refuses when:
   - the ID is unknown;
   - the capture is more than 10 minutes old;
   - the display is gone, or its bounds have changed since the capture;
   - the point is outside the image.

   Each refusal names its cause. When the screenshot can no longer be used (unknown ID, too old, display gone or changed), it tells the model to ask for a new one; a point outside the image gives the image's size so the model can retry. The label is one line of 1 to 60 characters with no control or format characters, because it is shown verbatim in the approval prompt. The approval prompt now reads `Point at "<label>" on <display>` instead of raw coordinates.

**Capture target.** This PR still captures only the primary display; PR 3 handles every display. It also removes the silent fallback to the first capture source: an image of the wrong display would put the pointer in the wrong place.

**Tests.**

- Capture sizing: 1:1, larger displays, ultrawide, portrait, and cases limited by the tile budget.
- Budget edge values.
- PNG header parsing.
- Registry IDs and eviction.
- Pixel-to-point conversion, including a display with a negative origin.
- Every refusal case.
- The tool schema.
- The Codex prompt: a note before a known image, the fallback note for an unknown one, and the updated instructions.

**Verification.** A live check with Screen Recording and a model key: attach a screenshot, ask to point at the Apple menu, and approve. The ring should land on it.

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

## 3. Capture every display without hiding our windows

Today a capture hides the workspace, pet, chat and notch windows, waits 200 ms, and captures only the primary display. Clicky uses ScreenCaptureKit to leave its own windows out of the image and captures every display, putting the one under the cursor first.

- Add a helper command `--capture <outDir> <displayId>:<width>x<height>...`.
  - It uses `SCScreenshotManager` (macOS 14+; `#available` check, with ScreenCaptureKit linked) and leaves out every window belonging to the parent Electron process.
  - It writes private PNGs and prints one JSON line per display: `{kind:"capture", displayId, path, width, height}`.
  - It reports an error when a display is missing or Screen Recording is denied.
- The main process computes each display's target size with PR 1's sizing, calls the helper with a 10-second timeout, and measures and registers every image. The display under the cursor comes first.
- On macOS 13, or if the helper fails, it falls back to the current hide, capture and restore path, now for all displays. The fallback is labeled in the result so the UI can say it happened.
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
  - Approval text: `Point at "<label>" in <app>`.
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
