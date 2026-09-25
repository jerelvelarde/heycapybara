import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("an error event with a whitespace-only detail returns a generic message", () => {
  assert.equal(
    reportedError('{"kind":"error","detail":"  "}\n'),
    "The desktop helper reported an error",
  );
});

// promisified execFile always rejects with an Error whose `message` embeds
// the helper's path, its arguments and stderr (see e.g. Node's
// child_process exithandler). Every row below builds that same shape so the
// table exercises exactly what `runHelper` receives, never a stand-in.
function execFailure(overrides: {
  stdout?: string;
  code?: string | number | null;
  signal?: string | null;
  killed?: boolean;
}) {
  return Object.assign(
    new Error("Command failed: /x/kite-recorder --point 1 2"),
    { stdout: "", ...overrides },
  );
}

type FailureCase = {
  name: string;
  run: () => Promise<{ stdout: string }>;
  expectedStatus?: string;
  message: RegExp | string;
};

// One row per shape `runHelper` must turn into a message: every execFile
// rejection (ENOENT/EACCES/EPERM/ENOEXEC, a signal kill, a timeout, a
// maxBuffer overflow, a bare or status-bearing non-zero exit, an error line
// found behind garbage) plus every way a status-0 result can still fail (a
// bare error line, an empty detail, a status that doesn't match, a missing
// status, a confirmed status followed by an error line).
const helperFailures: FailureCase[] = [
  {
    name: "ENOENT",
    run: () => Promise.reject(execFailure({ code: "ENOENT" })),
    message: "The desktop helper is missing or not executable (ENOENT)",
  },
  {
    name: "EACCES",
    run: () => Promise.reject(execFailure({ code: "EACCES" })),
    message: "The desktop helper is missing or not executable (EACCES)",
  },
  {
    name: "EPERM",
    run: () => Promise.reject(execFailure({ code: "EPERM" })),
    message: "The desktop helper could not run (EPERM)",
  },
  {
    name: "ENOEXEC",
    run: () => Promise.reject(execFailure({ code: "ENOEXEC" })),
    message: "The desktop helper could not run (ENOEXEC)",
  },
  {
    name: "SIGKILL",
    run: () => Promise.reject(execFailure({ code: null, signal: "SIGKILL" })),
    message: "The desktop helper was stopped by SIGKILL",
  },
  {
    name: "a signal kill with a status line truncated mid-write",
    run: () =>
      Promise.reject(
        execFailure({
          stdout: '{"kind":"status","det',
          code: null,
          signal: "SIGKILL",
        }),
      ),
    message: "The desktop helper was stopped by SIGKILL",
  },
  {
    name: "a timeout (killed plus SIGTERM)",
    run: () =>
      Promise.reject(
        execFailure({ code: null, signal: "SIGTERM", killed: true }),
      ),
    message: "The desktop helper timed out",
  },
  {
    name: "a maxBuffer overflow",
    run: () =>
      Promise.reject(
        execFailure({ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }),
      ),
    message: "The desktop helper produced more output than expected",
  },
  {
    name: "a non-zero exit with no output",
    run: () => Promise.reject(execFailure({ code: 1 })),
    message: "The desktop helper exited with code 1 without a reason",
  },
  {
    name: "a non-zero exit whose output contains the expected status",
    run: () =>
      Promise.reject(
        execFailure({
          stdout: '{"kind":"status","detail":"Point displayed"}\n',
          code: 1,
        }),
      ),
    expectedStatus: "Point displayed",
    message: "The desktop helper exited with code 1 without a reason",
  },
  {
    name: "a non-zero exit whose stdout carries the helper's own error detail",
    run: () =>
      Promise.reject(
        execFailure({
          stdout:
            'not json\nnull\n5\n{"kind":"error","detail":"Point lies outside connected displays"}\n',
          code: 1,
        }),
      ),
    message: "Point lies outside connected displays",
  },
  {
    name: "an error line despite a clean exit",
    run: () => Promise.resolve({ stdout: '{"kind":"error","detail":"x"}\n' }),
    message: "x",
  },
  {
    name: "an empty error detail",
    run: () => Promise.resolve({ stdout: '{"kind":"error","detail":""}\n' }),
    message: "The desktop helper reported an error",
  },
  {
    name: "a different status line than the one expected",
    run: () =>
      Promise.resolve({
        stdout: '{"kind":"status","detail":"Point moved"}\n',
      }),
    expectedStatus: "Point displayed",
    message: 'The desktop helper finished without confirming "Point displayed"',
  },
  {
    name: "the expected status never appears",
    run: () => Promise.resolve({ stdout: "" }),
    expectedStatus: "Point displayed",
    message: 'The desktop helper finished without confirming "Point displayed"',
  },
  {
    name: "the expected status followed by an error line",
    run: () =>
      Promise.resolve({
        stdout:
          '{"kind":"status","detail":"Point displayed"}\n{"kind":"error","detail":"late"}\n',
      }),
    expectedStatus: "Point displayed",
    message: "late",
  },
];

test("runHelper reports the right message for every failure shape", async () => {
  for (const { name, run, expectedStatus, message } of helperFailures) {
    let caught: unknown;
    try {
      await runHelper(run, expectedStatus);
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof Error, `${name}: expected a rejection`);
    if (typeof message === "string")
      assert.equal(caught.message, message, name);
    else assert.match(caught.message, message, name);
    assert.doesNotMatch(
      caught.message,
      /kite-recorder|Command failed|\/x\//,
      name,
    );
  }
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

test("runHelper resolves to stdout when the expected status is confirmed", async () => {
  const stdout = '{"kind":"status","detail":"Point displayed"}\n';
  const result = await runHelper(
    () => Promise.resolve({ stdout }),
    "Point displayed",
  );
  assert.equal(result, stdout);
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

test("native/Recorder.swift reports the status strings electron/main.ts expects", async () => {
  const source = await readFile(
    new URL("../native/Recorder.swift", import.meta.url),
    "utf8",
  );
  assert.match(source, /"Point displayed"/);
  assert.match(source, /"Application opened"/);
});

// Every `exec(helper` call must sit inside a `runHelper(` call, so its
// execFile-shaped rejection always passes through the same reporting path.
// Approach used: for each `exec(helper` match, the nearest preceding
// `runHelper(` must come after the nearest preceding `;` or `{` boundary —
// i.e. the most recent statement to open before this call is `runHelper(`
// itself, not something earlier. `spawn(helper` is exempt: the recorder
// process is long-lived and streamed, not a one-shot command to wrap.
test("every exec(helper call in electron/main.ts is wrapped in runHelper(", async () => {
  const source = await readFile(
    new URL("../electron/main.ts", import.meta.url),
    "utf8",
  );
  const execCalls = [...source.matchAll(/exec\(\s*helper\b/g)];
  assert.ok(execCalls.length > 0, "expected at least one exec(helper call");
  for (const match of execCalls) {
    const index = match.index ?? 0;
    const lastBoundary = Math.max(
      source.lastIndexOf(";", index),
      source.lastIndexOf("{", index),
    );
    const lastRunHelper = source.lastIndexOf("runHelper(", index);
    assert.ok(
      lastRunHelper > lastBoundary,
      `exec(helper at offset ${index} is not wrapped in runHelper(`,
    );
  }
});
