import type { InspectorLearning, LearningRead } from "../server/learning";
import type { MemoryNote } from "../server/memory";

// Builds the Inspector Learning snapshot @copilotkit/runtime 1.73.3 returns
// from getInspectorLearning (validated by parseInspectorLearningSnapshotV1 in
// @copilotkit/shared): a configured desktop-workflows container with nothing
// pending, unless a test overrides part of it.
export type SnapshotOverrides = {
  configuration?: InspectorLearning["configuration"];
  pendingThreadCount?: number;
  pendingCandidateCount?: number;
  run?: Partial<InspectorLearning["run"]>;
  links?: Partial<InspectorLearning["links"]>;
  insight?: string;
};

const ORIGIN = "https://intelligence.example.test";

export function inspectorSnapshot(
  overrides: SnapshotOverrides = {},
): InspectorLearning {
  const insights = overrides.insight
    ? [
        {
          id: "insight-1",
          statement: overrides.insight,
          impact: "Saves a step",
          totalThreadCount: 1,
          evidenceTruncated: false,
          evidence: [],
        },
      ]
    : [];
  return {
    schemaVersion: 1,
    projectKey: "kite",
    snapshotVersion: "snapshot-1",
    webAppOrigin: ORIGIN,
    configuration: overrides.configuration ?? {
      state: "configured",
      container: { id: "desktop-workflows", name: "Desktop workflows" },
    },
    pendingThreadCount: overrides.pendingThreadCount ?? 0,
    pendingCandidateCount: overrides.pendingCandidateCount ?? 0,
    run: {
      hasActiveRun: false,
      hasEverSucceeded: false,
      latest: null,
      ...overrides.run,
    },
    skillsPage: { page: 1, pageSize: 3, total: 0, totalPages: 0, items: [] },
    insightsPage: {
      page: 1,
      pageSize: 4,
      total: insights.length,
      totalPages: insights.length ? 1 : 0,
      items: insights,
    },
    links: {
      learning: `${ORIGIN}/learning`,
      candidates: `${ORIGIN}/learning/candidates`,
      runs: `${ORIGIN}/learning/runs`,
      ...overrides.links,
    },
  };
}

export function memory(id: string, content: string): MemoryNote {
  return {
    id,
    kind: "operational",
    scope: "user",
    content,
    sourceThreadIds: ["thread-1"],
  };
}

export function learningRead(
  overrides: SnapshotOverrides | null = {},
  extra: {
    skills?: string[] | null;
    memories?: MemoryNote[] | null;
    errors?: Partial<LearningRead["errors"]>;
  } = {},
): LearningRead {
  const skills = extra.skills === undefined ? [] : extra.skills;
  return {
    containerId: "desktop-workflows",
    snapshot: overrides === null ? null : inspectorSnapshot(overrides),
    skills:
      skills === null
        ? null
        : skills.map((name) => ({ name, description: `Does ${name}` })),
    memories: extra.memories === undefined ? [] : extra.memories,
    errors: { snapshot: null, skills: null, memories: null, ...extra.errors },
  };
}
