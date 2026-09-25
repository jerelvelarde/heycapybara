import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// electron/main.ts imports electron, so these read its source instead of
// running it, like the exec(helper scan in tests/helper-result.test.ts.
const mainSource = () =>
  readFile(new URL("../electron/main.ts", import.meta.url), "utf8");

// Agent input sent while any OpenMuse dialog is up could answer it: "Open"
// on the working-folder chooser widens what Codex may edit. promptOpen()
// only sees a dialog that showDialog() counted, so every dialog call must
// go through it.
test("every dialog call in electron/main.ts goes through showDialog(), and promptOpen() counts those dialogs", async () => {
  const source = await mainSource();
  const count = (pattern: RegExp) => (source.match(pattern) ?? []).length;
  const bare = count(/\bdialog\.\w+\(/g);
  const wrapped = count(/\bshowDialog\(\s*\(\)\s*=>\s*dialog\.\w+\(/g);
  assert.ok(bare > 0, "expected at least one dialog call");
  assert.equal(
    wrapped,
    bare,
    "every dialog call must be written showDialog(() => dialog.show...",
  );
  assert.match(
    source,
    /promptOpen:\s*\(\)\s*=>\s*approvalHosts\.size\s*>\s*0\s*\|\|\s*sheetsOpen\s*>\s*0/,
  );
});

// Stop ends the run, not the call, so the open-app and point actions must
// follow `cancel` (the call's signal or the run's), never the bare call
// signal, and the --open-app launch must be killable by it.
test("approvedAction follows cancel, not the call signal, after building it", async () => {
  const source = await mainSource();
  const start = source.indexOf("async function approvedAction(");
  assert.ok(start >= 0, "approvedAction not found");
  const end = source.indexOf("\n}\n", start);
  const body = source.slice(start, end);
  const afterCancel = body.slice(
    body.indexOf("const cancel = AbortSignal.any([signal, run.signal]);") +
      "const cancel = AbortSignal.any([signal, run.signal]);".length,
  );
  assert.doesNotMatch(
    afterCancel.replace(/\bsignal: cancel\b/g, ""),
    /\bsignal\b/,
    "approvedAction still uses the call signal after building cancel",
  );
  assert.match(
    afterCancel,
    /exec\(\s*helper,\s*\["--open-app", action\.bundleId\],\s*\{[^}]*\bsignal: cancel\b[^}]*\}/,
  );
  assert.match(afterCancel, /new Error\(STOPPED_MESSAGE, \{ cause: error \}\)/);
});
