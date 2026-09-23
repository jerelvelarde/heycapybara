import { readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { config } from "dotenv";
import { z } from "zod";
export async function loadLinkedEnvironment(userData: string) {
  let raw: string;
  try {
    raw = await readFile(join(userData, "environment.json"), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return;
    throw error;
  }
  const { environmentFile } = z
    .object({
      environmentFile: z
        .string()
        .refine(isAbsolute, "Environment file path must be absolute"),
    })
    .parse(JSON.parse(raw));
  const result = config({ path: environmentFile, quiet: true });
  if (result.error)
    throw new Error(
      "Could not read the linked environment file. Run npm run link:environment again.",
    );
}
