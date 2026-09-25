import { test } from "node:test";
import assert from "node:assert/strict";
import {
  learningStrip,
  openLabel,
  lessonMemory,
  teachingAnnotation,
} from "../src/learning-view";
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

const taught = [
  {
    role: "user",
    content: [
      { type: "text", text: "Open Chrome, open Gmail, and label this email" },
      { type: "binary", mimeType: "image/png", data: "AAAA" },
    ],
  },
  {
    role: "assistant",
    toolCalls: [
      { function: { name: "open_application" } },
      { function: { name: "click" } },
    ],
  },
  { role: "tool", content: '{"status":"completed"}' },
  { role: "assistant", content: "Done. It was spam, so I labeled it Spam." },
  { role: "user", content: "Thanks" },
];

test("a lesson note names the task from the first user turn, without attachments", () => {
  const lesson = teachingAnnotation(taught, "thread-1");
  assert.deepEqual(lesson, {
    threadId: "thread-1",
    title: "Taught OpenMuse a task",
    description: "Open Chrome, open Gmail, and label this email",
    data: {
      outcome: "user-confirmed-success",
      source: "openmuse-desktop",
      userTurns: 2,
    },
  });
  assert.ok(!JSON.stringify(lesson).includes("AAAA"));
});

test("a lesson note description is capped at 500 characters", () => {
  const lesson = teachingAnnotation(
    [{ role: "user", content: "y".repeat(900) }],
    "t",
  );
  assert.equal(lesson.description.length, 500);
  assert.ok(lesson.description.endsWith("…"));
});

test("a lesson needs a task to learn from", () => {
  assert.throws(
    () => teachingAnnotation([{ role: "assistant", content: "Hi" }], "t"),
    /Send OpenMuse a task before teaching it\./,
  );
  assert.throws(
    () => lessonMemory([{ role: "assistant", content: "Hi" }]),
    /Send OpenMuse a task before teaching it\./,
  );
});

test("the saved lesson says how the task was done, in order, and what came of it", () => {
  assert.equal(
    lessonMemory(taught),
    [
      "How to: Open Chrome, open Gmail, and label this email",
      "OpenMuse did this successfully and the user confirmed it worked.",
      "OpenMuse tools used, in order: open_application → click.",
      "What OpenMuse reported when done: Done. It was spam, so I labeled it Spam.",
    ].join("\n"),
  );
  const long = lessonMemory([
    { role: "user", content: "t" },
    { role: "assistant", content: "r".repeat(9000) },
  ]);
  assert.ok(long.length <= 4000);
});
