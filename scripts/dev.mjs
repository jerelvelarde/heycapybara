import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { createServer } from "vite";
import electron from "electron";
import { electronCommand } from "./electron-command.mjs";
await build({
  entryPoints: ["electron/main.ts"],
  outfile: "dist/electron/main.js",
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  target: "node22",
});
await build({
  entryPoints: ["electron/preload.ts"],
  outfile: "dist/electron/preload.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  target: "node22",
});
const server = await createServer();
await server.listen();
const { command, args, note } = electronCommand({
  platform: process.platform,
  electron,
  launcher: fileURLToPath(
    new URL("../native/bin/kite-launch", import.meta.url),
  ),
  exists: existsSync,
});
if (note) console.log(note);
const child = spawn(command, args, {
  stdio: "inherit",
  env: { ...process.env, KITE_DEV_URL: "http://127.0.0.1:5173" },
});
child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
