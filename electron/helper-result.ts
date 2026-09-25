export function helperResult(stdout: string, failure: string | undefined) {
  const events = stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { kind?: unknown; detail?: unknown });
  const reported = events.find((event) => event.kind === "error");
  if (reported)
    throw new Error(
      typeof reported.detail === "string"
        ? reported.detail
        : "The desktop helper reported an error",
    );
  if (failure) throw new Error(failure);
}

type ExecFailure = Error & {
  stdout?: unknown;
  code?: unknown;
  signal?: unknown;
};

// execFile rejects on a non-zero exit before its output is read, and its
// message contains the helper's path, so report the helper's own reason.
export async function runHelper(run: () => Promise<{ stdout: string }>) {
  let stdout: string;
  try {
    ({ stdout } = await run());
  } catch (error) {
    if (!(error instanceof Error) || !("stdout" in error)) throw error;
    const failure = error as ExecFailure;
    helperResult(String(failure.stdout ?? ""), failureCause(failure));
    return;
  }
  helperResult(stdout, undefined);
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
