# Notch onboarding proposal

Status: superseded on September 24, 2026 by `2026-09-24-clean-onboarding-design.md`. An opt-in version of this flow was implemented on `jerel/kite-os-learning` (PR #1) and is removed by the clean onboarding change. Kept for history.

## Observations

The supplied Clicky screenshots demonstrate a small welcome surface, a permission-specific explanation, a system-owned permission prompt and a floating app tile beside Accessibility settings. Clicky's changelog describes a compact Home panel that expands from the notch, supports popping out to a window and offers a replayable welcome tour. These are observed product behaviors, not a claim about Clicky's private implementation.

Sources:

- https://www.heyclicky.com/changelog
- https://www.electronjs.org/docs/latest/tutorial/native-file-drag-drop
- https://developer.apple.com/documentation/appkit/nsscreen/auxiliarytopleftarea-uglc

## Proposed behavior

Use OpenMuse's original tan capybara without modifying its face or colors. Preserve the blue/white workspace, illustration layout and alternate Kite choice.

On first launch, show a compact panel beneath the hardware notch: Welcome, Accessibility, optional Screen Recording, Ready. Explain only capabilities the app actually has. There is no microphone or Google sign-in step because neither is implemented in this application. Existing installations get the new tour once; Settings can replay it. Closing the panel does not claim setup or permission completion.

Accessibility offers Open System Settings, a draggable OpenMuse Desktop app tile, and Refresh status. A native outgoing file drag carries the running .app bundle, not an image or a copied executable. macOS controls the subsequent toggle and authentication. A packaged app is required for this tile; development explains that requirement and provides the ordinary permission controls. Keep a visible helper panel available while Settings is foreground. Provide Show app in Finder as a fallback.

Screen Recording explains that screenshots are shared only when attached. Allow skipping it. After opening Settings, refresh actual permission status on focus and while the setup step is visible, with at most one check in flight. Distinguish granted, not granted, pending request and failed check. Never infer approval from opening Settings or dropping a tile. Allow retries and explain restart requirements.

After setup, show a compact notch companion that expands on hover or keyboard activation. It provides Open workspace, Record/Stop, and Setup actions. The existing workspace remains the full agent surface. Settings chooses Notch or Floating placement; floating mode retains the draggable sprite and its remembered position.

Use NSScreen safeAreaInsets/auxiliary top areas to identify a notched display and its usable geometry. Place interactive content below the physical camera housing, never underneath it. Without a notch, use a top-center panel. Reposition on display changes; keep the floating position separately. Expanded content must not cover menu-bar controls, and reduced-motion users get immediate transitions.

## Boundaries and verification

Persist onboarding completion and placement independently of macOS permission grants. Validate all new IPC and select the app bundle path only in the main process. Never accept arbitrary renderer-supplied file paths for native drag.

Verify preference migration, display geometry (including negative display origins and no-notch fallback), missing/corrupt preferences and permission failure/retry transitions. Check both native app launch modes, hover/keyboard expansion, replay, display removal, actual outgoing .app drag and restart persistence. Granting Accessibility remains a user action during verification.
