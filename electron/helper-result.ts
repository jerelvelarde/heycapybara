// The helper prints one JSON object per line and reports failures as an
// `error` event. Lines that aren't complete JSON (a write cut off by a
// kill, for example) are skipped so the process's own exit reason wins.
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
      return typeof event.detail === "string"
        ? event.detail
        : "The desktop helper reported an error";
  }
}

type ExecFailure = Error & {
  stdout?: unknown;
  code?: unknown;
  signal?: unknown;
};

// execFile rejects on a non-zero exit with the output attached to the
// error, and the error's message contains the helper's path, so report the
// helper's own reason instead.
export async function runHelper(run: () => Promise<{ stdout: string }>) {
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
}

function failureCause(failure: ExecFailure) {
  if (typeof failure.signal === "string" && failure.signal)
    return `The desktop helper was stopped by ${failure.signal}`;
  if (failure.code === "ENOENT" || failure.code === "EACCES")
    return `The desktop helper is missing or not executable (${failure.code})`;
  if (typeof failure.code === "number")
    return `The desktop helper exited with code ${failure.code} without a reason`;
  return "The desktop helper failed without a reason";
}
