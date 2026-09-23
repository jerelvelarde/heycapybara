import { spawn } from "node:child_process";
import { build } from "esbuild";
import { createServer } from "vite";
import electron from "electron";
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
const child = spawn(electron, ["."], {
  stdio: "inherit",
  env: { ...process.env, KITE_DEV_URL: "http://127.0.0.1:5173" },
});
child.on("exit", async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => child.kill(signal));
