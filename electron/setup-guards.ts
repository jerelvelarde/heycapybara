// The companion carries the always-visible recording indicator and setup hides it, so a recording
// and setup must not overlap. main.ts enforces this with state each side sets synchronously as soon
// as its own guard passes, before its first await: startRecording sets `transitioning` and
// replaySetup counts itself in `setupReopenings`. Whichever call is handled first therefore refuses the other.
export function replayBlockedReason(recording: {
  active: boolean;
  changing: boolean;
}): string | undefined {
  return recording.active || recording.changing
    ? "Stop the recording before replaying setup."
    : undefined;
}

// `complete` alone is not enough: a replay's save is queued, so onboardingComplete stays true
// until it lands, while `reopening` is set as soon as the replay passes its guard.
export function recordingBlockedReason(setup: {
  complete: boolean;
  reopening: boolean;
}): string | undefined {
  return !setup.complete || setup.reopening
    ? "Finish setup before starting a recording."
    : undefined;
}
