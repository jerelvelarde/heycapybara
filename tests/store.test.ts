import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Store,
  validateSkillMarkdown,
  recordingEvidence,
} from "../electron/store";
const fixture = async () =>
  new Store(await mkdtemp(join(tmpdir(), "kite-test-")));
const md =
  "---\nname: weekly-report\ndescription: Prepare a weekly report\n---\n\n# Weekly report\n\n1. Open Notes.\n2. Verify the report.";
test("recording survives restart and rejects overlapping sessions", async () => {
  const store = await fixture();
  await store.load();
  const r = await store.start("Weekly report");
  await assert.rejects(store.start("Other"), /already/);
  await store.append({
    id: "event-1",
    timestamp: new Date().toISOString(),
    kind: "app",
    app: "Notes",
    bundleId: "com.apple.Notes",
    title: "Weekly",
    detail: "Activated Notes",
  });
  await store.stop();
  const again = new Store(store.root);
  await again.load();
  assert.equal(again.recordings[0].id, r.id);
  assert.equal(again.recordings[0].events.length, 1);
  assert.equal(again.active, null);
});
test("only approved skills enter catalog, edits require reapproval", async () => {
  const s = await fixture();
  await s.load();
  const r = await s.start("Demo");
  await s.stop();
  const draft = await s.saveSkill({
    name: "Weekly report",
    markdown: md,
    recordingId: r.id,
    approve: false,
  });
  assert.equal(s.approvedSkills().length, 0);
  await s.saveSkill({ ...draft, approve: true });
  assert.equal(s.approvedSkills().length, 1);
  await s.saveSkill({
    ...draft,
    markdown: md + "\n3. Review.",
    approve: false,
  });
  assert.equal(s.approvedSkills().length, 0);
});
test("rejects path traversal, unknown recordings and malformed skills", async () => {
  const s = await fixture();
  await s.load();
  await assert.rejects(
    s.saveSkill({
      id: "../../x",
      name: "X",
      markdown: md,
      recordingId: "unknown",
      approve: true,
    }),
  );
  assert.throws(() => validateSkillMarkdown("# no frontmatter"), /frontmatter/);
  assert.throws(
    () =>
      validateSkillMarkdown("---\nname: ../bad\ndescription: x\n---\n# Bad"),
    /name/,
  );
});
test("install user id is created once and reused across restarts", async () => {
  const store = await fixture();
  await store.load();
  const id = store.installUserId;
  assert.match(id, /^openmuse-/);
  const again = new Store(store.root);
  await again.load();
  assert.equal(again.installUserId, id);
});
test("deleted evidence stays deleted and is excluded from prompts", async () => {
  const s = await fixture();
  await s.load();
  const r = await s.start("Demo");
  await s.append({
    id: "sensitive",
    timestamp: new Date().toISOString(),
    kind: "note",
    app: "User",
    bundleId: "",
    title: "",
    detail: "remove me",
  });
  await s.stop();
  await s.removeEvent(r.id, "sensitive");
  assert.equal(recordingEvidence(s.recordings[0]).includes("remove me"), false);
  const persisted = await readFile(
    join(s.root, "recordings", r.id + ".json"),
    "utf8",
  );
  assert.equal(persisted.includes("remove me"), false);
});
