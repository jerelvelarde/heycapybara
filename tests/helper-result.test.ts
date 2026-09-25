import { test } from "node:test";
import assert from "node:assert/strict";
import { reportedError, runHelper } from "../electron/helper-result";

test("a status-only stdout returns undefined", () => {
  assert.equal(
    reportedError('{"kind":"status","detail":"Point displayed"}\n'),
    undefined,
  );
});

test("an error event returns its detail", () => {
  const stdout =
    '{"kind":"error","detail":"Point lies outside connected displays"}\n';
  assert.equal(reportedError(stdout), "Point lies outside connected displays");
});

test("an error event without a string detail returns a generic message", () => {
  assert.equal(
    reportedError('{"kind":"error"}\n'),
    "The desktop helper reported an error",
  );
});

test("non-object JSON lines are skipped", () => {
  assert.equal(reportedError("null\n5\n"), undefined);
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

test("runHelper rejects when a status-0 result reports an error", async () => {
  let caught: unknown;
  try {
    await runHelper(() =>
      Promise.resolve({ stdout: '{"kind":"error","detail":"x"}\n' }),
    );
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.message, "x");
});

test("runHelper rethrows a non-exec error unchanged", async () => {
  const original = new TypeError("boom");
  await assert.rejects(
    () => runHelper(() => Promise.reject(original)),
    (error: unknown) => error === original,
  );
});

test("runHelper reports the kill signal when the write is cut off mid-line", async () => {
  const err = Object.assign(new Error("Command failed: /x/kite-recorder"), {
    stdout: '{"kind":"status","det',
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
  assert.doesNotMatch(caught.message, /JSON|Unterminated/);
});

test("runHelper finds the error line even after unparseable garbage", async () => {
  const err = Object.assign(new Error("Command failed: /x/kite-recorder"), {
    stdout:
      'not json\n{"kind":"error","detail":"Point lies outside connected displays"}\n',
    code: 1,
  });
  let caught: unknown;
  try {
    await runHelper(() => Promise.reject(err));
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.message, "Point lies outside connected displays");
});
