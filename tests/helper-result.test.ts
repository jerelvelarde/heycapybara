import { test } from "node:test";
import assert from "node:assert/strict";
import { helperResult, runHelper } from "../electron/helper-result";

test("status output with a clean exit does not throw", () => {
  assert.doesNotThrow(() =>
    helperResult('{"kind":"status","detail":"Point displayed"}\n', undefined),
  );
});

test("a reported error throws its own detail when a failure reason is also given", () => {
  const stdout =
    '{"kind":"error","detail":"Point lies outside connected displays"}\n';
  assert.throws(() => helperResult(stdout, "some failure"), {
    message: "Point lies outside connected displays",
  });
});

test("a reported error throws its own detail when there is no failure reason", () => {
  const stdout =
    '{"kind":"error","detail":"Point lies outside connected displays"}\n';
  assert.throws(() => helperResult(stdout, undefined), {
    message: "Point lies outside connected displays",
  });
});

test("empty stdout with a failure reason throws exactly that reason", () => {
  assert.throws(
    () => helperResult("", "The desktop helper failed without a reason"),
    { message: "The desktop helper failed without a reason" },
  );
});

test("runHelper reports the helper's own JSON error detail, not the command line", async () => {
  const err = Object.assign(
    new Error(
      "Command failed: /Applications/OpenMuse Desktop.app/Contents/Resources/kite-recorder --point 1 2",
    ),
    {
      stdout:
        '{"kind":"error","detail":"Point lies outside connected displays"}\n',
      code: 1,
    },
  );
  let caught: unknown;
  try {
    await runHelper(() => Promise.reject(err));
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.message, "Point lies outside connected displays");
  assert.doesNotMatch(caught.message, /kite-recorder|Command failed/);
});

test("runHelper reports a missing or non-executable helper", async () => {
  const err = Object.assign(new Error("spawn /x/kite-recorder ENOENT"), {
    stdout: "",
    code: "ENOENT",
  });
  let caught: unknown;
  try {
    await runHelper(() => Promise.reject(err));
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.match(caught.message, /missing or not executable \(ENOENT\)/);
  assert.doesNotMatch(caught.message, /kite-recorder|Command failed/);
});

test("runHelper reports a signal kill", async () => {
  const err = Object.assign(new Error("Command failed: /x/kite-recorder"), {
    stdout: "",
    code: null,
    signal: "SIGKILL",
  });
  let caught: unknown;
  try {
    await runHelper(() => Promise.reject(err));
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.match(caught.message, /stopped by SIGKILL/);
  assert.doesNotMatch(caught.message, /kite-recorder|Command failed/);
});

test("runHelper reports a bare exit code without a reason", async () => {
  const err = Object.assign(new Error("Command failed: /x/kite-recorder"), {
    stdout: "",
    code: 1,
  });
  let caught: unknown;
  try {
    await runHelper(() => Promise.reject(err));
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.match(caught.message, /exited with code 1 without a reason/);
  assert.doesNotMatch(caught.message, /kite-recorder|Command failed/);
});

test("runHelper resolves without throwing on a status-only result", async () => {
  await assert.doesNotReject(() =>
    runHelper(() =>
      Promise.resolve({
        stdout: '{"kind":"status","detail":"Point displayed"}\n',
      }),
    ),
  );
});

test("runHelper rethrows a non-exec error unchanged", async () => {
  const original = new TypeError("boom");
  await assert.rejects(
    () => runHelper(() => Promise.reject(original)),
    (error: unknown) => error === original,
  );
});
