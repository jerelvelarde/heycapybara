import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadCompanion,
  loadPreferences,
  saveCompanion,
  savePreferences,
} from "../electron/preferences";

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
      placement: "notch",
      onboardingComplete: false,
    });
    await writeFile(path, '{"companion":"invalid"}');
    await assert.rejects(loadCompanion(path));
    await writeFile(path, "broken json");
    await assert.rejects(loadCompanion(path));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("new installs and legacy preferences start in notch onboarding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "notch-preferences-"));
  try {
    const path = join(directory, "preferences.json");
    assert.deepEqual(await loadPreferences(path), {
      companion: "capybara",
      placement: "notch",
      onboardingComplete: false,
    });
    await writeFile(path, '{"companion":"kite"}');
    assert.deepEqual(await loadPreferences(path), {
      companion: "kite",
      placement: "notch",
      onboardingComplete: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preferences persist all fields atomically and privately", async () => {
  const directory = await mkdtemp(join(tmpdir(), "notch-preferences-"));
  try {
    const path = join(directory, "preferences.json");
    const preferences = {
      companion: "kite" as const,
      placement: "floating" as const,
      onboardingComplete: true,
    };
    assert.deepEqual(await savePreferences(path, preferences), preferences);
    assert.deepEqual(await loadPreferences(path), preferences);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await saveCompanion(path, "capybara");
    assert.deepEqual(await loadPreferences(path), {
      ...preferences,
      companion: "capybara",
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed present preference fields fail rather than resetting onboarding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "notch-preferences-"));
  try {
    const path = join(directory, "preferences.json");
    for (const contents of [
      '{"companion":"kite","placement":"invalid"}',
      '{"companion":"kite","onboardingComplete":"true"}',
      '{"companion":"invalid"}',
    ]) {
      await writeFile(path, contents);
      await assert.rejects(loadPreferences(path));
    }
    await assert.rejects(
      savePreferences(path, {
        companion: "kite",
        placement: "invalid",
        onboardingComplete: true,
      }),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
