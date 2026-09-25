# HeyCapybara · OpenMuse Desktop

An OpenMuse-inspired macOS desktop companion, developed in [jerelvelarde/heycapybara](https://github.com/jerelvelarde/heycapybara). The original [heykite](https://github.com/jerelvelarde/heykite) repository is preserved as the archive. This is a standalone contribution candidate, not an official OpenMuse release.

The default capybara companion uses OpenMuse’s original warm tan artwork, including its original face and proportions. Choose **Settings → Desktop companion → Kite** for the original sprite. Both choices share drag/click behavior, and your choice is remembered between launches. The interface keeps the original friendly layout with colors from [OpenMuse](https://github.com/CopilotKit/openmuse/blob/main/apps/mobile/src/ui.tsx).

A macOS desktop companion powered by the official Codex SDK, with AG-UI and a record-to-skill workflow. Electron hosts the floating sprite, compact chat, optional notch companion, and workspace; a Swift helper observes activity across native applications during explicitly started recordings.

## Run

Requires macOS (Apple Silicon), Node 22+, and Xcode Command Line Tools (`xcode-select --install`).

```sh
npm ci
npm run build:native
npm run dev
```

On first launch, OpenMuse shows the floating capybara. Grant Accessibility when you want to record workflows across apps; Screen Recording is optional and used only for screenshots you explicitly attach. The optional notch setup can be replayed from **Settings → Desktop companion** or the menu-bar item. **Open System Settings** opens the Accessibility pane directly and moves the app tile into a small helper near the bottom of the screen, so a native permission alert does not block the drag. The outgoing tile can be dragged into **System Settings → Privacy & Security → Accessibility** in a packaged `.app`; click the tile or **Show in Finder** to drag it from Finder instead. If OpenMuse is already listed, toggle its permission off and on and restart rather than adding a duplicate. Development runs expose the Finder fallback but do not offer a valid `.app` bundle to drag.

Drag the sprite to move it; its position is remembered across launches and recovers when a display is removed. Hover to see the capybara greet you and reveal **Chat** and **Record** beneath it. Click the sprite or Chat to open a compact composer beneath the pet; the tray flips above it near the bottom of a display. Closing and reopening chat keeps the current conversation while the app runs. Record opens a small title form on the sprite tray, with Start and Stop controls there. **Workspace** in the tray opens the full workspace for settings and longer tasks; that workspace has its own conversation. Use **Settings → Desktop companion → Notch** if you prefer the notch placement. The capybara and Kite artwork choices work in either placement.

Use **⌘⇧K** to show/hide the workspace. Closing the workspace leaves the buddy and menu-bar item running. Quit from the OpenMuse Desktop menu-bar item.

For a built application:

```sh
npm run build
npm start
# Optional ad-hoc signed .app in release/mac-arm64:
npm run package
```

No API keys are required to record, review, manually draft, approve, or export a skill. Generated skills and agent guidance require a model API key. The browser URL alone is not the desktop application.

## Connect CopilotKit Intelligence

From this directory:

```sh
npx copilotkit@latest login
npx copilotkit@latest project select
npm run link:environment
```

The CLI writes its own `.env` containing `CPK_INTELLIGENCE_API_KEY`. OpenMuse loads `.env` in the process working directory. `link:environment` also stores a file-path reference in OpenMuse’s local settings so the packaged app can find that same CLI-managed file when opened from Finder; it does not copy the credential. Keep it private and untracked. For OpenAI, enter a key in **Settings → Model connection** for the current session; OpenMuse keeps it only in memory and clears it on quit. Alternatively, supply the model API key in the process environment, preferably using a secret manager (`op run`). See `.env.example` for variable names; never put keys in frontend code.

- `OPENAI_API_KEY` authenticates the Codex agent, or connect a session key in Settings.
- `KITE_MODEL` defaults to `gpt-5.4`, with high reasoning effort. An `openai/` prefix is accepted for existing configurations. Other providers are no longer supported by this backend.
- `CPK_INTELLIGENCE_API_KEY` selects the Intelligence project.
- `CPK_INTELLIGENCE_LEARNING_CONTAINER_ID` defaults to `desktop-workflows`.

Create that stable container ID in your Intelligence project, enable skill delivery, and restart OpenMuse. The Learning screen has a **Verify connection** button that checks the published snapshot endpoint. Keep the container focused on one family of workflows. Container selection remains constant for every run; changing configuration requires a restart and new threads.

The runtime routes the `default` agent to this container via `getLearningContainerId`. The authenticated local MCP bridge uses the same client and container to list and load published skills. It uses CopilotKit’s exported internal skill-registry adapter, so updates to CopilotKit require checking that interface. Configured credentials are **not** proof of a working connection. To verify:

1. Generate a skill from reviewed recording evidence or send a guidance message.
2. Find the completed thread in Intelligence Rich Threads and confirm its container assignment.
3. Run Learning manually, or wait for its configured schedule and eligibility threshold.
4. Review insights, approve/publish a proposed skill, and ensure delivery is enabled.
5. Start a new OpenMuse conversation. Confirm `load_learned_skill` can load the published skill.

[Automatic Learning](https://docs.copilotkit.ai/learning) · [Skill delivery](https://docs.copilotkit.ai/intelligence/learned-skills)

## Codex workspace execution

In **Settings → Codex agent**, choose a working folder. Codex can plan, search the web, read files, edit files, run shell commands, verify results, and continue the same conversation. The default is a private scratch folder under OpenMuse’s application data. Changing folders requires a new conversation. The activity panel shows commands, file changes, tool calls, and plan updates. **Stop agent** cancels the running Codex process.

OpenMuse uses Codex `workspace-write` sandboxing with shell network access disabled. Requests outside that boundary fail rather than escalate automatically. This limits writes; it is not a guarantee that all reads outside the selected folder are blocked. Native open-app and pointer actions retain their separate approval dialog. Codex uses an OpenMuse-specific home for session/config state and a separate shell home; unrelated process credentials are not inherited. Shell snapshots and login shells are disabled. API keys and the MCP bearer token are explicitly excluded from shell tool environments.

The Apple Silicon package includes the official Codex executable and its companion resources outside ASAR. No separate Codex installation is required. Codex transcripts and conversation mapping persist under `Application Support/Kite/agent`; API credentials remain session-only. Screenshot attachments are written to private temporary PNGs for the SDK and removed after the run, but Codex/model/Intelligence conversation histories can retain supplied content.

## Record → skill → guidance

1. Name a workflow and start recording. Grant Accessibility when needed, then restart if macOS requests it.
2. Work in other applications. OpenMuse captures app activation, clicks, accessible control labels, and keyboard shortcuts. Use the note field to explain intent or corrections.
3. Stop and review. Remove sensitive or unrelated events.
4. **Record to skill** sends the reviewed evidence to your model through AG-UI and, when configured, Intelligence. **Manual draft** creates an editable document from observations without any model request.
5. Edit the markdown and approve it. Approved local skills become available through `list_local_skills` and `load_local_skill`. Use the library's **Use this skill** to start guided execution. Export writes a portable `SKILL.md`.
6. Editing an approved skill as a draft removes approval until you approve it again.

Local skill approval is separate from Intelligence publication. This app does not invent an API for importing local drafts into the cloud skill registry. Intelligence learns from completed agent runs and publishes skills through its own review process.

## Desktop boundaries

- Observation occurs only between Start and Stop. Crash recovery closes unfinished sessions and never resumes capture automatically.
- Ordinary typed text, clipboard contents, and AXValue are not read. App/window/control labels can still contain private data. Recognized secure text fields are redacted, but applications vary in their accessibility metadata.
- Screenshots are attached explicitly to an agent message and never saved into the recording library. Sent screenshots may persist in your model provider or Intelligence thread.
- Agent tools can open installed applications and show a pointer on a spot in a screenshot you attached, after a native approval dialog on an OpenMuse window: the model gives pixel coordinates in that image, and OpenMuse converts them to screen points, sizing screenshots so Codex doesn't resize them. In this version, pointing uses screenshots of the primary display only. A point is refused, both when the agent asks and again after you approve, if the screenshot is no longer in memory (after a restart or 16 newer captures), is more than 10 minutes old counted from capture, has a capture time in the future because the clock moved back, or its display was disconnected, moved or changed resolution; a point outside the image is rejected too, so the agent can retry. While a screenshot is taken, OpenMuse's workspace, pet, chat and notch windows turn transparent, and while the ring shows, so do those that would cover the spot under it. Codex executes shell and file tasks in the selected workspace. Cross-app execution remains guided; desktop clicking and typing are not implemented.
- Voice recording/transcription, continuous video recording, and autonomous cross-app execution are not implemented.
- The local runtime binds to `127.0.0.1` on a random port, authenticates every request with a per-process token, and is intended for one local user. It is not a remotely hosted multi-user service.
- Local data is stored in `~/Library/Application Support/Kite/library` with private directory/file permissions. Deleting local data does not remove already-shared cloud threads.
- The packaged app is ad-hoc signed and its sealed bundle identity is verified during packaging. It is not notarized. Distribution requires a stable Developer ID signing identity, notarization, and final macOS permission checks. Ad-hoc rebuilds can require macOS permission approval again. The native helper currently targets Apple Silicon.

## Verification

```sh
npm test
npm run typecheck
npm run build:native
npm run build
npm run lint
npm run format:check
npm run smoke
# Optional: starts a brief real recording in a temporary test library:
npm run smoke:recording
# Read-only live delivery check after configuring credentials:
npm run verify:intelligence
```

See `native/README.md` for the native JSONL protocol and privacy behavior. Live model/Intelligence verification requires credentials and an enabled container; local tests do not claim cloud success.

## OpenMuse integration boundaries

The upstream app uses React Native; this prototype uses Electron with a Swift macOS recorder. A future upstream PR should package the recorder/companion as an optional desktop host and adapt its UI to upstream conventions. AG-UI, portable SKILL.md output and the Codex agent boundary are reusable. No upstream PR has been opened.

For existing installations, the bundle identifier `com.kite.sprite`, data directory `Application Support/Kite`, IPC namespace and `KITE_*` environment variables intentionally stay stable. Only display branding changes. Close the old Kite app before opening `release/mac-arm64/OpenMuse Desktop.app`; both use the same local library.
