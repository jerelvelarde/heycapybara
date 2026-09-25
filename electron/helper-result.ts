// The helper prints one JSON object per line. Failures are `error` events.
// A `status` event confirms success for the one-shot `--point`,
// `--open-app`, `--open-url`, `--click`, `--scroll`, `--type` and `--keys`
// commands; the long-running recorder mode also prints
// `status` lines as it starts and stops, outside of `runHelper` (e.g.
// "Ready; waiting for start command" and "Already recording"). The query
// commands (`--permissions`, `--request-accessibility`, `--request-screen`)
// print one bare JSON object with no `status` line.
// Of those, only `--permissions`' output is parsed by
// its caller (`JSON.parse` on the resolved stdout); `--request-accessibility`
// and `--request-screen` still run through `runHelper`, but main.ts
// discards the stdout they resolve to and re-reads permissions separately
// instead. An unreadable line is skipped here regardless, so a parsed
// query command's unparseable output fails later, in the caller's
// `JSON.parse`, while the process's own exit reason, or the missing
// confirmation, decides for everything else.

import { constants as osConstants } from "node:os";
import type { PromiseWithChild } from "node:child_process";

type HelperEvent = { kind?: unknown; detail?: unknown };

function isHelperEvent(value: unknown): value is HelperEvent {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Shared by `reportedError` and `reportsStatus`: split stdout into lines,
// skip blanks and lines that aren't parseable JSON, and yield only the
// ones that parsed to an object. A line can just as easily parse to
// `null`, a number, a string or an array, none of which carry `kind` or
// `detail`.
function* parsedLines(stdout: string): Generator<HelperEvent> {
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (isHelperEvent(parsed)) yield parsed;
  }
}

export function reportedError(stdout: string): string | undefined {
  for (const event of parsedLines(stdout)) {
    if (event.kind === "error")
      return typeof event.detail === "string" && event.detail.trim()
        ? event.detail
        : "The desktop helper reported an error";
  }
  return undefined;
}

// Scans the same way `reportedError` does, looking for a `status` event
// whose detail confirms the specific action the caller asked for.
function reportsStatus(stdout: string, detail: HelperStatus): boolean {
  for (const event of parsedLines(stdout)) {
    if (event.kind === "status" && event.detail === detail) return true;
  }
  return false;
}

// The exact status strings the native helper reports for the one-shot
// commands that confirm success this way. electron/main.ts imports these
// constants instead of repeating the literal strings, and
// tests/helper-result.test.ts checks that native/Recorder.swift's source
// contains each one as a status event -- a substring check on the Swift
// source text, not a runtime assertion that the compiled helper actually
// emits it -- between the two, a typo in either place can't silently
// desync the Swift and TypeScript sides.
export const helperStatus = {
  pointDisplayed: "Point displayed",
  appOpened: "Application opened",
  webPageOpened: "Web page opened",
  clickSent: "Click sent",
  scrollSent: "Scroll sent",
  textTyped: "Text typed",
  keysPressed: "Keys pressed",
} as const;

export type HelperStatus = (typeof helperStatus)[keyof typeof helperStatus];

// The subset of helperStatus confirming a command that posts real input
// (click, scroll, type, keys) or opens a real page (open-url), as opposed to
// one that only shows something (--point, --open-app). runHelper reads a
// call's expectedStatus to tell which kind it is, rather than taking a
// separate flag: every input-command caller already passes one of these, so
// no existing call site needs to change.
const inputCommandStatus = new Set<HelperStatus>([
  helperStatus.clickSent,
  helperStatus.scrollSent,
  helperStatus.textTyped,
  helperStatus.keysPressed,
  helperStatus.webPageOpened,
]);

type ExecFailure = Error & {
  stdout?: unknown;
  code?: unknown;
  errno?: unknown;
  signal?: unknown;
  killed?: unknown;
  syscall?: unknown;
};

// promisified execFile usually rejects asynchronously, with `stdout`
// attached, for a non-zero exit, a signal, a timeout, or a spawn error
// Node reports that way (EACCES, EAGAIN, EMFILE, ENFILE, ENOENT). A
// handful of rarer spawn errors (EPERM, ENOEXEC, EBADARCH, ...) are
// instead thrown synchronously, before the call returns its promise:
// `execFile`'s promisified form does not wrap the call in a `Promise`
// executor the way a generic `promisify` would, so nothing here turns
// that throw into a rejection on its own. `runHelper` below only catches
// it because it calls `run()` -- which invokes `exec(...)` -- inside its
// own `try`; moving that call out of the `try` would let this throw
// escape `runHelper` uncaught. The resulting error carries no `stdout` at
// all, so it's identifiable instead by `syscall` being exactly "spawn" --
// an asynchronous failure's `syscall` also starts with "spawn ", followed
// by the helper's path.
function isHelperFailure(error: unknown): error is ExecFailure {
  return (
    error instanceof Error &&
    ("stdout" in error || (error as ExecFailure).syscall === "spawn")
  );
}

// `message` differs by failure shape and none of them are fit to show a
// user: a synchronous spawn failure's `message` is just `spawn <code>`
// (e.g. "spawn EPERM"); an asynchronous spawn failure such as ENOENT or
// EACCES names the helper's path too (`spawn <path> <code>`), but not its
// arguments; and an exit, signal or timeout failure's `message` carries
// the path, the arguments and stderr all together (`Command failed:
// <path> <args>\n<stderr>`, see e.g. Node's child_process exithandler).
// Report the helper's own reason instead, built only from `stdout`,
// `code`, `signal`, `killed`, `errno` and `syscall` -- `runHelper` never
// reads `message`. No `cause` is kept on the thrown error either:
// Electron logs a rejected `ipcMain.handle` handler together with its
// `cause` (console.error, "Error occurred in handler for '...'"), which
// would print that same path, arguments and stderr right back out.
export async function runHelper(
  run: () => Promise<{ stdout: string }>,
  expectedStatus?: HelperStatus,
): Promise<string> {
  let stdout = "";
  let failureMessage: string | undefined;
  try {
    ({ stdout } = await run());
  } catch (error) {
    if (!isHelperFailure(error)) throw error;
    failureMessage =
      reportedError(String(error.stdout ?? "")) ??
      failureCause(
        error,
        expectedStatus !== undefined && inputCommandStatus.has(expectedStatus),
      );
  }
  if (failureMessage !== undefined) throw new Error(failureMessage);
  const reported = reportedError(stdout);
  if (reported) throw new Error(reported);
  if (expectedStatus && !reportsStatus(stdout, expectedStatus))
    throw new Error(
      `The desktop helper finished without confirming "${expectedStatus}"`,
    );
  return stdout;
}

// Signals that mean the helper's own process crashed, rather than being
// asked to stop (SIGTERM) or forced to stop by something outside it
// (SIGKILL): a Swift trap or memory fault raises one of these, so "was
// stopped by" would undersell what actually happened.
const crashSignals = new Set([
  "SIGTRAP",
  "SIGSEGV",
  "SIGBUS",
  "SIGILL",
  "SIGABRT",
  "SIGFPE",
  "SIGSYS",
  "SIGXCPU",
  "SIGEMT",
]);

// Sync spawn failures (see `isHelperFailure` above) whose `code` isn't a
// name Node can read out show up only as `errno`, since their `code` is
// just the string "Unknown system error <n>". ENOEXEC (a file with no
// recognizable executable format) and EBADARCH (a Mach-O binary built for
// the wrong CPU architecture -- this helper targets Apple Silicon only)
// are both real cases of that for a corrupt or mismatched build. Mapped
// by the constant Node provides for ENOEXEC; Node has no EBADARCH
// constant, so that one is necessarily a magic number.
const unrunnableHelperErrnos = new Set<number>([
  -osConstants.errno.ENOEXEC,
  -86, // EBADARCH; macOS-only, and not in os.constants.errno
]);

function failureCause(failure: ExecFailure, isInputCommand: boolean) {
  if (failure.killed === true)
    return isInputCommand
      ? "The desktop helper timed out; some input may already have been sent. Take a screenshot before retrying."
      : "The desktop helper timed out";
  if (typeof failure.signal === "string" && failure.signal)
    return crashSignals.has(failure.signal)
      ? `The desktop helper crashed (${failure.signal})`
      : `The desktop helper was stopped by ${failure.signal}`;
  if (failure.code === "ENOENT" || failure.code === "EACCES")
    return `The desktop helper is missing or not executable (${failure.code}). Rebuild it with npm run build:native, or reinstall OpenMuse Desktop.`;
  if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
    return "The desktop helper produced more output than expected";
  if (
    typeof failure.errno === "number" &&
    unrunnableHelperErrnos.has(failure.errno)
  )
    return "The desktop helper isn't a valid program for this Mac. Rebuild it with npm run build:native, or reinstall OpenMuse Desktop.";
  if (typeof failure.code === "string" && failure.code)
    return `The desktop helper could not run (${failure.code})`;
  if (typeof failure.code === "number")
    return `The desktop helper exited with code ${failure.code} and gave no reason. Try again; if it keeps failing, rebuild it with npm run build:native.`;
  return "The desktop helper failed and gave no reason. Try again; if it keeps failing, rebuild it with npm run build:native.";
}

// Writes `input` to the helper's stdin and closes it, for a command that
// takes its argument there rather than on argv, which any process on the
// Mac can read. A helper that exits before reading makes the write fail with
// EPIPE; that error is dropped, because an `error` event with no listener
// would crash the main process, and the helper's own exit already says what
// went wrong.
export function withInput<T>(
  pending: PromiseWithChild<T>,
  input: string,
): PromiseWithChild<T> {
  const { stdin } = pending.child;
  stdin?.on("error", () => {});
  stdin?.end(input);
  return pending;
}
