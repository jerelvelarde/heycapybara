import { build } from "esbuild";
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
