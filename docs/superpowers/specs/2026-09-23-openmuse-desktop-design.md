# OpenMuse Desktop design

Approved by the user on September 23, 2026: rebrand the desktop companion as OpenMuse Desktop, match OpenMuse's existing capybara and blue/white palette, default to Capybara with a persistent Kite option, and preserve the repository and macOS data identity.

Use an original simple lilac capybara illustration generated from the user's Kite screenshot as a style reference. Include provenance and upstream palette attribution. Adopt the canvas, text, muted, line, blue, sky, green, lavender and orange colors from apps/mobile/src/ui.tsx, while preserving the existing typography, rounded cards, orbit graphics and layout. Extract a shared Sprite component for the buddy, overview and preference preview. The existing draggable buddy behavior remains shared by both appearances.

Settings gains a Desktop companion choice between Capybara (default) and Kite. A narrow validated IPC writes a private preferences file atomically before broadcasting an update to both windows. Missing preferences use Capybara; malformed preferences and failed writes surface errors. The choice persists after restart. Runtime settings continue sharing their existing mutable object so workspace and credential status updates remain live.

Product labels, window title, menu and package display name become OpenMuse Desktop. Keep com.kite.sprite, Application Support/Kite, environment variables, IPC namespaces and skill identifiers stable for compatibility. Do not claim this is an upstream OpenMuse release. Create jerelvelarde/heycapybara as the new public repository and preserve heykite unchanged; an upstream PR is a possible future action, not part of this request.

Verification: default/load/save/reject-invalid preference tests, existing tests, lint, typecheck, build and signed-package verification; native UI check both sprites, persistence, drag/click and permissions. Document upstream integration boundaries and current Electron/Swift versus React Native architecture.

## User refinements

Keep the existing cute illustration style, orbit graphics and layout, while applying OpenMuse's colors. Use the newly generated simple lilac capybara rather than the detailed upstream mascot. The original Kite remains selectable. Create a new public jerelvelarde/heycapybara repository for this work and leave heykite unchanged as the historical archive. Do not set GitHub's read-only archived flag without an explicit request.
