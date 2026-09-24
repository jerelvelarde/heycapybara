import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const app = resolve(
  root,
  process.argv[2] || `release/mac-arm64/${manifest.build.productName}.app`,
);
const identifier = execFileSync(
  "/usr/libexec/PlistBuddy",
  ["-c", "Print :CFBundleIdentifier", join(app, "Contents/Info.plist")],
  { encoding: "utf8" },
).trim();
// codesign emits signature metadata on stderr, including on success.
const details = spawnSync(
  "/usr/bin/codesign",
  ["--display", "--verbose=4", app],
  { encoding: "utf8" },
);
if (details.status !== 0) throw new Error("App has no valid code signature");
if (!details.stderr.split("\n").includes(`Identifier=${identifier}`))
  throw new Error(
    `Code signature must match bundle identifier ${identifier}; macOS permissions otherwise target a different identity`,
  );
if (
  details.stderr.includes("Info.plist=not bound") ||
  details.stderr.includes("Sealed Resources=none")
)
  throw new Error(
    "App bundle metadata and resources must be sealed by its signature",
  );
execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", app], {
  stdio: "inherit",
});
console.log(`Verified signed bundle identity: ${identifier}`);
