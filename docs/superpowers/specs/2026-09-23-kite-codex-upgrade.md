# Kite: draggable sprite and Codex agent

## Outcome

Kite remains a macOS companion with cross-app recording, record-to-skill, AG-UI, and CopilotKit Intelligence. Upgrade its execution engine to Codex and make the sprite itself draggable.

## Backend choice

Use the official TypeScript Codex SDK and its packaged CLI. This fits Electron's existing Node runtime and provides a multi-step agent with shell commands, file edits, search, streaming activity, cancellation, and resumable conversations. The Python Agents SDK sandbox option is viable but introduces a Python service and sandbox lifecycle into the desktop distribution. Do not build both engines.

## Sprite

Dragging the visible sprite moves the companion window. Use a movement threshold to distinguish dragging from clicking; a click still opens the workspace. Clamp the final position to an available display's work area and persist the position. Recover to a visible location after monitor removal. The speech bubble and stop-recording button retain their actions. Test click versus drag, display boundaries, and restored position.

## Agent runtime

Replace BuiltInAgent with a custom AG-UI adapter around the official Codex SDK. Translate assistant messages, command and file activity, completion, cancellation, and failures into AG-UI events. Keep one resumable Codex thread per Kite conversation, with a separate Kite-owned state directory. Never silently fall back to the old engine when Codex fails.

Expose a workspace picker. Shell commands and file edits operate in the selected workspace with Codex workspace-write sandboxing, rather than an unrestricted home directory. Show model/backend, workspace, current activity, errors, and a Stop control. Keep credentials in process memory and pass only the required environment to the child process. Do not inherit unrelated credentials or the user's Codex configuration unintentionally.

## Desktop and learning tools

Provide a local authenticated MCP bridge for approved local skills and desktop actions. Keep native action approvals. Include approved local skill guidance and published Intelligence skills in agent context or explicit tool retrieval; preserve the stable desktop-workflows container and completed-run ingestion through CopilotRuntime. Reviewed recording evidence remains the input for skill generation. Drafts still require explicit approval.

The first upgrade provides real multi-step file and shell work, screenshot understanding, and the existing open-app/point tools. Arbitrary cross-app click/type automation requires an additional desktop execution layer and is not implied by switching the model harness.

## Validation

Unit-test event translation, cancellation, failures, thread separation, secret exclusion, and position calculations. Verify real Codex execution in a disposable workspace: create a file, read it back, revise it, and report the verified result. Verify record-to-skill still produces a draft through AG-UI and that Intelligence remains configured for the correct container. Test dragging in the packaged app. Report any unavailable credential or macOS permission as an unverified boundary.
