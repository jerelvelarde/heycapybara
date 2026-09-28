// The helper's refusal when it lacks Accessibility (eventAccessError in
// native/Recorder.swift). It names OpenMuse Desktop, which is right for the
// packaged app. The development build runs from `npm run dev`, which starts
// node_modules' Electron.app through native/bin/kite-launch as its own
// responsible process, so there the permission belongs to "Electron".
// tests/accessibility-error.test.ts checks the packaged text against the
// Swift source.
export const packagedAccessibilityError =
  "OpenMuse needs Accessibility permission to control the Mac. Ask the user to turn on OpenMuse Desktop in System Settings > Privacy & Security > Accessibility, then try again.";

export const devAccessibilityError =
  'OpenMuse needs Accessibility permission to control the Mac. Ask the user to turn on "Electron", the development build, in System Settings > Privacy & Security > Accessibility, then try again.';

// Returns the error to report: the helper's own unless this is the
// development build and it is the Accessibility refusal.
export function nameAccessibilityApp(error: unknown, packaged: boolean) {
  if (
    !packaged &&
    error instanceof Error &&
    error.message === packagedAccessibilityError
  )
    return new Error(devAccessibilityError);
  return error;
}
