import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recordingBlockedReason,
  replayBlockedReason,
} from "../electron/setup-guards";

test("replay is blocked while a recording is active or changing state", () => {
  assert.equal(
    replayBlockedReason({ active: true, changing: false }),
    "Stop the recording before replaying setup.",
  );
  assert.equal(
    replayBlockedReason({ active: false, changing: true }),
    "Stop the recording before replaying setup.",
  );
  assert.equal(
    replayBlockedReason({ active: true, changing: true }),
    "Stop the recording before replaying setup.",
  );
});

test("replay is allowed when no recording is active or changing state", () => {
  assert.equal(
    replayBlockedReason({ active: false, changing: false }),
    undefined,
  );
});

test("recording is blocked while setup is incomplete", () => {
  assert.equal(
    recordingBlockedReason({ complete: false, reopening: false }),
    "Finish setup before starting a recording.",
  );
  assert.equal(
    recordingBlockedReason({ complete: false, reopening: true }),
    "Finish setup before starting a recording.",
  );
});

test("recording is refused while setup is reopening", () => {
  assert.equal(
    recordingBlockedReason({ complete: true, reopening: true }),
    "Finish setup before starting a recording.",
  );
});

test("recording is allowed once setup is complete", () => {
  assert.equal(
    recordingBlockedReason({ complete: true, reopening: false }),
    undefined,
  );
});
