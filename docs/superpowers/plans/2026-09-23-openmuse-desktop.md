# OpenMuse Desktop Implementation Plan

> For agentic workers: use subagent-driven-development for isolated implementation and review.

**Goal:** Apply the approved OpenMuse identity with a selectable persistent desktop companion.

**Architecture:** React Sprite component consumes a capybara/kite preference exposed through existing snapshot IPC. Electron persists the choice locally and broadcasts successful changes. Native bundle and data identifiers remain stable.

**Tech stack:** Electron, React, TypeScript, Swift, Node test runner.

- [x] Implement `electron/preferences.ts` with `loadCompanion(path)` and `saveCompanion(path, value)`; missing file returns `capybara`, invalid JSON/value rejects, writes use a private temporary file and rename. Test roundtrip and rejected invalid input in `tests/preferences.test.ts`.
- [x] Add `Companion = "capybara" | "kite"`, required `Settings.companion`, and `KiteAPI.setCompanion(companion): Promise<void>`. Preload invokes `kite:setCompanion`. Main loads preference at startup, validates with z.enum, serializes writes, updates runtime settings object and broadcasts after persistence. Runtime initializes typed default.
- [x] Extract `src/Sprite.tsx`, use the generated simple lilac mascot at `public/capybara.png` and document provenance and upstream palette license nearby. Add accessible two-choice Settings UI calling `setCompanion`; pass saved preference to buddy and overview. Match upstream tokens in stylesheet and update renderer product text without changing legacy API names or data paths.
- [x] Change native display/menu/package branding to OpenMuse Desktop, explicitly retain data path and bundle identifier. Make signature verifier derive product path from package.json. Update docs with upstream provenance and integration boundaries.
- [x] Run formatting, lint, typecheck, tests, packaged build and signature verifier. Use native UI to verify selection, drag, click, persistence and permission state; review diff and commit focused changes.
