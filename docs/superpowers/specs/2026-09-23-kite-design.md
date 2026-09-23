# Kite: an OS-level learning companion

Approved direction: a macOS companion inspired by Clicky, using AG-UI and CopilotKit Intelligence, with record-to-skill.

Electron owns a floating buddy, global shortcut, and workspace. A Swift helper observes foreground app changes and accessibility context during explicitly started recordings. Capture includes clicks and keyboard shortcuts; ordinary typed content is omitted. Screen snapshots are explicit. Stop ends observation. The workspace shows a reviewable event timeline, permits deletion, and stores recordings locally.

An AG-UI agent receives reviewed evidence and produces a draft SKILL.md. The user edits and approves it into a local skill library. Subsequent guidance runs use that skill. Server-side CopilotKit runtime assigns runs to one stable configured learning container, and its BuiltInAgent uses learnedSkills delivery from that same container. Manual skill drafts remain local; no undocumented cloud publishing API is assumed. Intelligence proposes improvements from completed runs through its normal review/publish process.

Desktop actions are mediated by a visible approval step and limited to opening an application and pointing at a screen coordinate in this first version. Guided execution supports arbitrary recorded workflows without brittle blind coordinate replay. Keys stay in the Node runtime. Missing credentials and macOS permissions are visible states, never mocked success.

Verification: native Swift compilation, TypeScript/build, tests for recorder lifecycle, skill validation/persistence, action bounds, runtime configuration, and an Electron smoke test. Live cloud verification requires user project credentials and model access; permission grants remain user-controlled.
