// The helper prints one JSON object per line. Failures are `error` events,
// and success prints a `status` event. Unreadable lines are skipped so the
// process's own exit reason, or the missing confirmation, decides.
export function reportedError(stdout: string) {
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: { kind?: unknown; detail?: unknown };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.kind === "error")
      return typeof event.detail === "string" && event.detail.trim()
        ? event.detail
        : "The desktop helper reported an error";
  }
}

// Scans the same way `reportedError` does, looking for a `status` event
// whose detail confirms the specific action the caller asked for.
function reportsStatus(stdout: string, detail: string): boolean {
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: { kind?: unknown; detail?: unknown };
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.kind === "status" && event.detail === detail) return true;
  }
  return false;
}

type ExecFailure = Error & {
  stdout?: unknown;
  code?: unknown;
  signal?: unknown;
  killed?: unknown;
};

// promisified execFile rejects on a non-zero exit, a spawn failure, a
// signal or a timeout, with the output attached. Its message includes the
// helper's path and arguments, so report the helper's own reason instead.
export async function runHelper(
  run: () => Promise<{ stdout: string }>,
  expectedStatus?: string,
): Promise<string> {
  let stdout: string;
  try {
    ({ stdout } = await run());
  } catch (error) {
    if (!(error instanceof Error) || !("stdout" in error)) throw error;
    const failure = error as ExecFailure;
    throw new Error(
      reportedError(String(failure.stdout ?? "")) ?? failureCause(failure),
      { cause: error },
    );
  }
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
  if (typeof failure.code === "string" && failure.code)
    return `The desktop helper could not run (${failure.code})`;
  if (typeof failure.code === "number")
    return `The desktop helper exited with code ${failure.code} without a reason`;
  return "The desktop helper failed without a reason";
}
