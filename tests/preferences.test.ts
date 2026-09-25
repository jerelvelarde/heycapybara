import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
  stat,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import {
  loadPreferences,
  savePreferences,
  startupPreferences,
} from "../electron/preferences";

// Every rejection check names the failure it expects, so an unrelated error cannot pass it.
const unreadable = (path: string) => (error: unknown) =>
  error instanceof Error &&
  error.message.startsWith(`Could not read ${path}: `) &&
  error.message.endsWith(" Fix or delete this file, then reopen OpenMuse.");
const unsaved = (path: string) => (error: unknown) =>
  error instanceof Error &&
  error.message.startsWith(`Could not save ${path}: `) &&
  error.message.endsWith(
    " Check free disk space and folder permissions, then try again.",
  );
const missing = (error: unknown) =>
  (error as NodeJS.ErrnoException).code === "ENOENT";

test("companion defaults to capybara and persists both choices privately", async () => {
  const directory = await mkdtemp(join(tmpdir(), "companion-"));
  try {
    const path = join(directory, "preferences.json");
    assert.equal((await loadPreferences(path, false)).companion, "capybara");
    await savePreferences(path, {
      companion: "kite",
      onboardingComplete: false,
    });
    assert.equal((await loadPreferences(path, false)).companion, "kite");
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(
      savePreferences(path, { companion: "other", onboardingComplete: false }),
      z.ZodError,
    );
    assert.equal((await loadPreferences(path, false)).companion, "kite");
    await savePreferences(path, {
      companion: "capybara",
      onboardingComplete: false,
    });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      companion: "capybara",
      onboardingComplete: false,
    });
    await writeFile(path, '{"companion":"invalid"}');
    await assert.rejects(loadPreferences(path, false), unreadable(path));
    await writeFile(path, "broken json");
    await assert.rejects(loadPreferences(path, false), unreadable(path));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("new installs start setup; legacy preferences load without the removed notch placement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preferences-"));
  try {
    const path = join(directory, "preferences.json");
    assert.deepEqual(await loadPreferences(path, false), {
      companion: "capybara",
      onboardingComplete: false,
    });
    await writeFile(path, '{"companion":"kite"}');
    assert.deepEqual(await loadPreferences(path, false), {
      companion: "kite",
      onboardingComplete: true,
    });
    await writeFile(path, '{"companion":"kite","placement":"notch"}');
    assert.deepEqual(await loadPreferences(path, false), {
      companion: "kite",
      onboardingComplete: true,
    });
    for (const placement of ["notch", "floating"]) {
      await writeFile(
        path,
        JSON.stringify({
          companion: "kite",
          placement,
          onboardingComplete: false,
        }),
      );
      assert.deepEqual(await loadPreferences(path, false), {
        companion: "kite",
        onboardingComplete: false,
      });
    }
    await savePreferences(path, {
      ...(await loadPreferences(path, false)),
      companion: "capybara",
    });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      companion: "capybara",
      onboardingComplete: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a returning install without a preferences file skips setup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preferences-"));
  try {
    const path = join(directory, "preferences.json");
    assert.deepEqual(await loadPreferences(path, true), {
      companion: "capybara",
      onboardingComplete: true,
    });
    assert.deepEqual(await loadPreferences(path, false), {
      companion: "capybara",
      onboardingComplete: false,
    });
    await writeFile(path, '{"companion":"kite","onboardingComplete":false}');
    assert.deepEqual(await loadPreferences(path, true), {
      companion: "kite",
      onboardingComplete: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup writes preferences only for a new install without a file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preferences-"));
  try {
    const path = join(directory, "preferences.json");
    const library = join(directory, "library");
    assert.deepEqual(await startupPreferences(path, library), {
      companion: "capybara",
      onboardingComplete: false,
    });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      companion: "capybara",
      onboardingComplete: false,
    });

    // A returning install (the library exists) without a file skips setup and writes nothing.
    await mkdir(library);
    const otherPath = join(directory, "other-preferences.json");
    assert.deepEqual(await startupPreferences(otherPath, library), {
      companion: "capybara",
      onboardingComplete: true,
    });
    await assert.rejects(stat(otherPath), missing);

    // An existing file wins for either kind of install and is not rewritten.
    const thirdPath = join(directory, "third-preferences.json");
    const existing = JSON.stringify({
      companion: "kite",
      onboardingComplete: true,
      activeThreadId: "x",
    });
    await writeFile(thirdPath, existing);
    for (const libraryPath of [library, join(directory, "no-library")]) {
      assert.deepEqual(await startupPreferences(thirdPath, libraryPath), {
        companion: "kite",
        onboardingComplete: true,
      });
      assert.equal(await readFile(thirdPath, "utf8"), existing);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a first launch that fails after the library exists still shows setup next time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preferences-"));
  try {
    const path = join(directory, "preferences.json");
    const library = join(directory, "library");
    assert.deepEqual(await startupPreferences(path, library), {
      companion: "capybara",
      onboardingComplete: false,
    });
    assert.ok((await stat(path)).isFile());
    await assert.rejects(stat(library), missing);

    // Store.load() then created the library, and startup failed or the user
    // quit before setup finished. A relaunch mid-setup takes the same path.
    await mkdir(library);
    assert.deepEqual(await startupPreferences(path, library), {
      companion: "capybara",
      onboardingComplete: false,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("startup fails with the library path when it cannot check the library", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preferences-"));
  try {
    const path = join(directory, "preferences.json");
    const notAFolder = join(directory, "not-a-folder");
    await writeFile(notAFolder, "");
    const library = join(notAFolder, "library");
    await assert.rejects(
      startupPreferences(path, library),
      (error: unknown) =>
        error instanceof Error &&
        error.message.startsWith(`Could not open ${library}: `) &&
        error.message.endsWith(
          " Make sure this folder can be opened, then reopen OpenMuse.",
        ) &&
        (error.cause as NodeJS.ErrnoException).code === "ENOTDIR",
    );
    await assert.rejects(stat(path), missing);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preferences persist all fields atomically and privately", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preferences-"));
  try {
    const path = join(directory, "preferences.json");
    // Saving renames a new private file over the old one, so the old file's wider mode cannot survive.
    await writeFile(
      path,
      '{"companion":"capybara","onboardingComplete":false}',
    );
    await chmod(path, 0o644);
    assert.equal((await stat(path)).mode & 0o777, 0o644);
    const preferences = {
      companion: "kite" as const,
      onboardingComplete: true,
    };
    assert.deepEqual(await savePreferences(path, preferences), preferences);
    assert.deepEqual(await loadPreferences(path, false), preferences);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(directory), ["preferences.json"]);
    await savePreferences(path, { ...preferences, companion: "capybara" });
    assert.deepEqual(await loadPreferences(path, false), {
      ...preferences,
      companion: "capybara",
    });
    assert.deepEqual(await readdir(directory), ["preferences.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a save into a read-only folder fails with the file path and keeps the previous file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preferences-"));
  try {
    const path = join(directory, "preferences.json");
    const previous = '{"companion":"capybara","onboardingComplete":true}';
    await writeFile(path, previous);
    await chmod(directory, 0o500);
    try {
      await assert.rejects(
        savePreferences(path, { companion: "kite", onboardingComplete: true }),
        {
          message: `Could not save ${path}: Permission denied. Check free disk space and folder permissions, then try again.`,
        },
      );
    } finally {
      await chmod(directory, 0o700);
    }
    assert.equal(await readFile(path, "utf8"), previous);
    assert.deepEqual(await readdir(directory), ["preferences.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a save whose rename fails removes its temporary file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preferences-"));
  try {
    // A folder where the file should be lets the temporary file be written, then fails the rename.
    const path = join(directory, "preferences.json");
    await mkdir(path);
    await assert.rejects(
      savePreferences(path, { companion: "kite", onboardingComplete: true }),
      unsaved(path),
    );
    assert.deepEqual(await readdir(directory), ["preferences.json"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("malformed present preference fields fail rather than resetting onboarding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preferences-"));
  try {
    const path = join(directory, "preferences.json");
    for (const contents of [
      '{"companion":"kite","placement":"invalid"}',
      '{"companion":"kite","onboardingComplete":"true"}',
      '{"companion":"invalid"}',
    ]) {
      await writeFile(path, contents);
      await assert.rejects(loadPreferences(path, false), unreadable(path));
    }
    await assert.rejects(
      savePreferences(path, {
        companion: "kite",
        placement: "floating",
        onboardingComplete: true,
      }),
      z.ZodError,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unknown keys from other builds are dropped when loading and by the next save", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preferences-"));
  try {
    const path = join(directory, "preferences.json");
    await writeFile(
      path,
      JSON.stringify({
        companion: "kite",
        onboardingComplete: true,
        activeThreadId: "0b7e2c1a-5d7f-4d8e-9a51-2f7a3c9e1b44",
        futureField: 1,
      }),
    );
    assert.deepEqual(await loadPreferences(path, false), {
      companion: "kite",
      onboardingComplete: true,
    });
    await savePreferences(path, {
      ...(await loadPreferences(path, false)),
      companion: "capybara",
    });
    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      companion: "capybara",
      onboardingComplete: true,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("saving rejects unknown keys and missing fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preferences-"));
  try {
    const path = join(directory, "preferences.json");
    await assert.rejects(
      savePreferences(path, {
        companion: "capybara",
        onboardingComplete: true,
        activeThreadId: "x",
      }),
      z.ZodError,
    );
    await assert.rejects(stat(path), missing);
    await assert.rejects(
      savePreferences(path, { companion: "capybara" }),
      z.ZodError,
    );
    await assert.rejects(stat(path), missing);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unreadable preferences fail with the file path and a way forward", async () => {
  const directory = await mkdtemp(join(tmpdir(), "preferences-"));
  try {
    const path = join(directory, "preferences.json");
    const library = join(directory, "library");

    await mkdir(path);
    await assert.rejects(loadPreferences(path, false), unreadable(path));
    await assert.rejects(startupPreferences(path, library), unreadable(path));
    await rm(path, { recursive: true, force: true });

    await writeFile(path, "{not json");
    await assert.rejects(loadPreferences(path, false), unreadable(path));

    await writeFile(path, '{"companion":"invalid"}');
    await assert.rejects(loadPreferences(path, false), unreadable(path));

    // Startup fails the same way when it cannot even check for the file.
    const notAFolder = join(directory, "not-a-folder");
    await writeFile(notAFolder, "");
    const blockedPath = join(notAFolder, "preferences.json");
    await assert.rejects(
      startupPreferences(blockedPath, library),
      unreadable(blockedPath),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
