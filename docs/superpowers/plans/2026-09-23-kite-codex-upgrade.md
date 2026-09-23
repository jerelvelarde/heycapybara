# Kite Codex Upgrade Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the independent sprite task and reviews.

**Goal:** Ship a draggable companion and a Codex-backed AG-UI agent that can execute verified workspace tasks.

**Architecture:** Electron owns credentials, workspace selection, permissions and a local MCP endpoint. A custom AbstractAgent maps official Codex SDK events to AG-UI; CopilotRuntime continues Intelligence ingestion. Native companion dragging is independent of agent execution.

**Tech Stack:** Electron, React, TypeScript, @openai/codex-sdk, @ag-ui/client, CopilotKit, MCP.

## Tasks

- [ ] Sprite: add a focused `src/Buddy.tsx` component with pointer threshold, click suppression and drag IPC. Add `electron/buddy-position.ts` for clamping, display recovery and persisted placement. Test boundaries, monitor removal and threshold; manually verify dragging the packaged sprite. Keep main/preload integration changes small.
- [ ] Codex adapter: add `server/codex-agent.ts`; create/resume one SDK thread per conversation, map assistant text and tool activity to AG-UI, propagate AbortSignal, emit RUN_ERROR on failure. Add transcript/image conversion with private temporary files and cleanup. Unit-test failures, cancellation and thread isolation using an injected SDK runner.
- [ ] Tool bridge: add `server/tools.ts` implementing authenticated local MCP access to approved local skills, published Intelligence skills and existing native approved actions. Bind loopback only. Close transports with runtime. Test unauthenticated access and invalid parameters.
- [ ] Runtime/config: remove BuiltInAgent; wire Codex adapter, isolated Codex state, explicit child environment and workspace-write sandbox. Store only workspace selection, never API key. Preserve session-key input and stable learning container.
- [ ] UI: workspace chooser, backend/model labels and progress summaries. Keep stop, screenshots, record-to-skill and New conversation semantics.
- [ ] Package: ship the architecture-specific official Codex binary outside ASAR and point SDK to it. Verify executable exists in packaged app.
- [ ] Verification: `npm test`, `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run package`; live create/read/revise task in disposable workspace, record-to-skill prompt, Intelligence delivery, drag/click. Review spec coverage then correctness/security; fix findings before final report.
