# Floating Companion Chat Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Make the floating capybara the default and let a click open a persistent compact AG-UI chat beside it.

**Architecture:** Electron owns a separate hidden chat window anchored to the sprite. The renderer reuses the existing Assistant within its own CopilotKit provider, and narrow IPC toggles or hides the panel. Preference defaults change without overriding explicit prior selections.

**Tech Stack:** Electron, React, TypeScript, CopilotKit AG-UI, Node test, Playwright.

---

### Task 1: Defaults and placement geometry

**Files:** `electron/preferences.ts`, `server/runtime.ts`, `electron/companion-chat-position.ts`, `tests/preferences.test.ts`, `tests/companion-chat-position.test.ts`

- [x] Write tests for floating migration and edge-aware panel position.
- [x] Run tests to confirm the old behavior fails.
- [x] Implement defaults and pure positioning function.
- [x] Run focused tests.

### Task 2: Native chat window and secure IPC

**Files:** `electron/main.ts`, `electron/preload.ts`, `src/types.ts`, `src/Buddy.tsx`

- [x] Add a hidden persistent chat window, reflow it with sprite and display movement, and hide it on placement changes.
- [x] Allow only the sprite to toggle and only the chat window to close itself.
- [x] Open the chat on sprite or bubble click without treating a drag as a click.
- [x] Make the workspace optional at startup in floating mode.

### Task 3: Compact chat UI and docs

**Files:** `src/App.tsx`, `src/CompanionChat.tsx`, `src/styles.css`, `README.md`

- [x] Render a compact panel using the existing Assistant and CopilotKit runtime.
- [x] Provide Close and Open workspace actions, model error visibility, and capybara branding.
- [x] Update README behavior and shortcuts.

### Task 4: Verify and ship

**Files:** `scripts/smoke.mjs`

- [x] Exercise open, close, reopen, text draft persistence, and workspace action in packaged smoke.
- [x] Run format, lint, typecheck, tests, build, package, and smoke.
- [x] Switch current saved placement to floating, update and push PR, and inspect final diff.
