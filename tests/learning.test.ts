import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunAgentInput } from "@ag-ui/core";
import {
  LEARNING_UNCHECKED,
  createLearningReader,
  describeLearning,
  learningError,
  safeLearningUrl,
  settleAfter,
} from "../server/learning";
import {
  inspectorSnapshot,
  learningRead,
  memory,
  type SnapshotOverrides,
} from "./learning-fixtures";

const now = new Date("2026-09-25T12:00:00Z");
const none = { skills: new Set<string>(), memories: new Set<string>() };
const WEB = "https://intelligence.example.test";

test("a configured container with nothing pending and no skills is idle", () => {
  const status = describeLearning(learningRead(), none, now);
  assert.equal(status.phase, "idle");
  assert.equal(status.message, "No learned skills yet.");
  assert.equal(status.link, null);
  assert.equal(status.memories, 0);
  assert.equal(status.checkedAt, now.toISOString());
});

test("a memory Intelligence wrote after the baseline is learned, even with no container", () => {
  const status = describeLearning(
    learningRead(
      { configuration: { state: "not_configured" } },
      { memories: [memory("m1", "How to label Gmail spam\nSteps: …")] },
    ),
    none,
    now,
  );
  assert.equal(status.phase, "learned");
  assert.equal(
    status.message,
    'New in Intelligence Memory: "How to label Gmail spam"',
  );
  assert.deepEqual(status.newMemories, ["How to label Gmail spam"]);
  assert.equal(status.memories, 1);
});

test("several new memories are announced neutrally, with the first as an example", () => {
  const status = describeLearning(
    learningRead(
      {},
      { memories: [memory("m1", "First note"), memory("m2", "Second note")] },
    ),
    none,
    now,
  );
  assert.equal(status.phase, "learned");
  assert.equal(
    status.message,
    'New in Intelligence Memory: 2 notes, including "First note"',
  );
});

test("memories in the baseline are counted but not announced", () => {
  const status = describeLearning(
    learningRead({}, { memories: [memory("m1", "Known")] }),
    { skills: new Set(), memories: new Set(["m1"]) },
    now,
  );
  assert.equal(status.phase, "idle");
  assert.deepEqual(status.newMemories, []);
  assert.equal(status.memories, 1);
});

test("an unreadable Memory keeps the skills path going and says why", () => {
  const status = describeLearning(
    learningRead(
      { pendingThreadCount: 1 },
      {
        memories: null,
        errors: {
          memories:
            "Couldn't read Intelligence Memory: Intelligence platform error 403: forbidden",
        },
      },
    ),
    none,
    now,
  );
  assert.equal(status.phase, "waiting");
  assert.equal(status.memories, null);
  assert.equal(
    status.memoryError,
    "Couldn't read Intelligence Memory: Intelligence platform error 403: forbidden",
  );
});

test("conversations waiting for an analysis link to the page that starts one", () => {
  const status = describeLearning(
    learningRead({ pendingThreadCount: 1 }),
    none,
    now,
  );
  assert.equal(status.phase, "waiting");
  assert.equal(
    status.message,
    "1 conversation ready to learn from. Start an analysis in Intelligence.",
  );
  assert.deepEqual(status.link, { kind: "runs", url: `${WEB}/learning/runs` });
});

test("an active analysis reports its current step", () => {
  const status = describeLearning(
    learningRead({
      pendingThreadCount: 1,
      run: {
        hasActiveRun: true,
        latest: { status: "batching", completedAt: null },
      },
    }),
    none,
    now,
  );
  assert.equal(status.phase, "analyzing");
  assert.equal(
    status.message,
    "Intelligence is learning from your conversations (batching).",
  );
});

test("skills awaiting review link to the review page and carry the newest insight", () => {
  const status = describeLearning(
    learningRead({
      pendingCandidateCount: 2,
      insight: "Users sort Gmail spam by sender before labeling it.",
    }),
    none,
    now,
  );
  assert.equal(status.phase, "review");
  assert.equal(
    status.message,
    "2 skills ready for your review in Intelligence.",
  );
  assert.deepEqual(status.link, {
    kind: "candidates",
    url: `${WEB}/learning/candidates`,
  });
  assert.equal(
    status.insight,
    "Users sort Gmail spam by sender before labeling it.",
  );
});

test("a skill delivered after the baseline is learned, ahead of a pending review", () => {
  const status = describeLearning(
    learningRead(
      { pendingCandidateCount: 1 },
      { skills: ["gmail-spam-triage"] },
    ),
    none,
    now,
  );
  assert.equal(status.phase, "learned");
  assert.equal(
    status.message,
    'Learned "gmail-spam-triage". New conversations can use it.',
  );
  assert.deepEqual(status.newSkills, ["gmail-spam-triage"]);
});

test("skills already in the baseline are available but not announced", () => {
  const status = describeLearning(
    learningRead({}, { skills: ["b-skill", "a-skill"] }),
    { skills: new Set(["a-skill", "b-skill"]), memories: new Set() },
    now,
  );
  assert.equal(status.phase, "idle");
  assert.equal(status.message, "2 learned skills available.");
  assert.deepEqual(status.skills, ["a-skill", "b-skill"]);
});

test("a learning container Intelligence can't use is a setup step that names it", () => {
  const cases: [SnapshotOverrides["configuration"], RegExp][] = [
    [
      { state: "not_configured" },
      /no learning container for OpenMuse yet\. Create "desktop-workflows"/,
    ],
    [{ state: "selection_required" }, /Choose "desktop-workflows"/],
    [
      { state: "invalid", reason: "container" },
      /can't use the learning container "desktop-workflows"/,
    ],
    [
      { state: "invalid", reason: "instrumentation" },
      /invalid \(instrumentation\)\. Check "desktop-workflows"/,
    ],
    [
      { state: "configured", container: { id: "other", name: "Other" } },
      /"other", but OpenMuse saves conversations to "desktop-workflows"/,
    ],
  ];
  for (const [configuration, message] of cases) {
    const status = describeLearning(
      learningRead({ configuration, pendingThreadCount: 3 }),
      none,
      now,
    );
    assert.equal(status.phase, "setup", JSON.stringify(configuration));
    assert.match(status.message, message);
    assert.deepEqual(status.link, { kind: "learning", url: `${WEB}/learning` });
  }
});

test("an unreadable learning status or skill delivery is an error with its reason", () => {
  const noSnapshot = describeLearning(
    learningRead(null, {
      errors: {
        snapshot:
          "Couldn't read Intelligence learning status: Intelligence platform error 404",
      },
    }),
    none,
    now,
  );
  assert.equal(noSnapshot.phase, "error");
  assert.equal(
    noSnapshot.message,
    "Couldn't read Intelligence learning status: Intelligence platform error 404",
  );
  const noSkills = describeLearning(
    learningRead(
      {},
      {
        skills: null,
        errors: {
          skills:
            "Couldn't read learned skills: Learned-skills delivery is disabled.",
        },
      },
    ),
    none,
    now,
  );
  assert.equal(noSkills.phase, "error");
  assert.match(noSkills.message, /delivery is disabled/);
});

test("a failed last analysis is an error that links to Intelligence", () => {
  const status = describeLearning(
    learningRead({
      run: {
        latest: { status: "failed", completedAt: "2026-09-25T11:59:00Z" },
      },
    }),
    none,
    now,
  );
  assert.equal(status.phase, "error");
  assert.equal(
    status.message,
    "The last Intelligence analysis failed. Open Intelligence to see why.",
  );
  assert.equal(status.link?.kind, "learning");
});

test("an unexpected read failure keeps what was known and says what failed", () => {
  const previous = describeLearning(
    learningRead({}, { skills: ["a-skill"] }),
    none,
    now,
  );
  const status = learningError(new Error("socket hang up"), previous, now);
  assert.equal(status.phase, "error");
  assert.equal(status.message, "socket hang up");
  assert.deepEqual(status.skills, ["a-skill"]);
  assert.equal(
    learningError("not an Error", LEARNING_UNCHECKED, now).message,
    "Couldn't check Intelligence learning: not an Error",
  );
});

test("a learning read reports each failed source by name, redacted, and never rejects", async () => {
  const read = await createLearningReader({
    containerId: "desktop-workflows",
    inspect: async () => {
      throw new Error("Intelligence platform error 404");
    },
    skills: async () => {
      throw new Error("Bearer sk-live0000000000000000000000 rejected");
    },
    memories: async () => [memory("m1", "Known")],
  })();
  assert.equal(read.snapshot, null);
  assert.equal(
    read.errors.snapshot,
    "Couldn't read Intelligence learning status: Intelligence platform error 404",
  );
  assert.equal(read.skills, null);
  assert.match(read.errors.skills ?? "", /^Couldn't read learned skills: /);
  assert.doesNotMatch(read.errors.skills ?? "", /sk-live/);
  assert.deepEqual(
    read.memories?.map((m) => m.id),
    ["m1"],
  );
  assert.equal(read.errors.memories, null);
});

test("a source that is not connected is named as such", async () => {
  const read = await createLearningReader({
    containerId: "desktop-workflows",
    inspect: async () => inspectorSnapshot({ pendingThreadCount: 2 }),
    skills: async () => [],
  })();
  assert.equal(read.snapshot?.pendingThreadCount, 2);
  assert.equal(read.memories, null);
  assert.equal(
    read.errors.memories,
    "Couldn't read Intelligence Memory: not connected.",
  );
});

const runInput = (threadId: string): RunAgentInput => ({
  threadId,
  runId: "r",
  messages: [],
  tools: [],
  context: [],
  state: {},
  forwardedProps: {},
});

test("settleAfter reports the thread once the run ends, however it ends", async () => {
  const settled: string[] = [];
  const ok = settleAfter(
    async function* () {
      yield { type: "turn.started" as const };
    },
    (threadId) => settled.push(threadId),
  );
  const events = [];
  for await (const event of ok(runInput("t1"), new AbortController().signal))
    events.push(event);
  assert.equal(events.length, 1);
  const failing = settleAfter(
    // eslint-disable-next-line require-yield
    async function* () {
      throw new Error("quota");
    },
    (threadId) => settled.push(threadId),
  );
  await assert.rejects(async () => {
    for await (const event of failing(
      runInput("t2"),
      new AbortController().signal,
    ))
      events.push(event);
  }, /quota/);
  assert.deepEqual(settled, ["t1", "t2"]);
});

test("a throwing settle callback never replaces the run's own outcome", async () => {
  const stream = settleAfter(
    async function* () {
      yield { type: "turn.started" as const };
    },
    () => {
      throw new Error("watcher broke");
    },
  );
  const events = [];
  for await (const event of stream(
    runInput("t3"),
    new AbortController().signal,
  ))
    events.push(event);
  assert.equal(events.length, 1);
});

test("only an HTTPS link in the current status can be opened", () => {
  const base = describeLearning(
    learningRead({ pendingThreadCount: 1 }),
    none,
    now,
  );
  assert.equal(safeLearningUrl(base), `${WEB}/learning/runs`);
  assert.throws(
    () => safeLearningUrl({ ...base, link: null }),
    /There is no Intelligence page to open for this step\./,
  );
  assert.throws(
    () =>
      safeLearningUrl({
        ...base,
        link: { kind: "runs", url: "http://localhost:3000/learning/runs" },
      }),
    /Refusing to open http:\/\/localhost:3000: Intelligence links must use HTTPS\./,
  );
});
