# Verification log

## OpenMuse Desktop / HeyCapybara rebrand — 2026-09-23

- Preserved the original illustration composition and layout while applying OpenMuse's blue/white palette. Native screenshots verified the generated capybara and original Kite in the hero.
- Native Settings UI switched between both companions; a full quit/relaunch retained Kite and displayed it in the floating buddy. Restored Capybara as the saved choice afterward.
- Dragging the capybara saved a new position, and clicking it opened the workspace.
- Model connection restored through the secure session-only field; the UI reported Connected and cleared the input.
- All 26 tests, formatting, ESLint and explicit typecheck passed. Full Swift/renderer/Electron package passed with the new capybara icon.
- Strict recursive signing verification passed with sealed bundle metadata/resources and identity `com.kite.sprite`. This corrects the previous unbound Electron signature. Current Accessibility and Screen Recording checks still report not granted: reapproval for the newly signed build remains necessary before capture can be tested.
- Independent source review found two regressions (low-contrast keyboard focus and stale packaged verification path); both were fixed and re-reviewed.
- New public repository is `jerelvelarde/heycapybara`. Remote `heykite` remains at `c432d48f7f3ef1bcbfa638fbd95202aa54e16945`; no upstream OpenMuse PR was opened.

## Codex upgrade — 2026-09-23

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

## Existing baseline — 2026-09-23

- Native Swift helper compiled on Apple Silicon macOS.
- Previous temporary-library smoke covered recorder start, note, stop, evidence review, manual draft, approval and SKILL.md export.
- Intelligence project `kite` and container `desktop-workflows` exist; snapshot delivery returned revision `0`.
- Packaged app loads the CLI-managed Intelligence environment via its private file-path reference.

## Boundaries still requiring validation — 2026-09-23

The current packaged app shows macOS Accessibility and Screen Recording as not granted. End-to-end live cross-application capture with this build and screenshot attachment require those permissions. The Codex skill test used reviewed text evidence from the verified scratch-file task, not a newly recorded desktop session.

Cloud-side completed-thread ingestion, scheduled learning analysis, and applying a newly published cloud skill have not been independently confirmed in the Intelligence dashboard. Successful delivery of an empty skill catalog does not establish those outcomes.

The original build was unsigned; the current packaging pipeline ad-hoc signs and verifies the sealed bundle identifier. It is not notarized. Native desktop actions remain open-app and visual pointer with approval; arbitrary cross-app clicking/typing and voice are not implemented. Codex workspace-write limits writes, not all reads outside the working folder. Conversation sessions persist in Kite's private agent directory, while the UI currently keeps its displayed conversation for the running app session.

## Original mascot correction — 2026-09-23

- Replaced the violet approximation with the exact OpenMuse tan capybara asset. SHA-256 matches upstream: `3a323215d0976583d0c3d0748df06bce75db9b05cc955901709b18e3b64e9b34`. Upstream MIT notice retained.
- Formatting, lint, typecheck, all 26 tests and full signed packaging pass.
- Relaunch is awaiting the user's macOS Documents-folder permission response. TCC logs identify a new ad-hoc code hash and a pending Documents request; the main process is blocked in file open before windows are created. The updated launch has therefore not yet been visually verified.
- Notch onboarding and the native .app drag tile are researched and proposed in `superpowers/specs/2026-09-23-notch-onboarding-proposal.md`, not implemented pending design approval.

## Clean onboarding — 2026-09-25

The notch tour and the notch placement are removed, and the floating companion (Capybara or Kite) is the only placement. A first-launch setup window (Welcome → Permissions → Ready) replaces the tour, and a recording and setup never run at the same time. An opt-in version of the notch onboarding was implemented on `jerel/kite-os-learning` (PR #1, since merged into `main`) and is removed here. Design: `superpowers/specs/2026-09-24-clean-onboarding-design.md`.

Since the last review, OpenMuse decides whether to show setup before anything creates the library, refuses a recording or the companion's tray while a setup replay is saving, shows the main process's own error text in every window, and no longer holds up a quit with a load-failure dialog.

- These checks ran after merging `main` (PR #1 and the pointer/screenshot contract, PR #2) into this branch. Formatting, lint, typecheck, 247 unit tests (this branch’s and those that came with `main`; the same count in two runs), the native helper build and the renderer/Electron build pass. The development smoke (`npm run smoke`) passed twice in a row with the same ledger, quoted below.
- Verifying on the merged tree exposed two ways a quit could hang, now fixed. A display change that macOS sends while the app quits reached the destroyed companion window, and Electron showed its uncaught-exception dialog; a diagnostic that repeats the smoke’s short launches hit it in 4 of 6 quits, and 0 of 6 after the fix. Startup also awaited the "⌘⇧K is in use" warning as a sheet on the hidden workspace, so a taken shortcut stalled startup; the shortcut is now registered last and retried, and a conflict is logged instead of shown in a dialog.
- During the smoke run this Mac reported Screen Recording granted and Accessibility not granted. The smoke stubs permission requests and opening System Settings, so it never grants a permission.
- Not run: the packaged smoke (`npm run smoke:packaged`), a signed `.app` build, and granting Accessibility or Screen Recording in System Settings.
- The smoke writes its screenshots (the three setup screens, the workspace, and the companion's hover and chat) locally to `artifacts/`. That folder is git-ignored, so they are not committed.
- A new install saves its default preferences before anything creates the library, so if that first launch fails later or is quit mid-setup, the next launch shows setup again; an existing library without a preferences file counts as a returning install and skips setup.

The smoke’s ledger from the second of those runs, verbatim. The entries marked – were skipped, so the run did not exercise them: two need Screen Recording to be off (it is granted on this Mac), two need Accessibility (not granted on this Mac), one runs only with `--cloud` and one only with `--record`.

```text
✓ setup window opens centered on a fresh install
✓ Dock activation reopens a hidden setup window
✓ companion trays refused while setup is open
✓ recording refused while setup is open
✓ recording dialog explains that setup comes first
✓ setup refuses unknown completion options
✓ closing setup stays open when skipping cannot be saved
✓ failed Allow keeps the Allow button
✓ setup Allow asks macOS for Accessibility
– setup Allow asks macOS for Screen Recording (skipped: Screen Recording is already granted on this Mac)
✓ setup shows granted permissions as Allowed
✓ setup opens only the known System Settings panes
✓ Get started and Continue advance setup
✓ failed setup save keeps setup open with an error
✓ Open the workspace finishes setup
✓ Settings has no removed placement options
✓ errors show without Electron's IPC prefix
✓ picking a companion keeps a hidden companion hidden
✓ Settings opens System Settings for Accessibility
– Settings opens System Settings for Screen Recording (skipped: Screen Recording is already granted on this Mac)
✓ Settings hides System Settings for granted permissions
✓ Replay setup reopens setup and hides the companion
✓ closing setup skips it
✓ Start using OpenMuse finishes setup
✓ replay refused while a recording is starting
✓ recording refused while setup is reopening
✓ companion tray refused while setup is reopening
✓ companion hover greets and respects reduced motion
✓ companion chat opens and closes
✓ chat asks for Accessibility before recording
– chat records and stops a workflow (skipped: needs Accessibility, which this Mac has not granted)
– replay refused while a recording is active (skipped: needs Accessibility, which this Mac has not granted)
✓ chat keeps its draft and asks for an API key
✓ chat Workspace button hides the chat
✓ Learning shows Intelligence as not configured
– Learning verifies the Intelligence connection (skipped: only runs with --cloud)
✓ workspace opens the recording dialog
– record, note, stop, draft, approve and export (skipped: only runs with --record)
✓ relaunch mid-setup shows setup again
✓ legacy preferences file skips setup
✓ returning install without preferences skips setup
Desktop smoke passed: 35 checks covered, 6 skipped.
```
