import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  devAccessibilityError,
  nameAccessibilityApp,
  packagedAccessibilityError,
} from "../electron/accessibility-error";

const source = (path: string) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

// scripts/electron-command.mjs has no type declarations; a computed import
// keeps it out of the type check.
const electronCommandModule = new URL(
  "../scripts/electron-command.mjs",
  import.meta.url,
).href;
type ElectronCommand = (input: {
  platform: string;
  electron: string;
  launcher: string;
  exists: (path: string) => boolean;
}) => { command: string; args: string[]; note?: string };
const loadElectronCommand = async () =>
  (await import(electronCommandModule)).electronCommand as ElectronCommand;

// The launcher is only compiled on a Mac, so these read its source, like
// the Swift scans in tests/helper-result.test.ts.
test("kite-launch disclaims responsibility through dlsym and warns when it can't", async () => {
  const launch = await source("native/Launch.c");
  assert.match(
    launch,
    /dlsym\(RTLD_DEFAULT,\s*"responsibility_spawnattrs_setdisclaim"\)/,
  );
  assert.match(launch, /disclaim\(&attr,\s*1\)/);
  assert.match(launch, /disclaim == NULL \|\| disclaim\(&attr, 1\) != 0/);
  assert.match(launch, /fprintf\(stderr,\s*"kite-launch: can't disclaim/);
  assert.match(launch, /posix_spawnp\(&pid, argv\[1\], NULL, &attr/);
  // Declaring the private function would make the build depend on it.
  assert.doesNotMatch(launch, /^\s*(extern\s+)?int\s+responsibility_/m);
});

test("kite-launch forwards SIGINT and SIGTERM and exits with the child's status", async () => {
  const launch = await source("native/Launch.c");
  assert.match(launch, /sigaction\(SIGINT, &action, NULL\)/);
  assert.match(launch, /sigaction\(SIGTERM, &action, NULL\)/);
  assert.match(launch, /kill\(\(pid_t\)child_pid, sig\)/);
  // Blocked across the spawn so a signal then isn't lost.
  assert.match(launch, /sigprocmask\(SIG_BLOCK, &forwarded, &original\)/);
  assert.match(launch, /return WEXITSTATUS\(status\)/);
  assert.match(launch, /kill\(getpid\(\), sig\)/);
});

test("build-native.sh builds kite-launch and signs both binaries with fixed identifiers", async () => {
  const script = await source("scripts/build-native.sh");
  assert.match(
    script,
    /native\/Launch\.c" -o "\$repo_dir\/native\/bin\/kite-launch"/,
  );
  assert.match(script, /sign_identity="\$\{KITE_SIGN_IDENTITY:--\}"/);
  assert.match(
    script,
    /codesign --force --sign "\$sign_identity" --identifier com\.kite\.sprite\.recorder \\\n\s+"\$repo_dir\/native\/bin\/kite-recorder"/,
  );
  assert.match(
    script,
    /codesign --force --sign "\$sign_identity" --identifier com\.kite\.sprite\.launch \\\n\s+"\$repo_dir\/native\/bin\/kite-launch"/,
  );
});

test("on macOS, dev runs Electron through kite-launch when it exists", async () => {
  const electronCommand = await loadElectronCommand();
  assert.deepEqual(
    electronCommand({
      platform: "darwin",
      electron: "/e/Electron",
      launcher: "/r/native/bin/kite-launch",
      exists: (path) => path === "/r/native/bin/kite-launch",
    }),
    { command: "/r/native/bin/kite-launch", args: ["/e/Electron", "."] },
  );
});

test("without kite-launch, dev spawns Electron directly and says where the permission goes", async () => {
  const electronCommand = await loadElectronCommand();
  const result = electronCommand({
    platform: "darwin",
    electron: "/e/Electron",
    launcher: "/r/native/bin/kite-launch",
    exists: () => false,
  });
  assert.equal(result.command, "/e/Electron");
  assert.deepEqual(result.args, ["."]);
  assert.match(result.note ?? "", /kite-launch is missing/);
  assert.equal(result.note?.split("\n").length, 1);
});

test("off macOS, dev spawns Electron directly without a note", async () => {
  const electronCommand = await loadElectronCommand();
  assert.deepEqual(
    electronCommand({
      platform: "linux",
      electron: "/e/electron",
      launcher: "/r/native/bin/kite-launch",
      exists: () => true,
    }),
    { command: "/e/electron", args: ["."] },
  );
});

test("dev.mjs spawns whatever electronCommand chooses, with the same env", async () => {
  const dev = await source("scripts/dev.mjs");
  assert.match(dev, /electronCommand\(\{\s*platform: process\.platform,/);
  assert.match(
    dev,
    /new URL\("\.\.\/native\/bin\/kite-launch", import\.meta\.url\)/,
  );
  assert.match(dev, /exists: existsSync/);
  assert.match(dev, /if \(note\) console\.log\(note\);/);
  assert.match(dev, /spawn\(command, args, \{\s*stdio: "inherit",/);
  assert.match(
    dev,
    /env: \{ \.\.\.process\.env, KITE_DEV_URL: "http:\/\/127\.0\.0\.1:5173" \}/,
  );
});

test("the packaged Accessibility refusal is the helper's own text", async () => {
  const swift = await source("native/Recorder.swift");
  assert.ok(
    swift.includes(`let eventAccessError = "${packagedAccessibilityError}"`),
  );
});

test("the development build names Electron in the Accessibility refusal", () => {
  const refusal = new Error(packagedAccessibilityError);
  assert.equal(nameAccessibilityApp(refusal, true), refusal);
  const dev = nameAccessibilityApp(refusal, false);
  assert.ok(dev instanceof Error);
  assert.equal(dev.message, devAccessibilityError);
  assert.match(
    devAccessibilityError,
    /turn on "Electron", the development build, in System Settings > Privacy & Security > Accessibility/,
  );
  // Any other failure passes through untouched, packaged or not.
  const other = new Error("Click sent twice");
  assert.equal(nameAccessibilityApp(other, false), other);
  assert.equal(nameAccessibilityApp("not an error", false), "not an error");
});

test("main.ts renames the refusal for every command that needs Accessibility", async () => {
  const main = await source("electron/main.ts");
  assert.match(main, /throw nameAccessibilityApp\(error, app\.isPackaged\)/);
  for (const flag of ["--click", "--scroll", "--type", "--keys"]) {
    const at = main.indexOf(`"${flag}"`);
    assert.ok(at > 0, `${flag} call`);
    const before = main.slice(0, at);
    assert.match(
      before.slice(before.lastIndexOf("await ")),
      /^await namingAccessibilityApp\(\s*runHelper\(\s*\(\) =>\s*(?:withInput\(\s*)?exec\(\s*helper,\s*\[\s*$/,
      `${flag} must run through namingAccessibilityApp`,
    );
  }
});
