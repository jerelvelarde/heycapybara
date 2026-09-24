# Floating companion chat

Status: design approved by the user on 2026-09-24. Implementation is pending review of this written spec.

## Behavior

The default desktop companion is the floating capybara. Clicking the sprite opens a compact chat panel beside it; clicking again closes the panel. Dragging the sprite moves it without opening chat. The Kite choice remains available. The notch placement remains optional for people who explicitly selected it, but new installs and legacy preferences without an explicit placement start with the floating sprite. A fresh floating install does not show the notch tour.

The panel has a message history, text composer, send/stop controls, connection and error states, and an **Open workspace** action for longer tasks and settings. The panel uses the existing AG-UI/Codex backend and the same model-key requirement as the workspace. It has its own conversation thread; switching to the full workspace does not silently claim to show the same transcript. The hidden panel stays mounted while the app runs so closing and reopening it preserves the current conversation. No microphone, transcription, or speech output is part of this version.

## Windows and data flow

Keep the draggable sprite in its existing transparent native window. Add a separate small chat window managed by Electron main. The sprite sends a narrow toggle request over preload IPC. Main positions the chat next to the sprite, moving it to the opposite side or clamping it inside the display work area when needed. Moving the sprite or changing displays repositions the open chat; the chat never changes the persisted sprite anchor. The chat window hides instead of being destroyed, preserving its renderer conversation state.

Render the chat with a dedicated compact component and the existing CopilotKit provider/runtime URL and token. Agent requests flow through AG-UI to the current Codex backend. Main validates IPC senders; the renderer cannot supply arbitrary window coordinates or choose a different agent endpoint. The workspace remains available from the chat, tray, and shortcut. The current user's saved companion placement should be switched to floating once the implementation is verified, without changing their mascot selection or library.

## Recovery and verification

If the agent is connecting, the composer indicates that state. Missing model credentials or a failed run show an actionable error and a way to open workspace settings. A failed native window action is surfaced to the user. The panel does not capture screenshots or start recording on its own.

Verify preference migration, click versus drag, panel positioning near screen edges and after display changes, chat hide/reopen persistence, and a packaged-app smoke path through the visible composer. Run formatter, lint, typecheck, tests, build, and package/signing checks. Live model use is verified only when a configured key is available; local tests do not claim cloud success.
