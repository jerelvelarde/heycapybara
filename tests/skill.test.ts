import { test } from "node:test";
import assert from "node:assert/strict";
import { manualDraft, skillPrompt } from "../src/skill";
import { validateSkillMarkdown } from "../electron/store";
import type { Recording } from "../src/types";
const recording: Recording = {
  id: "test",
  title: "Weekly report",
  startedAt: "2026-09-23T00:00:00Z",
  stoppedAt: "2026-09-23T00:01:00Z",
  events: [
    {
      id: "1",
      timestamp: "2026-09-23T00:00:02Z",
      kind: "note",
      app: "You",
      bundleId: "",
      title: "Narration",
      detail: "Confirm totals before submitting",
    },
    {
      id: "2",
      timestamp: "2026-09-23T00:00:03Z",
      kind: "status",
      app: "",
      bundleId: "",
      title: "",
      detail: "Recording stopped",
    },
  ],
};
test("manual draft is valid portable markdown and labels observed evidence", () => {
  const md = manualDraft(recording);
  validateSkillMarkdown(md);
  assert.match(md, /manual draft/);
  assert.match(md, /Confirm totals/);
  assert.doesNotMatch(md, /Recording stopped/);
});
test("skill generation rejects empty and oversized evidence", () => {
  assert.throws(
    () => skillPrompt({ ...recording, events: [] }),
    /at least one/,
  );
  assert.throws(
    () =>
      skillPrompt({
        ...recording,
        events: [{ ...recording.events[0], detail: "x".repeat(101000) }],
      }),
    /too large/,
  );
});
test("reviewed recording prompt preserves corrections as data", () => {
  const prompt = skillPrompt(recording);
  assert.match(prompt, /untrusted observations/);
  assert.match(prompt, /Confirm totals/);
  assert.doesNotMatch(prompt, /Recording stopped/);
});
