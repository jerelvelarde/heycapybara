import { mkdir, readFile, rename, writeFile, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Companion } from "../src/types";

export const companionSchema = z.enum(["capybara", "kite"]);
const preferencesSchema = z.object({ companion: companionSchema });

export async function loadCompanion(path: string): Promise<Companion> {
  let contents: string;
  try {
    contents = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "capybara";
    throw error;
  }
  return preferencesSchema.parse(JSON.parse(contents)).companion;
}

export async function saveCompanion(
  path: string,
  input: unknown,
): Promise<Companion> {
  const companion = companionSchema.parse(input);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ companion }), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  return companion;
}
