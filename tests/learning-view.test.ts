import { test } from "node:test";
import assert from "node:assert/strict";
import { learningStrip, openLabel } from "../src/learning-view";
import type { LearningStatus } from "../src/types";

function status(overrides: Partial<LearningStatus> = {}): LearningStatus {
  return {
    phase: "idle",
    message: "No learned skills yet.",
    link: null,
    skills: [],
    newSkills: [],
    memories: 0,
    newMemories: [],
    memoryError: null,
    insight: null,
    checkedAt: null,
    ...overrides,
  };
}
const runs = { kind: "runs" as const, url: "https://i.example.test/runs" };

test("the strip stays hidden when there is nothing to say", () => {
  assert.equal(learningStrip(status({ phase: "off" })), null);
  assert.equal(learningStrip(status()), null);
});

test("idle with skills is a quiet note", () => {
  assert.deepEqual(
    learningStrip(
      status({ skills: ["a"], message: "1 learned skill available." }),
    ),
    { tone: "quiet", text: "1 learned skill available.", action: null },
  );
});

test("steps that need a person link to Intelligence with the step's label", () => {
  assert.deepEqual(
    learningStrip(status({ phase: "waiting", message: "m", link: runs })),
    {
      tone: "action",
      text: "m",
      action: { kind: "open", label: "Analyze in Intelligence" },
    },
  );
  const review = learningStrip(
    status({
      phase: "review",
      message: "1 skill ready for your review in Intelligence.",
      insight: "Users sort spam by sender.",
      link: { kind: "candidates", url: "https://i.example.test/c" },
    }),
  );
  assert.equal(
    review?.text,
    "1 skill ready for your review in Intelligence. Noticed: Users sort spam by sender.",
  );
  assert.deepEqual(review?.action, {
    kind: "open",
    label: "Review in Intelligence",
  });
});

test("analysis in progress is busy with no action", () => {
  assert.deepEqual(
    learningStrip(status({ phase: "analyzing", message: "m", link: runs })),
    { tone: "busy", text: "m", action: null },
  );
});

test("anything newly learned offers to try it", () => {
  assert.deepEqual(
    learningStrip(
      status({
        phase: "learned",
        message: 'Intelligence learned from your conversations: "x"',
      }),
    ),
    {
      tone: "success",
      text: 'Intelligence learned from your conversations: "x"',
      action: { kind: "try" },
    },
  );
});

test("setup and errors show their message, with a link only when there is one", () => {
  assert.deepEqual(learningStrip(status({ phase: "error", message: "e" })), {
    tone: "error",
    text: "e",
    action: null,
  });
  assert.deepEqual(
    learningStrip(
      status({
        phase: "setup",
        message: "s",
        link: { kind: "learning", url: "https://i.example.test/l" },
      }),
    )?.action,
    { kind: "open", label: "Open Intelligence" },
  );
  assert.equal(openLabel("candidates"), "Review in Intelligence");
});
