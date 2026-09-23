# Kite

A macOS desktop companion with an AG-UI agent and a record-to-skill workflow. Electron hosts the floating companion and workspace; a Swift helper observes activity across native applications during explicitly started recordings.

## Run

Requires macOS (Apple Silicon), Node 22+, and Xcode Command Line Tools (`xcode-select --install`).

```sh
npm ci
npm run build:native
npm run dev
```

Use **⌘⇧K** to show/hide the workspace. Closing the workspace leaves the buddy and menu-bar item running. Quit from the Kite menu-bar item.

For a built application:

```sh
npm run build
npm start
# Optional unsigned .app in release/mac-arm64:
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

The CLI writes its own `.env` containing `CPK_INTELLIGENCE_API_KEY`. Kite loads `.env` in the process working directory. `link:environment` also stores a file-path reference in Kite’s local settings so the packaged app can find that same CLI-managed file when opened from Finder; it does not copy the credential. Keep it private and untracked. Supply the model API key in the process environment, preferably using a secret manager (`op run`). See `.env.example` for variable names; never put keys in frontend code.

- `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `GOOGLE_API_KEY`, matching `KITE_MODEL`.
- `KITE_MODEL` defaults to `openai/gpt-4.1`.
- `CPK_INTELLIGENCE_API_KEY` selects the Intelligence project.
- `CPK_INTELLIGENCE_LEARNING_CONTAINER_ID` defaults to `desktop-workflows`.

Create that stable container ID in your Intelligence project, enable skill delivery, and restart Kite. The Learning screen has a **Verify connection** button that checks the published snapshot endpoint. Keep the container focused on one family of workflows. Container selection remains constant for every run; changing configuration requires a restart and new threads.

The runtime routes the `default` agent to this container via `getLearningContainerId`. `BuiltInAgent.learnedSkills` uses the same client and container. Configured credentials are **not** proof of a working connection. To verify:

1. Generate a skill from reviewed recording evidence or send a guidance message.
2. Find the completed thread in Intelligence Rich Threads and confirm its container assignment.
3. Run Learning manually, or wait for its configured schedule and eligibility threshold.
4. Review insights, approve/publish a proposed skill, and ensure delivery is enabled.
5. Start a new Kite conversation. Confirm `copilotkit_load_skill` can load the published skill.

[Automatic Learning](https://docs.copilotkit.ai/learning) · [Skill delivery](https://docs.copilotkit.ai/intelligence/learned-skills)

## Record → skill → guidance

1. Name a workflow and start recording. Grant Accessibility when needed, then restart if macOS requests it.
2. Work in other applications. Kite captures app activation, clicks, accessible control labels, and keyboard shortcuts. Use the note field to explain intent or corrections.
3. Stop and review. Remove sensitive or unrelated events.
4. **Record to skill** sends the reviewed evidence to your model through AG-UI and, when configured, Intelligence. **Manual draft** creates an editable document from observations without any model request.
5. Edit the markdown and approve it. Approved local skills become available through `list_local_skills` and `load_local_skill`. Use the library's **Use this skill** to start guided execution. Export writes a portable `SKILL.md`.
6. Editing an approved skill as a draft removes approval until you approve it again.

Local skill approval is separate from Intelligence publication. This app does not invent an API for importing local drafts into the cloud skill registry. Intelligence learns from completed agent runs and publishes skills through its own review process.

## Desktop boundaries

- Observation occurs only between Start and Stop. Crash recovery closes unfinished sessions and never resumes capture automatically.
- Ordinary typed text, clipboard contents, and AXValue are not read. App/window/control labels can still contain private data. Recognized secure text fields are redacted, but applications vary in their accessibility metadata.
- Screenshots are attached explicitly to an agent message and never saved into the recording library. Sent screenshots may persist in your model provider or Intelligence thread.
- Agent tools can open installed applications and display a pointer after a native approval dialog. This release provides guided execution; it does not blindly replay clicks, type text, or run arbitrary shell commands.
- Voice recording/transcription, continuous video recording, and autonomous cross-app execution are not implemented.
- The local runtime binds to `127.0.0.1` on a random port, authenticates every request with a per-process token, and is intended for one local user. It is not a remotely hosted multi-user service.
- Local data is stored in `~/Library/Application Support/Kite/library` with private directory/file permissions. Deleting local data does not remove already-shared cloud threads.
- Development builds are unsigned. Distribution requires a stable signing identity, helper signing, notarization, and final macOS permission checks. The native helper currently targets Apple Silicon.

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
