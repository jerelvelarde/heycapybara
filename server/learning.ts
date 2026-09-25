import type { CopilotKitIntelligence } from "@copilotkit/runtime/v2";
import type { LearningStatus } from "../src/types";
import { safeAgentError, type StreamRunner } from "./codex-agent";
import type { DeliveredSkill } from "./learned-skills";
import { memoryPreview, type MemoryNote } from "./memory";

/** The Learning projection Intelligence returns (InspectorLearningSnapshotV1). */
export type InspectorLearning = Awaited<
  ReturnType<CopilotKitIntelligence["getInspectorLearning"]>
>;

/** One read of both learning paths. A null source has its reason in errors. */
export type LearningRead = {
  containerId: string;
  snapshot: InspectorLearning | null;
  skills: readonly DeliveredSkill[] | null;
  memories: readonly MemoryNote[] | null;
  errors: {
    snapshot: string | null;
    skills: string | null;
    memories: string | null;
  };
};
export type LearningReader = () => Promise<LearningRead>;
export type LearningBaseline = {
  skills: ReadonlySet<string>;
  memories: ReadonlySet<string>;
};

export const LEARNING_OFF: LearningStatus = {
  phase: "off",
  message: "Connect CopilotKit Intelligence to learn from your conversations.",
  link: null,
  skills: [],
  newSkills: [],
  memories: null,
  newMemories: [],
  memoryError: null,
  insight: null,
  checkedAt: null,
};

export const LEARNING_UNCHECKED: LearningStatus = {
  phase: "idle",
  message: "Checking Intelligence for what OpenMuse has learned.",
  link: null,
  skills: [],
  newSkills: [],
  memories: null,
  newMemories: [],
  memoryError: null,
  insight: null,
  checkedAt: null,
};

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? "" : "s"}`;

function link(
  kind: "learning" | "runs" | "candidates",
  url: string | null,
): LearningStatus["link"] {
  return url ? { kind, url } : null;
}

function setupMessage(
  configuration: InspectorLearning["configuration"],
  containerId: string,
): string | undefined {
  switch (configuration.state) {
    case "not_configured":
      return `Intelligence has no learning container for OpenMuse yet. Create "${containerId}" in Intelligence.`;
    case "selection_required":
      return `Intelligence needs a learning container chosen for OpenMuse. Choose "${containerId}" in Intelligence.`;
    case "invalid":
      return configuration.reason === "container"
        ? `Intelligence can't use the learning container "${containerId}". Check it in Intelligence.`
        : `Intelligence reports OpenMuse's learning setup as invalid (instrumentation). Check "${containerId}" in Intelligence.`;
    case "configured":
      return configuration.container.id === containerId
        ? undefined
        : `Intelligence is set to learning container "${configuration.container.id}", but OpenMuse saves conversations to "${containerId}".`;
  }
}

/**
 * Turns one read of Intelligence into the step the user is on.
 *
 * Something new that Intelligence learned comes first, because it is the
 * moment the demo is about. A new memory needs no learning container, so it
 * is reported even when the skills path is not set up. Otherwise the
 * skills-path steps follow in order: the ones that need a person (review,
 * then starting an analysis) before the ones that are waiting.
 */
export function describeLearning(
  read: LearningRead,
  baseline: LearningBaseline,
  now: Date,
): LearningStatus {
  const { snapshot, containerId, errors } = read;
  const skills = (read.skills ?? []).map((skill) => skill.name).sort();
  const newSkills = skills.filter((name) => !baseline.skills.has(name));
  const newMemories = (read.memories ?? [])
    .filter((memory) => !baseline.memories.has(memory.id))
    .map((memory) => memoryPreview(memory.content));
  const common = {
    skills,
    newSkills,
    memories: read.memories ? read.memories.length : null,
    newMemories,
    memoryError: errors.memories,
    insight: snapshot?.insightsPage.items[0]?.statement ?? null,
    checkedAt: now.toISOString(),
  };
  if (newMemories.length && !newSkills.length)
    return {
      ...common,
      phase: "learned",
      message:
        newMemories.length === 1
          ? `Intelligence learned from your conversations: "${newMemories[0]}"`
          : `Intelligence learned ${newMemories.length} things from your conversations, including "${newMemories[0]}"`,
      link: null,
    };
  if (!snapshot)
    return {
      ...common,
      phase: "error",
      message: errors.snapshot ?? "Couldn't read Intelligence learning status.",
      link: null,
    };
  const setup = setupMessage(snapshot.configuration, containerId);
  if (setup)
    return {
      ...common,
      phase: "setup",
      message: setup,
      link: link("learning", snapshot.links.learning),
    };
  if (!read.skills)
    return {
      ...common,
      phase: "error",
      message: errors.skills ?? "Couldn't read learned skills.",
      link: null,
    };
  if (newSkills.length)
    return {
      ...common,
      phase: "learned",
      message:
        newSkills.length === 1
          ? `Learned "${newSkills[0]}". New conversations can use it.`
          : `Learned ${newSkills.length} skills: ${newSkills.join(", ")}. New conversations can use them.`,
      link: null,
    };
  if (snapshot.pendingCandidateCount > 0)
    return {
      ...common,
      phase: "review",
      message: `${plural(snapshot.pendingCandidateCount, "skill")} ready for your review in Intelligence.`,
      link: link("candidates", snapshot.links.candidates),
    };
  if (snapshot.run.hasActiveRun)
    return {
      ...common,
      phase: "analyzing",
      message: `Intelligence is learning from your conversations (${snapshot.run.latest?.status ?? "queued"}).`,
      link: link("runs", snapshot.links.runs),
    };
  if (snapshot.pendingThreadCount > 0)
    return {
      ...common,
      phase: "waiting",
      message: `${plural(snapshot.pendingThreadCount, "conversation")} ready to learn from. Start an analysis in Intelligence.`,
      link: link("runs", snapshot.links.runs),
    };
  if (snapshot.run.latest?.status === "failed")
    return {
      ...common,
      phase: "error",
      message:
        "The last Intelligence analysis failed. Open Intelligence to see why.",
      link: link("learning", snapshot.links.learning),
    };
  return {
    ...common,
    phase: "idle",
    message: skills.length
      ? `${plural(skills.length, "learned skill")} available.`
      : "No learned skills yet.",
    link: null,
  };
}

/** A read that failed outright: keep what was known, and say what failed. */
export function learningError(
  error: unknown,
  previous: LearningStatus,
  now: Date,
): LearningStatus {
  return {
    ...previous,
    phase: "error",
    message:
      error instanceof Error
        ? error.message
        : `Couldn't check Intelligence learning: ${String(error)}`,
    link: null,
    checkedAt: now.toISOString(),
  };
}

/**
 * One read of both learning paths, in parallel. It never rejects: a source
 * that fails, or is not connected, comes back null with its reason (key-shaped
 * text redacted), so one failing path never hides the other.
 */
export function createLearningReader(sources: {
  containerId: string;
  inspect?: () => Promise<InspectorLearning>;
  skills?: () => Promise<readonly DeliveredSkill[]>;
  memories?: () => Promise<readonly MemoryNote[]>;
}): LearningReader {
  async function settle<T>(label: string, work?: () => Promise<T>) {
    if (!work) return { value: null, error: `${label}: not connected.` };
    try {
      return { value: await work(), error: null };
    } catch (error) {
      return {
        value: null,
        error: `${label}: ${safeAgentError(error instanceof Error ? error : new Error(String(error)))}`,
      };
    }
  }
  return async () => {
    const [snapshot, skills, memories] = await Promise.all([
      settle("Couldn't read Intelligence learning status", sources.inspect),
      settle("Couldn't read learned skills", sources.skills),
      settle("Couldn't read Intelligence Memory", sources.memories),
    ]);
    return {
      containerId: sources.containerId,
      snapshot: snapshot.value,
      skills: skills.value,
      memories: memories.value,
      errors: {
        snapshot: snapshot.error,
        skills: skills.error,
        memories: memories.error,
      },
    };
  };
}

/**
 * Wraps the agent's stream so `onSettled` hears about every run's end:
 * success, failure or Stop. A failing callback is logged and never replaces
 * the run's own outcome.
 */
export function settleAfter(
  stream: StreamRunner,
  onSettled: (threadId: string) => void,
): StreamRunner {
  return async function* (input, signal) {
    try {
      yield* stream(input, signal);
    } finally {
      try {
        onSettled(input.threadId);
      } catch (error) {
        console.error(
          "Learning status could not start watching after a run:",
          error instanceof Error ? error.message : error,
        );
      }
    }
  };
}
