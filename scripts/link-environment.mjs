import { access, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve, join } from "node:path";
const environmentFile = resolve(".env");
await access(environmentFile);
const directory = join(homedir(), "Library", "Application Support", "Kite");
await mkdir(directory, { recursive: true, mode: 0o700 });
await writeFile(
  join(directory, "environment.json"),
  JSON.stringify({ environmentFile }, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(
  "Kite is linked to this project’s CLI-managed .env file. No credential was copied. Restart Kite.",
);
