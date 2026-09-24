import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadCompanion, saveCompanion } from "../electron/preferences";

test("companion defaults to capybara and persists both choices privately", async () => {
  const directory = await mkdtemp(join(tmpdir(), "companion-"));
  try {
    const path = join(directory, "preferences.json");
    assert.equal(await loadCompanion(path), "capybara");
    await saveCompanion(path, "kite");
    assert.equal(await loadCompanion(path), "kite");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(saveCompanion(path, "other"));
    assert.equal(await loadCompanion(path), "kite");
    await saveCompanion(path, "capybara");
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      companion: "capybara",
    });
    await writeFile(path, '{"companion":"invalid"}');
    await assert.rejects(loadCompanion(path));
    await writeFile(path, "broken json");
    await assert.rejects(loadCompanion(path));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
