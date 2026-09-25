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
 */
export class LearningWatcher {
  #status: LearningStatus;
  #skillBaseline: Set<string> | undefined;
  #memoryBaseline: Set<string> | undefined;
  readonly #mine = new Set<string>();
  #last: LearningRead | undefined;
  #until = 0;
  #cancel: (() => void) | undefined;
  #reading: Promise<void> | undefined;
  #stopped = false;
  readonly #source: () => LearningReader | undefined;
  readonly #onChange: (status: LearningStatus) => void;
  readonly #now: () => number;
  readonly #schedule: Schedule;
  readonly #intervalMs: number;
  readonly #windowMs: number;

  constructor(options: {
    source: () => LearningReader | undefined;
    onChange: (status: LearningStatus) => void;
    now?: () => number;
    schedule?: Schedule;
    intervalMs?: number;
    windowMs?: number;
  }) {
    this.#source = options.source;
    this.#onChange = options.onChange;
    this.#now = options.now ?? (() => Date.now());
    this.#schedule = options.schedule ?? realSchedule;
    this.#intervalMs = options.intervalMs ?? 5000;
    this.#windowMs = options.windowMs ?? 30 * 60_000;
    this.#status = options.source() ? LEARNING_UNCHECKED : LEARNING_OFF;
  }

  get status() {
    return this.#status;
  }

  /** Reads now (or joins the read in flight) and keeps polling for the window. */
  watch(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    this.#until = this.#now() + this.#windowMs;
    if (this.#reading) return this.#reading;
    this.#cancel?.();
    this.#cancel = undefined;
    return this.#tick();
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
        memories: new Set([...(this.#memoryBaseline ?? []), ...this.#mine]),
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
      }, this.#intervalMs);
    });
    this.#reading = reading;
    return reading;
  }

  async #read() {
    const reader = this.#source();
    if (!reader) {
      this.#publish(LEARNING_OFF);
      return;
    }
    try {
      const read = await reader();
      if (read.skills)
        this.#skillBaseline ??= new Set(read.skills.map((skill) => skill.name));
      if (read.memories)
        this.#memoryBaseline ??= new Set(
          read.memories.map((memory) => memory.id),
        );
      this.#last = read;
      this.#publish(this.#describe(read));
    } catch (error) {
      this.#publish(learningError(error, this.#status, new Date(this.#now())));
    }
  }

  #publish(next: LearningStatus) {
    const same =
      JSON.stringify({ ...next, checkedAt: null }) ===
      JSON.stringify({ ...this.#status, checkedAt: null });
    this.#status = next;
    if (!same) this.#onChange(next);
  }
}
