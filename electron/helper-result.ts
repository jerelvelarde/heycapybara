export function helperResult(stdout: string, failed: boolean) {
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
  if (failed) throw new Error("The desktop helper failed without a reason");
}
