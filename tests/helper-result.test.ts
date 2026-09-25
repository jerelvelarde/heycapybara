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

test("an error event with a whitespace-only detail returns a generic message", () => {
  assert.equal(
    reportedError('{"kind":"error","detail":"  "}\n'),
    "The desktop helper reported an error",
  );
});

test("runHelper resolves to stdout when the expected status is confirmed", async () => {
  const stdout = '{"kind":"status","detail":"Point displayed"}\n';
  const result = await runHelper(
    () => Promise.resolve({ stdout }),
    "Point displayed",
  );
  assert.equal(result, stdout);
});

test("runHelper rejects when the expected status never appears", async () => {
  let caught: unknown;
  try {
    await runHelper(() => Promise.resolve({ stdout: "" }), "Point displayed");
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.match(caught.message, /finished without confirming "Point displayed"/);
  assert.doesNotMatch(caught.message, /kite-recorder|Command failed/);
});

test("runHelper rejects a status-0 result with an empty error detail", async () => {
  let caught: unknown;
  try {
    await runHelper(() =>
      Promise.resolve({ stdout: '{"kind":"error","detail":""}\n' }),
    );
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.message, "The desktop helper reported an error");
  assert.doesNotMatch(caught.message, /kite-recorder|Command failed/);
});

test("runHelper reports a timeout even though execFile also sets a signal", async () => {
  const err = Object.assign(new Error("Command failed: /x/kite-recorder"), {
    stdout: "",
    code: null,
    signal: "SIGTERM",
    killed: true,
  });
  let caught: unknown;
  try {
    await runHelper(() => Promise.reject(err));
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.match(caught.message, /timed out/);
  assert.doesNotMatch(caught.message, /kite-recorder|Command failed/);
});

test("runHelper reports an unrecognized string error code", async () => {
  const err = Object.assign(new Error("spawn /x/kite-recorder EPERM"), {
    stdout: "",
    code: "EPERM",
  });
  let caught: unknown;
  try {
    await runHelper(() => Promise.reject(err));
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.match(caught.message, /could not run \(EPERM\)/);
  assert.doesNotMatch(caught.message, /kite-recorder|Command failed/);
  assert.equal((caught as Error).cause, err);
});

test("runHelper reports EACCES as missing or not executable", async () => {
  const err = Object.assign(new Error("spawn /x/kite-recorder EACCES"), {
    stdout: "",
    code: "EACCES",
  });
  let caught: unknown;
  try {
    await runHelper(() => Promise.reject(err));
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.match(caught.message, /missing or not executable \(EACCES\)/);
  assert.doesNotMatch(caught.message, /kite-recorder|Command failed/);
});

test("runHelper keeps scanning past non-object JSON lines to find the error", async () => {
  const err = Object.assign(new Error("Command failed: /x/kite-recorder"), {
    stdout: 'null\n5\n{"kind":"error","detail":"late"}\n',
    code: 1,
  });
  let caught: unknown;
  try {
    await runHelper(() => Promise.reject(err));
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.equal(caught.message, "late");
  assert.doesNotMatch(caught.message, /kite-recorder|Command failed/);
});
