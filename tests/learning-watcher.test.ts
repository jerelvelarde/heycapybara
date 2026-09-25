import { test } from "node:test";
import assert from "node:assert/strict";
import { LearningWatcher } from "../electron/learning-watcher";
import type { LearningRead } from "../server/learning";
import type { LearningStatus } from "../src/types";
import { learningRead, memory } from "./learning-fixtures";

// Stands in for setTimeout: a scheduled poll runs only when a test fires it.
function fakeSchedule() {
  const queue: { run: () => Promise<void>; cancelled: boolean }[] = [];
  return {
    schedule(run: () => Promise<void>) {
      const entry = { run, cancelled: false };
      queue.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    pending() {
      return queue.filter((entry) => !entry.cancelled).length;
    },
    async fire() {
      const entry = queue.find((candidate) => !candidate.cancelled);
      assert.ok(entry, "expected a scheduled poll");
      queue.splice(queue.indexOf(entry), 1);
      await entry.run();
    },
  };
}

// A watcher whose reads come from `reads` in order (the last one repeats).
function setup(reads: (LearningRead | Error)[]) {
  let clock = 0;
  let calls = 0;
  const timers = fakeSchedule();
  const changes: LearningStatus[] = [];
  const watcher = new LearningWatcher({
    source: () => async () => {
      const next = reads[Math.min(calls, reads.length - 1)];
      calls += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    onChange: (status) => changes.push(status),
    now: () => clock,
    schedule: timers.schedule,
    intervalMs: 5000,
    windowMs: 60_000,
  });
  return {
    watcher,
    timers,
    changes,
    calls: () => calls,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

test("with Intelligence off the watcher reports off and never polls", async () => {
  const timers = fakeSchedule();
  const watcher = new LearningWatcher({
    source: () => undefined,
    onChange: () => {},
    schedule: timers.schedule,
  });
  assert.equal(watcher.status.phase, "off");
  await watcher.watch();
  assert.equal(watcher.status.phase, "off");
  assert.equal(timers.pending(), 0);
});

test("what exists at the first read is the baseline, not news", async () => {
  const { watcher } = setup([
    learningRead(
      {},
      { skills: ["existing-skill"], memories: [memory("m1", "Known")] },
    ),
  ]);
  await watcher.watch();
  assert.equal(watcher.status.phase, "idle");
  assert.deepEqual(watcher.status.newSkills, []);
  assert.deepEqual(watcher.status.newMemories, []);
});

test("a memory Intelligence writes is announced; a lesson OpenMuse saved is not", async () => {
  const { watcher, timers } = setup([
    learningRead(),
    learningRead({}, { memories: [memory("mine", "Saved lesson")] }),
    learningRead(
      {},
      {
        memories: [
          memory("mine", "Saved lesson"),
          memory("theirs", "Gmail spam is labeled from the message toolbar"),
        ],
      },
    ),
  ]);
  await watcher.watch();
  watcher.remember("mine");
  await timers.fire();
  assert.equal(watcher.status.phase, "idle");
  await timers.fire();
  assert.equal(watcher.status.phase, "learned");
  assert.deepEqual(watcher.status.newMemories, [
    "Gmail spam is labeled from the message toolbar",
  ]);
});

test("a skill that arrives while watching is announced once, until dismissed", async () => {
  const { watcher, timers, changes } = setup([
    learningRead({ pendingCandidateCount: 1 }),
    learningRead({}, { skills: ["gmail-spam-triage"] }),
  ]);
  await watcher.watch();
  assert.equal(watcher.status.phase, "review");
  await timers.fire();
  assert.equal(watcher.status.phase, "learned");
  const announced = changes.length;
  await timers.fire();
  assert.equal(changes.length, announced, "an unchanged read must not notify");
  watcher.acknowledge();
  assert.equal(watcher.status.phase, "idle");
  assert.deepEqual(watcher.status.newSkills, []);
  assert.equal(changes.length, announced + 1);
});

test("polling stops once the watch window has passed", async () => {
  const { watcher, timers, advance } = setup([learningRead()]);
  await watcher.watch();
  assert.equal(timers.pending(), 1);
  advance(60_001);
  await timers.fire();
  assert.equal(timers.pending(), 0);
});

test("a thrown read reports its reason and a later read recovers", async () => {
  const { watcher, timers } = setup([
    new Error("socket hang up"),
    learningRead(),
  ]);
  await watcher.watch();
  assert.equal(watcher.status.phase, "error");
  assert.equal(watcher.status.message, "socket hang up");
  await timers.fire();
  assert.equal(watcher.status.phase, "idle");
});

test("watch() while a poll is scheduled reads now and replaces the timer", async () => {
  const { watcher, timers, calls } = setup([learningRead()]);
  await watcher.watch();
  await watcher.watch();
  assert.equal(calls(), 2);
  assert.equal(timers.pending(), 1);
});

test("stop() cancels the next poll and ignores later watch() calls", async () => {
  const { watcher, timers, calls } = setup([learningRead()]);
  await watcher.watch();
  watcher.stop();
  assert.equal(timers.pending(), 0);
  await watcher.watch();
  assert.equal(calls(), 1);
});
