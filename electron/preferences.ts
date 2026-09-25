import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Companion, Placement } from "../src/types";

export const companionSchema = z.enum(["capybara", "kite"]);
export const placementSchema = z.enum(["notch", "floating"]);
export type Preferences = {
  companion: Companion;
  placement: Placement;
  onboardingComplete: boolean;
};
const preferencesSchema = z.strictObject({
  companion: companionSchema,
  placement: placementSchema,
  onboardingComplete: z.boolean(),
});
const storedPreferencesSchema = z.strictObject({
  companion: companionSchema,
  placement: placementSchema.default("floating"),
  onboardingComplete: z.boolean().default(true),
});
const defaultPreferences: Preferences = {
  companion: "capybara",
  placement: "floating",
  onboardingComplete: true,
};

export async function loadPreferences(path: string): Promise<Preferences> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { ...defaultPreferences };
    throw error;
  }
  return storedPreferencesSchema.parse(JSON.parse(contents));
}

export async function savePreferences(
  path: string,
  input: unknown,
): Promise<Preferences> {
  const preferences = preferencesSchema.parse(input);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(preferences), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return preferences;
}

export async function loadCompanion(path: string): Promise<Companion> {
  return (await loadPreferences(path)).companion;
}

export async function saveCompanion(
  path: string,
  input: unknown,
): Promise<Companion> {
  const companion = companionSchema.parse(input);
  await savePreferences(path, { ...(await loadPreferences(path)), companion });
  return companion;
}
