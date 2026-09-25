import { test } from "node:test";
import assert from "node:assert/strict";
import {
  learningStrip,
  openLabel,
  lessonMemory,
  teachingAnnotation,
  buddyLearningBadge,
  redactSecrets,
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
        message: 'New in Intelligence Memory: "x"',
      }),
    ),
    {
      tone: "success",
      text: 'New in Intelligence Memory: "x"',
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

test("the pet shows busy while analyzing, attention when a person is needed, and anything new", () => {
  assert.equal(buddyLearningBadge(status({ phase: "analyzing" })), "busy");
  assert.equal(buddyLearningBadge(status({ phase: "waiting" })), "attention");
  assert.equal(buddyLearningBadge(status({ phase: "review" })), "attention");
  assert.equal(buddyLearningBadge(status({ phase: "learned" })), "new");
  for (const phase of ["off", "idle", "setup", "error"] as const)
    assert.equal(buddyLearningBadge(status({ phase })), null);
});

test("secret-shaped text is redacted", () => {
  const cases: [string, string][] = [
    [
      "Log in with password: hunter2 then open it",
      "Log in with password: [redacted] then open it",
    ],
    ["passcode=4471", "passcode=[redacted]"],
    ["My PIN is 8812.", "My PIN is [redacted]."],
    ["token = abc.def", "token = [redacted]"],
    ["the secret is 'open sesame'", "the secret is [redacted]"],
    ['API key: "k-123"', "API key: [redacted]"],
    ["api_key=xyz", "api_key=[redacted]"],
    ["use sk-proj-AbC123dEf456 now", "use [redacted] now"],
    ["ghp_" + "a1".repeat(18), "[redacted]"],
    ["hash " + "0123456789abcdef".repeat(2), "hash [redacted]"],
    ["blob QmFzZTY0IGVuY29kZWQgdGV4dCBsb29rcyBsaWtlZQ==", "blob [redacted]"],
  ];
  for (const [input, expected] of cases)
    assert.equal(redactSecrets(input), expected, input);
});

test("ordinary text is not redacted", () => {
  for (const text of [
    "Open Chrome, open Gmail, and label this email",
    "Reset my password in Settings",
    "Pin the tab and open the token list",
    "Supercalifragilisticexpialidociousandthensome",
    "y".repeat(60),
  ])
    assert.equal(redactSecrets(text), text);
});

test("secrets never reach the saved lesson or the note", () => {
  const leaky = [
    { role: "user", content: "Sign in to the portal with password: hunter2" },
    { role: "assistant", toolCalls: [{ function: { name: "click" } }] },
    { role: "assistant", content: "Signed in. The token is tok_998877." },
  ];
  const lesson = lessonMemory(leaky);
  assert.ok(!lesson.includes("hunter2"), lesson);
  assert.ok(!lesson.includes("tok_998877"), lesson);
  assert.ok(lesson.includes("password: [redacted]"));
  const note = JSON.stringify(teachingAnnotation(leaky, "t"));
  assert.ok(!note.includes("hunter2"), note);
});

test("the final report is left out when OpenMuse typed text", () => {
  const typed = [
    { role: "user", content: "Fill in the sign-up form" },
    {
      role: "assistant",
      toolCalls: [
        { function: { name: "click" } },
        { function: { name: "type_text" } },
      ],
    },
    { role: "assistant", content: "Done. I typed Jane Doe, 12 Elm St." },
  ];
  assert.equal(
    lessonMemory(typed),
    [
      "How to: Fill in the sign-up form",
      "OpenMuse did this successfully and the user confirmed it worked.",
      "OpenMuse tools used, in order: click → type_text.",
      "(final report omitted because text was typed)",
    ].join("\n"),
  );
});
