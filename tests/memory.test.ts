import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LESSON_GRANT,
  READ_GRANT,
  createMemoryAccess,
  memoryNotes,
  memoryPreview,
  type MemoryClient,
} from "../server/memory";

// Stands in for CopilotKitIntelligence's Memory REST calls and records what
// OpenMuse sends.
function fakeMemoryClient() {
  const calls: { method: string; params: unknown }[] = [];
  const row = (id: string, content: string, invalidatedAt: string | null) => ({
    id,
    kind: "operational",
    scope: "user",
    content,
    sourceThreadIds: ["thread-1"],
    invalidatedAt,
  });
  const client: MemoryClient = {
    listMemories: async (params) => {
      calls.push({ method: "list", params });
      return {
        memories: [
          row("m1", "Keep", null),
          row("m2", "Retired", "2026-09-01T00:00:00Z"),
        ],
      };
    },
    recallMemories: async (params) => {
      calls.push({ method: "recall", params });
      return {
        memories: [{ ...row("m3", "How to: label spam", null), score: 0.9 }],
      };
    },
    createMemory: async (params) => {
      calls.push({ method: "create", params });
      return { ...row("m4", params.content, null), absorbed: false };
    },
  };
  return { client, calls };
}

test("listing memories reads both scopes and keeps only live ones", async () => {
  const { client, calls } = fakeMemoryClient();
  const memories = await createMemoryAccess(client, "kite-local-owner").list();
  assert.deepEqual(
    memories.map((memory) => memory.id),
    ["m1"],
  );
  assert.deepEqual(calls, [
    {
      method: "list",
      params: { userId: "kite-local-owner", memoryGrant: READ_GRANT },
    },
  ]);
  assert.deepEqual(READ_GRANT, { user: "read", project: "read" });
});

test("recall asks by meaning with a bounded query and a read-only grant", async () => {
  const { client, calls } = fakeMemoryClient();
  const recalled = await createMemoryAccess(client, "kite-local-owner").recall(
    "x".repeat(1200),
  );
  assert.deepEqual(
    recalled.map((memory) => memory.content),
    ["How to: label spam"],
  );
  assert.deepEqual(calls[0], {
    method: "recall",
    params: {
      userId: "kite-local-owner",
      memoryGrant: READ_GRANT,
      query: "x".repeat(1000),
      limit: 5,
    },
  });
});

test("a lesson is saved as the user's own operational memory, linked to its thread", async () => {
  const { client, calls } = fakeMemoryClient();
  const saved = await createMemoryAccess(client, "kite-local-owner").saveLesson(
    { threadId: "thread-9", content: "How to: label spam" },
  );
  assert.deepEqual(saved, { id: "m4", absorbed: false });
  assert.deepEqual(calls[0], {
    method: "create",
    params: {
      userId: "kite-local-owner",
      memoryGrant: LESSON_GRANT,
      content: "How to: label spam",
      kind: "operational",
      scope: "user",
      sourceThreadIds: ["thread-9"],
    },
  });
  assert.deepEqual(LESSON_GRANT, { user: "read-write", project: "none" });
});

test("recalled memories open a prompt as numbered, untrusted notes", () => {
  const text = memoryNotes([
    { kind: "operational", content: "How to: label spam" },
    { kind: "topical", content: "The user reads mail in Chrome" },
  ]);
  assert.match(text, /^What CopilotKit Intelligence remembers/);
  assert.match(text, /untrusted/);
  assert.match(text, /\n1\. \[operational\] How to: label spam\n/);
  assert.match(text, /\n2\. \[topical\] The user reads mail in Chrome\n/);
});

test("a memory preview is its first line, at most 120 characters", () => {
  assert.equal(
    memoryPreview("  How to: label spam\nSteps: …"),
    "How to: label spam",
  );
  const long = memoryPreview("y".repeat(200));
  assert.equal(long.length, 120);
  assert.ok(long.endsWith("…"));
});
