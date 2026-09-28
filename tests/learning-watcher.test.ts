import { test } from "node:test";
import assert from "node:assert/strict";
import { LearningWatcher } from "../electron/learning-watcher";
import type { LearningRead } from "../server/learning";
import type { LearningStatus } from "../src/types";
import { learningRead, memory } from "./learning-fixtures";

// Stands in for setTimeout: a scheduled poll runs only when a test fires it.
function fakeSchedule() {
  const queue: { run: () => Promise<void>; cancelled: boolean }[] = [];
  // The wait asked for by every poll scheduled, in order.
  const delays: number[] = [];
  return {
    delays,
    schedule(run: () => Promise<void>, ms: number) {
      const entry = { run, cancelled: false };
      queue.push(entry);
      delays.push(ms);
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
  const rechecks: boolean[] = [];
  const timers = fakeSchedule();
  const changes: LearningStatus[] = [];
  const watcher = new LearningWatcher({
    source: () => async (options) => {
      const next = reads[Math.min(calls, reads.length - 1)];
      calls += 1;
      rechecks.push(options?.recheck === true);
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
    rechecks,
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

test("a poll that lands mid-save never announces the user's own lesson", async () => {
  const lesson = {
    ...memory("mine", "Saved lesson"),
    sourceThreadIds: ["t-lesson"],
  };
  const { watcher, timers } = setup([
    learningRead(),
    learningRead({}, { memories: [lesson] }),
    learningRead(
      {},
      {
        memories: [
          lesson,
          memory("theirs", "Gmail spam is labeled from the toolbar"),
        ],
      },
    ),
  ]);
  await watcher.watch();
  watcher.expectLesson("t-lesson");
  // createMemory has written the lesson but not yet returned its id.
  await timers.fire();
  assert.equal(watcher.status.phase, "idle");
  assert.deepEqual(watcher.status.newMemories, []);
  watcher.remember("mine");
  await timers.fire();
  assert.equal(watcher.status.phase, "learned");
  assert.deepEqual(watcher.status.newMemories, [
    "Gmail spam is labeled from the toolbar",
  ]);
});

test("a lesson from a taught thread stays unannounced if its id never comes back", async () => {
  const lesson = {
    ...memory("mine", "Saved lesson"),
    sourceThreadIds: ["t-lesson"],
  };
  const { watcher, timers } = setup([
    learningRead(),
    learningRead({}, { memories: [lesson] }),
  ]);
  await watcher.watch();
  watcher.expectLesson("t-lesson");
  await timers.fire();
  await timers.fire();
  assert.equal(watcher.status.phase, "idle");
  assert.deepEqual(watcher.status.newMemories, []);
});

test("a throwing onChange is logged and never rejects watch()", async (t) => {
  const logged = t.mock.method(console, "error", () => {});
  let calls = 0;
  const watcher = new LearningWatcher({
    source: () => async () => learningRead({ pendingCandidateCount: 1 }),
    onChange: () => {
      calls += 1;
      throw new Error("window gone");
    },
    schedule: fakeSchedule().schedule,
  });
  await watcher.watch();
  assert.equal(calls, 1);
  assert.equal(logged.mock.callCount(), 1);
});

test("a read that resolves after stop() does not notify", async () => {
  let release: (read: LearningRead) => void = () => {};
  let calls = 0;
  const watcher = new LearningWatcher({
    source: () => () =>
      new Promise<LearningRead>((resolve) => {
        release = resolve;
      }),
    onChange: () => {
      calls += 1;
    },
    schedule: fakeSchedule().schedule,
  });
  const reading = watcher.watch();
  watcher.stop();
  release(learningRead({ pendingCandidateCount: 1 }));
  await reading;
  assert.equal(calls, 0);
});

test("a source that keeps failing backs the polls off, and recovers on success", async () => {
  const failing = learningRead(null, {
    errors: { snapshot: "Couldn't read Intelligence learning status: 503" },
  });
  const { watcher, timers } = setup([
    failing,
    failing,
    failing,
    failing,
    learningRead(),
  ]);
  await watcher.watch();
  for (let poll = 0; poll < 4; poll += 1) await timers.fire();
  assert.deepEqual(timers.delays, [5000, 30_000, 120_000, 120_000, 5000]);
});

test("a reader that keeps throwing backs off the same way", async () => {
  const { watcher, timers } = setup([new Error("socket hang up")]);
  await watcher.watch();
  await timers.fire();
  await timers.fire();
  assert.deepEqual(timers.delays, [5000, 30_000, 120_000]);
});

test("a source that fails only now and then keeps the usual interval", async () => {
  const failing = learningRead(null, {
    errors: { snapshot: "Couldn't read Intelligence learning status: 503" },
  });
  const { watcher, timers } = setup([
    failing,
    learningRead(),
    failing,
    learningRead(),
  ]);
  await watcher.watch();
  for (let poll = 0; poll < 3; poll += 1) await timers.fire();
  assert.deepEqual(timers.delays, [5000, 5000, 5000, 5000]);
});

test("a Memory Intelligence refused asks nothing, so it does not slow the polls", async () => {
  const refused = {
    ...learningRead(
      {},
      { memories: null, errors: { memories: "Memory isn't enabled." } },
    ),
    memoryUnavailable: true,
  };
  const { watcher, timers } = setup([refused]);
  await watcher.watch();
  await timers.fire();
  await timers.fire();
  assert.deepEqual(timers.delays, [5000, 5000, 5000]);
  assert.equal(watcher.status.phase, "setup");
  assert.equal(watcher.status.memoryUnavailable, true);
});

test("Check learning now asks the reader to recheck once, and polls do not", async () => {
  const { watcher, timers, rechecks } = setup([learningRead()]);
  await watcher.watch();
  await watcher.watch({ recheck: true });
  await timers.fire();
  await watcher.watch();
  assert.deepEqual(rechecks, [false, true, false, false]);
});

test("Check learning now during a read follows it with one that rechecks", async () => {
  const releases: (() => void)[] = [];
  const rechecks: boolean[] = [];
  const watcher = new LearningWatcher({
    source: () => (options) => {
      rechecks.push(options?.recheck === true);
      return new Promise<LearningRead>((resolve) => {
        releases.push(() => resolve(learningRead()));
      });
    },
    onChange: () => {},
    schedule: fakeSchedule().schedule,
  });
  const first = watcher.watch();
  const checked = watcher.watch({ recheck: true });
  releases[0]();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  releases[1]();
  await checked;
  assert.deepEqual(rechecks, [false, true]);
});
