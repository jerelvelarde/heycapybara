import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  reportedError,
  runHelper,
  helperStatus,
  type HelperStatus,
} from "../electron/helper-result";

const exec = promisify(execFile);

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

// A hand-built stand-in for exec rejections below whose shape no real
// process can be made to produce: either the stdout content -- a status
// line, an error event, interleaved garbage -- is awkward or impossible
// to script reliably, or the combination of fields (e.g. no `code`,
// `signal` or `killed` at all) is one a real Node failure never actually
// has. `runHelper` never reads `message`, so every row here shares this
// one placeholder -- and it's deliberately path- and command-shaped
// ("Command failed: /x/kite-recorder --point 1 2") so the `doesNotMatch`
// leak checks below have real text to catch if `runHelper` ever started
// reading it.
function execFailure(overrides: {
  stdout?: string;
  code?: string | number | null;
  errno?: number;
  syscall?: string;
  signal?: string | null;
  killed?: boolean;
}) {
  return Object.assign(
    new Error("Command failed: /x/kite-recorder --point 1 2"),
    { stdout: "", ...overrides },
  );
}

// Both errnos `failureCause` maps to this message (ENOEXEC, exercised for
// real below, and EBADARCH, which is hand built since no file this test
// can portably create actually triggers it) resolve to the identical
// text, so pinning it once here keeps both rows in sync.
const unrunnableHelperMessage =
  "The desktop helper isn't a valid program for this Mac. Rebuild it with npm run build:native, or reinstall OpenMuse Desktop.";

type FailureCase = {
  name: string;
  run: () => Promise<{ stdout: string }>;
  expectedStatus?: HelperStatus;
  message: RegExp | string;
};

test("runHelper reports the right message for every failure shape", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kite-helper-result-"));
  try {
    const missingPath = join(dir, "missing-helper");
    const nonExecutablePath = join(dir, "not-executable");
    await writeFile(nonExecutablePath, "#!/bin/sh\necho hi\n");
    await chmod(nonExecutablePath, 0o644);
    const wrongFormatPath = join(dir, "not-a-recognizable-format");
    await writeFile(
      wrongFormatPath,
      Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff, 0xfe, 0x10, 0x20, 0x99, 0x88]),
    );
    await chmod(wrongFormatPath, 0o755);

    // The whole design in `isHelperFailure`/`failureCause` (see
    // electron/helper-result.ts) rests on this shape actually being what
    // Node throws for an unrecognizable executable format: a synchronous
    // throw (not a promise rejection), with `syscall` exactly "spawn" and
    // no `stdout` property at all. Capture it directly, bypassing
    // `runHelper`, so a change in Node's behavior fails loudly here
    // rather than silently degrading the message the row below asserts.
    let rawWrongFormatError: unknown;
    try {
      await exec(wrongFormatPath, []);
      assert.fail("expected exec(wrongFormatPath, []) to throw");
    } catch (error) {
      rawWrongFormatError = error;
    }
    assert.ok(rawWrongFormatError instanceof Error);
    assert.equal(
      (rawWrongFormatError as { syscall?: unknown }).syscall,
      "spawn",
    );
    assert.equal(Object.hasOwn(rawWrongFormatError as object, "stdout"), false);

    // One row per shape `runHelper` must turn into a message. The first
    // five run a real child process end to end, through the same
    // `promisify(execFile)` main.ts uses, so they exercise Node's actual
    // failure shapes instead of a stand-in: a missing path and a
    // non-executable file both reject asynchronously (ENOENT/EACCES,
    // `stdout` present); a file with no recognizable executable format
    // throws synchronously, the way the rarer spawn errors
    // (EPERM/ENOEXEC/EBADARCH) do -- confirmed just above to be a throw,
    // not a rejection, with no `stdout` at all; `runHelper` only sees it
    // as a rejection because `run()` executes inside its own `try`. Which
    // exact errno this machine's Node reports for it isn't assumed -- it
    // varies -- but ENOEXEC and EBADARCH both map to the same friendly
    // message asserted below. A timeout and a maxBuffer overflow are both
    // real too. The rest are hand built: some are rejections built with
    // `execFailure` above, for stdout content a real process can't
    // conveniently be made to produce; others are `Promise.resolve` rows,
    // standing in for a clean exit whose stdout content is itself the
    // failure.
    const helperFailures: FailureCase[] = [
      {
        name: "a missing helper path (real, asynchronous ENOENT)",
        run: () => exec(missingPath, []),
        message: "The desktop helper is missing or not executable (ENOENT)",
      },
      {
        name: "a helper file without the executable bit (real, asynchronous EACCES)",
        run: () => exec(nonExecutablePath, []),
        message: "The desktop helper is missing or not executable (EACCES)",
      },
      {
        name: "a helper file with no recognizable executable format (real, synchronous spawn failure, no stdout)",
        run: () => exec(wrongFormatPath, []),
        message: unrunnableHelperMessage,
      },
      {
        name: "a hand-built EBADARCH errno (-86) -- real hardware can't portably be made to produce this, but macOS reports it the same way as ENOEXEC",
        run: () =>
          Promise.reject(
            execFailure({
              code: "Unknown system error -86",
              errno: -86,
              syscall: "spawn",
            }),
          ),
        message: unrunnableHelperMessage,
      },
      {
        name: "a real process killed by a timeout",
        run: () => exec("/bin/sh", ["-c", "sleep 5"], { timeout: 50 }),
        message: "The desktop helper timed out",
      },
      {
        name: "a real process that overflows maxBuffer",
        // `head` and `/dev/zero` are plain external commands, not shell
        // syntax, so this overflows the same way whether `/bin/sh` is
        // bash running in POSIX mode or dash. A brace expansion like
        // `printf 'x%.0s' {1..5000}` depends on the shell: dash doesn't
        // expand `{1..5000}`, so it prints one literal byte and this row
        // fails with "expected a rejection" instead of overflowing.
        run: () =>
          exec("/bin/sh", ["-c", "head -c 5000 /dev/zero"], {
            maxBuffer: 10,
          }),
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
              stdout: `{"kind":"status","detail":"${helperStatus.pointDisplayed}"}\n`,
              code: 1,
            }),
          ),
        expectedStatus: helperStatus.pointDisplayed,
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
        name: "SIGKILL",
        run: () =>
          Promise.reject(execFailure({ code: null, signal: "SIGKILL" })),
        message: "The desktop helper was stopped by SIGKILL",
      },
      {
        name: "SIGTERM",
        run: () =>
          Promise.reject(execFailure({ code: null, signal: "SIGTERM" })),
        message: "The desktop helper was stopped by SIGTERM",
      },
      {
        name: "a crash signal (SIGTRAP), e.g. a Swift trap",
        run: () =>
          Promise.reject(execFailure({ code: null, signal: "SIGTRAP" })),
        message: "The desktop helper crashed (SIGTRAP)",
      },
      {
        name: "a crash signal (SIGSEGV)",
        run: () =>
          Promise.reject(execFailure({ code: null, signal: "SIGSEGV" })),
        message: "The desktop helper crashed (SIGSEGV)",
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
        name: "a rejection with no code, signal, or kill reason",
        run: () => Promise.reject(execFailure({})),
        message: "The desktop helper failed without a reason",
      },
      {
        name: "an error line despite a clean exit",
        run: () =>
          Promise.resolve({ stdout: '{"kind":"error","detail":"x"}\n' }),
        message: "x",
      },
      {
        name: "an empty error detail",
        run: () =>
          Promise.resolve({ stdout: '{"kind":"error","detail":""}\n' }),
        message: "The desktop helper reported an error",
      },
      {
        name: "a different status line than the one expected",
        run: () =>
          Promise.resolve({
            stdout: '{"kind":"status","detail":"Point moved"}\n',
          }),
        expectedStatus: helperStatus.pointDisplayed,
        message: `The desktop helper finished without confirming "${helperStatus.pointDisplayed}"`,
      },
      {
        name: "the expected status never appears",
        run: () => Promise.resolve({ stdout: "" }),
        expectedStatus: helperStatus.pointDisplayed,
        message: `The desktop helper finished without confirming "${helperStatus.pointDisplayed}"`,
      },
      {
        name: "the expected status followed by an error line",
        run: () =>
          Promise.resolve({
            stdout: `{"kind":"status","detail":"${helperStatus.pointDisplayed}"}\n{"kind":"error","detail":"late"}\n`,
          }),
        expectedStatus: helperStatus.pointDisplayed,
        message: "late",
      },
    ];

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
      assert.ok(
        !caught.message.includes(dir),
        `${name}: leaked the temp helper directory`,
      );
      assert.equal(
        Object.hasOwn(caught, "cause"),
        false,
        `${name}: kept a cause`,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runHelper resolves without throwing on a status-only result", async () => {
  await assert.doesNotReject(() =>
    runHelper(
      () =>
        Promise.resolve({
          stdout: `{"kind":"status","detail":"${helperStatus.pointDisplayed}"}\n`,
        }),
      helperStatus.pointDisplayed,
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
  const stdout = `{"kind":"status","detail":"${helperStatus.pointDisplayed}"}\n`;
  const result = await runHelper(
    () => Promise.resolve({ stdout }),
    helperStatus.pointDisplayed,
  );
  assert.equal(result, stdout);
});

test("runHelper reports an unrecognized string error code", async () => {
  // EPERM is one of the rarer errors that can only be thrown
  // synchronously (see the comment above `isHelperFailure` in
  // electron/helper-result.ts), so, unlike the ENOENT/EACCES rows in the
  // test above, a real EPERM failure carries no `stdout` at all and a
  // bare `spawn EPERM` message with no path -- not the `spawn <path>
  // <code>` shape an asynchronous failure has.
  const err = Object.assign(new Error("spawn EPERM"), {
    code: "EPERM",
    errno: -1,
    syscall: "spawn",
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
  assert.equal(Object.hasOwn(caught, "cause"), false);
});

test("native/Recorder.swift reports each helperStatus value as a status event, and electron/main.ts uses the shared constants rather than the literal strings", async () => {
  const [swiftSource, mainSource] = await Promise.all([
    readFile(new URL("../native/Recorder.swift", import.meta.url), "utf8"),
    readFile(new URL("../electron/main.ts", import.meta.url), "utf8"),
  ]);
  for (const detail of Object.values(helperStatus)) {
    assert.ok(
      swiftSource.includes(`event("status", detail: "${detail}"`),
      `Recorder.swift does not emit a status event for "${detail}"`,
    );
    // Check every way the literal could be spelled -- a single-quoted or
    // template-literal string would desync main.ts from the shared
    // constant just as quietly as the double-quoted form.
    for (const quote of ['"', "'", "`"] as const) {
      assert.ok(
        !mainSource.includes(`${quote}${detail}${quote}`),
        `electron/main.ts still contains the literal string ${quote}${detail}${quote}`,
      );
    }
  }
});

// Every `exec(helper` call must sit inside a `runHelper(() => exec(helper`
// (optionally `async`, or block-bodied with a bare `return`) so its
// execFile-shaped rejection always passes through the same reporting
// path. Counting matched pairs, instead of scanning backward for the
// nearest statement boundary, avoids being fooled by an unwrapped call
// sitting alongside a wrapped one inside `Promise.all([...])` or a
// `.then(...)`. `spawn(helper` is exempt: the recorder process is
// long-lived and streamed, not a one-shot command to wrap. `execFile`
// must never be called directly either, only through the promisified
// `exec` alias -- `promisify(execFile)` itself doesn't match that last
// pattern, since "execFile" there is followed by `)`, not `(`. Neither
// `exec(` pattern matches `execFileSync(`, `execSync(` or `spawnSync(`
// (none of them contain the literal substring "exec("), so a synchronous
// helper call would slip past both counts; it gets its own separate,
// simpler check instead, since the helper must never be run synchronously
// at all, wrapped or not.
test("every exec(helper call in electron/main.ts is wrapped in runHelper(, execFile is never called directly, and the helper is never spawned synchronously", async () => {
  const source = await readFile(
    new URL("../electron/main.ts", import.meta.url),
    "utf8",
  );
  const count = (pattern: RegExp) => (source.match(pattern) ?? []).length;
  const wrapped = count(
    /runHelper\(\s*(?:async\s*)?\(\)\s*=>\s*(?:\{\s*return\s+)?exec\(\s*helper\b/g,
  );
  const bare = count(/\bexec\(\s*helper\b/g);
  assert.ok(bare > 0, "expected at least one exec(helper call");
  assert.equal(
    wrapped,
    bare,
    "every exec(helper call must be wrapped as runHelper(() => exec(helper...",
  );
  assert.equal(
    count(/\bexecFile\s*\(/g),
    0,
    "execFile must never be called directly; use the promisified exec alias",
  );
  assert.equal(
    count(/\b(?:execFileSync|execSync|spawnSync)\(\s*helper\b/g),
    0,
    "the helper must never be run synchronously (execFileSync/execSync/spawnSync)",
  );
});
