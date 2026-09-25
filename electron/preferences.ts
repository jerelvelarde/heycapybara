import { mkdir, readFile, rename, writeFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Companion } from "../src/types";

export const companionSchema = z.enum(["capybara", "kite"]);
export type Preferences = {
  companion: Companion;
  onboardingComplete: boolean;
};
const preferencesSchema = z.strictObject({
  companion: companionSchema,
  onboardingComplete: z.boolean(),
});
// Loading drops unknown keys (for example activeThreadId from another build of this app), so either build can start with the other's file. This build's next save writes only its own fields, so those keys are lost. A legacy placement ("notch" or "floating") is accepted and dropped; any other value fails.
const storedPreferencesSchema = z
  .object({
    companion: companionSchema,
    // Files without this field predate the setup window, so they load as complete.
    onboardingComplete: z.boolean().default(true),
    placement: z.enum(["notch", "floating"]).optional(),
  })
  .transform(({ companion, onboardingComplete }): Preferences => ({
    companion,
    onboardingComplete,
  }));
const defaultPreferences: Preferences = {
  companion: "capybara",
  onboardingComplete: false,
};

function sentence(reason: string): string {
  return /[.!?]$/.test(reason) ? reason : `${reason}.`;
}

// Plain words for the file-system failures people can fix themselves; anything else keeps Node's message.
function fileSystemReason(error: unknown): string {
  switch ((error as NodeJS.ErrnoException).code) {
    case "EACCES":
    case "EPERM":
      return "Permission denied.";
    case "ENOSPC":
      return "The disk is full.";
    case "EROFS":
      return "The disk is read-only.";
    default:
      return sentence(error instanceof Error ? error.message : String(error));
  }
}

// Startup shows this message in its error dialog, so it names the file and says how to recover.
function unreadablePreferencesError(path: string, error: unknown): Error {
  const reason =
    error instanceof z.ZodError
      ? z.prettifyError(error)
      : error instanceof Error
        ? error.message
        : String(error);
  return new Error(
    `Could not read ${path}: ${sentence(reason)} Fix or delete this file, then reopen OpenMuse.`,
    { cause: error },
  );
}

// People see this message as is, so it names the preferences file (not the temporary one) and says how to recover.
function unsavablePreferencesError(path: string, error: unknown): Error {
  return new Error(
    `Could not save ${path}: ${fileSystemReason(error)} Check free disk space and folder permissions, then try again.`,
    { cause: error },
  );
}

// Startup shows this message in its error dialog. The library holds the user's recordings and skills, so it never suggests deleting it.
function unopenableLibraryError(libraryPath: string, error: unknown): Error {
  return new Error(
    `Could not open ${libraryPath}: ${fileSystemReason(error)} Make sure this folder can be opened, then reopen OpenMuse.`,
    { cause: error },
  );
}

// False only when nothing is at path; any other failure is thrown as fail(error).
async function exists(
  path: string,
  fail: (error: unknown) => Error,
): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw fail(error);
  }
}

export async function loadPreferences(
  path: string,
  returningInstall: boolean,
): Promise<Preferences> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    // A missing file starts setup on a new install. Older builds only saved preferences after a change, so callers pass returningInstall to skip setup for them.
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { ...defaultPreferences, onboardingComplete: returningInstall };
    throw unreadablePreferencesError(path, error);
  }
  try {
    return storedPreferencesSchema.parse(JSON.parse(contents));
  } catch (error) {
    throw unreadablePreferencesError(path, error);
  }
}

// Call this before anything creates the library (Store.load() does): an existing library
// marks a returning install, so calling it later would skip setup on every new install.
// A new install without a file saves its defaults here, so if this launch fails or the user
// quits once the library exists, the next launch still finds that file and shows setup.
// A returning install without a file writes nothing, and an existing file wins either way.
export async function startupPreferences(
  path: string,
  libraryPath: string,
): Promise<Preferences> {
  const returningInstall = await exists(libraryPath, (error) =>
    unopenableLibraryError(libraryPath, error),
  );
  const existed = await exists(path, (error) =>
    unreadablePreferencesError(path, error),
  );
  const preferences = await loadPreferences(path, returningInstall);
  if (!existed && !returningInstall) await savePreferences(path, preferences);
  return preferences;
}

export async function savePreferences(
  path: string,
  input: unknown,
): Promise<Preferences> {
  const preferences = preferencesSchema.parse(input);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(temporary, JSON.stringify(preferences), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } catch (error) {
    // Only a failed write or rename leaves the temporary file behind. Report the save failure, not a failed cleanup.
    await rm(temporary, { force: true }).catch(() => {});
    throw unsavablePreferencesError(path, error);
  }
  return preferences;
}
