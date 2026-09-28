import {
  LEARNING_OFF,
  LEARNING_UNCHECKED,
  describeLearning,
  learningError,
  type LearningRead,
  type LearningReader,
} from "../server/learning";
import type { LearningStatus } from "../src/types";

export type Schedule = (run: () => Promise<void>, ms: number) => () => void;

const realSchedule: Schedule = (run, ms) => {
  const timer = setTimeout(() => void run(), ms);
  return () => clearTimeout(timer);
};

/**
 * Polls Intelligence while something there may be changing, for `windowMs`
 * after each watch(): app start, a finished run, a lesson saved, a step
 * opened in Intelligence. The main process has no push channel for either
 * path (Memory's realtime channels are browser-side and need memory.access),
 * so it polls every 5 seconds, as CopilotKit's own Inspector does.
 *
 * `source` is read on every poll, so a runtime whose Intelligence client is
 * replaced (a new key) is picked up without rebuilding the watcher.
 *
 * A source that keeps failing slows the polls: after consecutive failures of
 * the same source the next poll waits `intervalMs`, then each of `backoffMs`
 * in turn (30 seconds, then 2 minutes), until a read of it succeeds. A Memory
 * that Intelligence refused for good makes no request, so it is not counted.
 */
export class LearningWatcher {
  #status: LearningStatus;
  #skillBaseline: Set<string> | undefined;
  #memoryBaseline: Set<string> | undefined;
  readonly #mine = new Set<string>();
  readonly #taught = new Set<string>();
  #last: LearningRead | undefined;
  #until = 0;
  #cancel: (() => void) | undefined;
  #reading: Promise<void> | undefined;
  #stopped = false;
  #recheck = false;
  // Consecutive failed reads, per source ("read" is the reader throwing).
  readonly #failures = new Map<string, number>();
  readonly #source: () => LearningReader | undefined;
  readonly #onChange: (status: LearningStatus) => void;
  readonly #now: () => number;
  readonly #schedule: Schedule;
  readonly #intervalMs: number;
  readonly #windowMs: number;
  readonly #backoffMs: readonly number[];

  constructor(options: {
    source: () => LearningReader | undefined;
    onChange: (status: LearningStatus) => void;
    now?: () => number;
    schedule?: Schedule;
    intervalMs?: number;
    windowMs?: number;
    backoffMs?: readonly number[];
  }) {
    this.#source = options.source;
    this.#onChange = options.onChange;
    this.#now = options.now ?? (() => Date.now());
    this.#schedule = options.schedule ?? realSchedule;
    this.#intervalMs = options.intervalMs ?? 5000;
    this.#windowMs = options.windowMs ?? 30 * 60_000;
    this.#backoffMs = options.backoffMs ?? [30_000, 2 * 60_000];
    this.#status = options.source() ? LEARNING_UNCHECKED : LEARNING_OFF;
  }

  get status() {
    return this.#status;
  }

  /**
   * Reads now (or joins the read in flight) and keeps polling for the window.
   * `recheck` ("Check learning now") also asks a refused Memory once more; a
   * read already in flight is followed by one that does.
   */
  watch(options?: { recheck?: boolean }): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    this.#until = this.#now() + this.#windowMs;
    if (options?.recheck) this.#recheck = true;
    if (this.#reading)
      return options?.recheck
        ? this.#reading.then(() => (this.#recheck ? this.watch() : undefined))
        : this.#reading;
    this.#cancel?.();
    this.#cancel = undefined;
    return this.#tick();
  }

  /**
   * Call before saving a lesson from `threadId`. A poll can list the lesson
   * before createMemory returns its id, so every memory sourced from a taught
   * thread is treated as the user's own, during the save and after it.
   */
  expectLesson(threadId: string) {
    this.#taught.add(threadId);
  }

  /** A memory OpenMuse saved itself: never announce it as Intelligence's. */
  remember(memoryId: string) {
    this.#mine.add(memoryId);
  }

  /** The user has seen what is new: stop announcing it. */
  acknowledge() {
    if (!this.#last) return;
    for (const name of this.#status.newSkills) this.#skillBaseline?.add(name);
    for (const memory of this.#last.memories ?? [])
      this.#memoryBaseline?.add(memory.id);
    this.#publish(this.#describe(this.#last));
  }

  stop() {
    this.#stopped = true;
    this.#cancel?.();
    this.#cancel = undefined;
  }

  #describe(read: LearningRead) {
    return describeLearning(
      read,
      {
        skills: this.#skillBaseline ?? new Set(),
        memories: new Set([
          ...(this.#memoryBaseline ?? []),
          ...this.#mine,
          ...(read.memories ?? [])
            .filter((memory) =>
              memory.sourceThreadIds.some((id) => this.#taught.has(id)),
            )
            .map((memory) => memory.id),
        ]),
      },
      new Date(this.#now()),
    );
  }

  #tick(): Promise<void> {
    const reading = this.#read().finally(() => {
      this.#reading = undefined;
      if (
        this.#stopped ||
        this.#status.phase === "off" ||
        this.#now() >= this.#until
      )
        return;
      this.#cancel = this.#schedule(() => {
        this.#cancel = undefined;
        return this.#tick();
      }, this.#delay());
    });
    this.#reading = reading;
    return reading;
  }

  /** The wait before the next poll, given the longest failing streak. */
  #delay() {
    const streak = Math.max(0, ...this.#failures.values());
    if (streak < 2) return this.#intervalMs;
    return (
      this.#backoffMs[Math.min(streak - 2, this.#backoffMs.length - 1)] ??
      this.#intervalMs
    );
  }

  #count(source: string, failed: boolean) {
    if (failed)
      this.#failures.set(source, (this.#failures.get(source) ?? 0) + 1);
    else this.#failures.delete(source);
  }

  async #read() {
    const reader = this.#source();
    if (!reader) {
      this.#failures.clear();
      this.#publish(LEARNING_OFF);
      return;
    }
    const recheck = this.#recheck;
    this.#recheck = false;
    try {
      const read = await reader(recheck ? { recheck } : undefined);
      this.#count("read", false);
      this.#count("snapshot", read.errors.snapshot !== null);
      this.#count("skills", read.errors.skills !== null);
      this.#count(
        "memories",
        read.errors.memories !== null && !read.memoryUnavailable,
      );
      if (read.skills)
        this.#skillBaseline ??= new Set(read.skills.map((skill) => skill.name));
      if (read.memories)
        this.#memoryBaseline ??= new Set(
          read.memories.map((memory) => memory.id),
        );
      this.#last = read;
      this.#publish(this.#describe(read));
    } catch (error) {
      this.#count("read", true);
      this.#publish(learningError(error, this.#status, new Date(this.#now())));
    }
  }

  #publish(next: LearningStatus) {
    const same =
      JSON.stringify({ ...next, checkedAt: null }) ===
      JSON.stringify({ ...this.#status, checkedAt: null });
    this.#status = next;
    if (same || this.#stopped) return;
    // A failing listener must not reject watch(), which callers fire and forget.
    try {
      this.#onChange(next);
    } catch (error) {
      console.error(
        "Learning status changed but could not be sent to the windows:",
        error instanceof Error ? error.message : error,
      );
    }
  }
}
