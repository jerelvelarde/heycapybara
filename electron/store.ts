import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { CaptureEvent, Recording, Skill } from "../src/types";

const validId = (id: string) => {
  if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw new Error("Invalid identifier");
  return id;
};
import { validateSkillMarkdown } from "../src/skill-format";
export { validateSkillMarkdown } from "../src/skill-format";
export function recordingEvidence(recording: Recording) {
  return JSON.stringify({
    title: recording.title,
    startedAt: recording.startedAt,
    stoppedAt: recording.stoppedAt,
    events: recording.events.filter(
      (e) => e.kind !== "error" && e.kind !== "status",
    ),
  });
}
export class Store {
  recordings: Recording[] = [];
  skills: Skill[] = [];
  active: Recording | null = null;
  private writes = Promise.resolve();
  constructor(public readonly root: string) {}
  private async write(folder: string, id: string, value: unknown) {
    const file = join(this.root, folder, validId(id) + ".json");
    const contents = JSON.stringify(value, null, 2);
    const work = this.writes.then(async () => {
      const temp = file + ".tmp";
      await writeFile(temp, contents, { mode: 0o600 });
      await rename(temp, file);
    });
    this.writes = work.catch(() => {}); // Each caller receives its failure; keep the queue usable.
    await work;
  }
  async load() {
    for (const dir of ["recordings", "skills"])
      await mkdir(join(this.root, dir), { recursive: true, mode: 0o700 });
    const load = async <T>(dir: string): Promise<T[]> =>
      Promise.all(
        (await readdir(join(this.root, dir)))
          .filter((f) => f.endsWith(".json"))
          .map(
            async (f) =>
              JSON.parse(await readFile(join(this.root, dir, f), "utf8")) as T,
          ),
      );
    this.recordings = (await load<Recording>("recordings")).sort((a, b) =>
      b.startedAt.localeCompare(a.startedAt),
    );
    this.skills = (await load<Skill>("skills")).sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
    // A process crash never resumes observation without a fresh explicit start.
    for (const r of this.recordings.filter((r) => !r.stoppedAt)) {
      r.stoppedAt = r.events.at(-1)?.timestamp ?? r.startedAt;
      await this.write("recordings", r.id, r);
    }
  }
  async flush() {
    await this.writes;
  }
  async start(title: string) {
    if (this.active) throw new Error("A recording is already active");
    if (!title.trim() || title.length > 160)
      throw new Error("Enter a workflow name (1–160 characters)");
    const r: Recording = {
      id: randomUUID(),
      title: title.trim(),
      startedAt: new Date().toISOString(),
      events: [],
    };
    this.active = r;
    try {
      await this.write("recordings", r.id, r);
      this.recordings.unshift(r);
      return r;
    } catch (e) {
      this.active = null;
      throw e;
    }
  }
  async append(event: CaptureEvent) {
    if (!this.active) throw new Error("No recording is active");
    if (this.active.events.length >= 3000)
      throw new Error(
        "Recording reached 3,000 events. Stop and start a new workflow.",
      );
    this.active.events.push(event);
    await this.write("recordings", this.active.id, this.active);
  }
  async stop() {
    if (!this.active) throw new Error("No recording is active");
    const r = this.active;
    r.stoppedAt = new Date().toISOString();
    await this.write("recordings", r.id, r);
    this.active = null;
    return r;
  }
  async removeEvent(id: string, eventId: string) {
    const r = this.recordings.find((r) => r.id === id);
    if (!r) throw new Error("Recording not found");
    if (this.active?.id === id)
      throw new Error("Stop recording before editing evidence");
    r.events = r.events.filter((e) => e.id !== eventId);
    await this.write("recordings", id, r);
  }
  async deleteRecording(id: string) {
    validId(id);
    if (this.active?.id === id)
      throw new Error("Stop recording before deleting");
    await this.writes;
    await rm(join(this.root, "recordings", id + ".json"), { force: true });
    this.recordings = this.recordings.filter((r) => r.id !== id);
  }
  async saveSkill(input: {
    id?: string;
    name: string;
    markdown: string;
    recordingId: string;
    approve: boolean;
  }) {
    validateSkillMarkdown(input.markdown);
    if (!input.name.trim() || input.name.length > 160)
      throw new Error("Skill title is required (max 160 characters)");
    if (input.id) validId(input.id);
    const existing = input.id
      ? this.skills.find((s) => s.id === input.id)
      : undefined;
    if (input.id && !existing) throw new Error("Skill not found");
    if (
      !existing &&
      !this.recordings.some((r) => r.id === input.recordingId && r.stoppedAt)
    )
      throw new Error("A completed recording is required");
    const skill: Skill = {
      id: existing?.id ?? randomUUID(),
      name: input.name.trim(),
      markdown: input.markdown,
      recordingId: existing?.recordingId ?? input.recordingId,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      ...(input.approve ? { approvedAt: new Date().toISOString() } : {}),
    };
    await this.write("skills", skill.id, skill);
    this.skills = [skill, ...this.skills.filter((s) => s.id !== skill.id)];
    return skill;
  }
  approvedSkills() {
    return this.skills.filter((s) => s.approvedAt);
  }
  async deleteSkill(id: string) {
    validId(id);
    await this.writes;
    await rm(join(this.root, "skills", id + ".json"), { force: true });
    this.skills = this.skills.filter((s) => s.id !== id);
  }
}
