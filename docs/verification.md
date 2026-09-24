# Verification — 2026-09-23

## Codex upgrade

- Official Codex SDK 0.156.1 installed; packaged native executable reports `codex-cli 0.156.1`.
- TypeScript, ESLint, Prettier and unsigned Apple Silicon desktop packaging passed.
- All 25 tests pass: drag threshold/origin, clamping/monitor removal, private position persistence, AG-UI event conversion, truncated-stream errors, cancellation, thread isolation, environment allowlisting, authenticated runtime/MCP, skill validation, and recording persistence.
- Independent sprite and backend reviews completed; findings fixed and re-reviewed.
- Packaged sprite was dragged through native UI automation, producing a saved position. Clicking the sprite subsequently opened the workspace. Keyboard activation also worked.
- Real Codex `gpt-5.4` run created a scratch file, read it, revised it, and read it again. Independent filesystem inspection confirmed `verified second pass`.
- Live `list_local_skills` and `list_learned_skills` MCP calls succeeded. Both catalogs are currently empty; published Intelligence delivery is reachable.
- Live non-login shell check confirmed `CODEX_API_KEY` and `KITE_MCP_TOKEN` were unset. Shell snapshots/login shells are disabled and explicit secret exclusions apply. No credential values were printed during verification.
- A fresh conversation generated `verify-file-edit` from reviewed test evidence. The completed output passed Kite's actual markdown validator and contained recovery and evidence-limit sections.
- Current session's OpenAI key was entered through the password field, cleared from that field after submission, and remains process-memory only.

## Existing baseline

- Native Swift helper compiled on Apple Silicon macOS.
- Previous temporary-library smoke covered recorder start, note, stop, evidence review, manual draft, approval and SKILL.md export.
- Intelligence project `kite` and container `desktop-workflows` exist; snapshot delivery returned revision `0`.
- Packaged app loads the CLI-managed Intelligence environment via its private file-path reference.

## Boundaries still requiring validation

The current packaged app shows macOS Accessibility and Screen Recording as not granted. End-to-end live cross-application capture with this build and screenshot attachment require those permissions. The Codex skill test used reviewed text evidence from the verified scratch-file task, not a newly recorded desktop session.

Cloud-side completed-thread ingestion, scheduled learning analysis, and applying a newly published cloud skill have not been independently confirmed in the Intelligence dashboard. Successful delivery of an empty skill catalog does not establish those outcomes.

The application is unsigned, not notarized. Native desktop actions remain open-app and visual pointer with approval; arbitrary cross-app clicking/typing and voice are not implemented. Codex workspace-write limits writes, not all reads outside the working folder. Conversation sessions persist in Kite's private agent directory, while the UI currently keeps its displayed conversation for the running app session.
