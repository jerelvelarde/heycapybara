// The helper prints one JSON object per line. Failures are `error` events.
// A `status` event confirms success for the one-shot `--point` and
// `--open-app` commands; the long-running recorder mode also prints
// `status` lines as it starts and stops, outside of `runHelper`. The query
// commands (`--permissions`, `--notch-inset`, `--request-accessibility`,
// `--request-screen`) print one bare JSON object with no `status` line;
// for those, an unreadable line is skipped here and fails later, in the
// caller's `JSON.parse`. Unreadable lines are skipped here too, so the
// process's own exit reason, or the missing confirmation, decides.

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

// The exact status strings the native helper reports for the two one-shot
// commands that confirm success this way. Shared with electron/main.ts so
// a typo in either place can't silently desync the two sides.
export const helperStatus = {
  pointDisplayed: "Point displayed",
  appOpened: "Application opened",
} as const;

type HelperStatus = (typeof helperStatus)[keyof typeof helperStatus];

type ExecFailure = Error & {
  stdout?: unknown;
  code?: unknown;
  signal?: unknown;
  killed?: unknown;
  syscall?: unknown;
};

// promisified execFile usually rejects asynchronously, with `stdout`
// attached, for a non-zero exit, a signal, a timeout, or a spawn error
// Node reports that way (EACCES, EAGAIN, EMFILE, ENFILE, ENOENT). A
// handful of rarer spawn errors (EPERM, ENOEXEC, EBADARCH, ...) can only
// be reported synchronously; `promisify` still turns that into a
// rejection (a synchronous throw inside a `Promise` executor rejects it
// rather than escaping the call), but the resulting error carries no
// `stdout` at all. It is identifiable instead by `syscall` being exactly
// "spawn" -- an asynchronous failure's `syscall` also starts with
// "spawn ", followed by the helper's path.
function isHelperFailure(error: unknown): error is ExecFailure {
  return (
    error instanceof Error &&
    ("stdout" in error || (error as ExecFailure).syscall === "spawn")
  );
}

// Either shape's `message` embeds the helper's path, its arguments and
// sometimes stderr (see e.g. Node's child_process exithandler), so report
// the helper's own reason instead, built only from `stdout`, `code`,
// `signal` and `killed` -- `runHelper` never reads `message`. No `cause`
// is kept on the thrown error either: Electron logs a rejected
// `ipcMain.handle` handler together with its `cause` (console.error,
// "Error occurred in handler for '...'"), which would print that same
// path, arguments and stderr right back out.
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
      reportedError(String(error.stdout ?? "")) ?? failureCause(error);
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

function failureCause(failure: ExecFailure) {
  if (failure.killed === true) return "The desktop helper timed out";
  if (typeof failure.signal === "string" && failure.signal)
    return `The desktop helper was stopped by ${failure.signal}`;
  if (failure.code === "ENOENT" || failure.code === "EACCES")
    return `The desktop helper is missing or not executable (${failure.code})`;
  if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
    return "The desktop helper produced more output than expected";
  if (typeof failure.code === "string" && failure.code)
    return `The desktop helper could not run (${failure.code})`;
  if (typeof failure.code === "number")
    return `The desktop helper exited with code ${failure.code} without a reason`;
  return "The desktop helper failed without a reason";
}
