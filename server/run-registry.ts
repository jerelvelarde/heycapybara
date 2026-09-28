import { randomBytes, randomUUID } from "node:crypto";
import { authorized } from "./auth";

// One agent run as the kite MCP tools see it. `signal` aborts when the run
// ends, however it ends: finished, failed or stopped.
export type AgentRun = Readonly<{ id: string; signal: AbortSignal }>;

// Every Codex run gets its own bearer token for the kite MCP server, so a
// tool call says which run it belongs to without trusting anything the model
// can write: the token reaches only that run's Codex process, through an
// environment variable its shell tools don't inherit (server/codex-agent.ts).
// The token stops working the moment its run ends, and a control grant
// (electron/control-grant.ts) ends with it.
export class RunRegistry {
  private runs = new Map<string, { token: string; run: AgentRun }>();

  // `until` is the run's own abort signal. Stop aborts it, and the run ends
  // right then, not once Codex has finished exiting.
  start(until: AbortSignal) {
    const token = randomBytes(32).toString("hex");
    const ended = new AbortController();
    const run: AgentRun = Object.freeze({
      id: randomUUID(),
      signal: ended.signal,
    });
    const end = () => {
      until.removeEventListener("abort", end);
      this.runs.delete(run.id);
      ended.abort();
    };
    this.runs.set(run.id, { token, run });
    until.addEventListener("abort", end, { once: true });
    if (until.aborted) end();
    return { token, run, end };
  }

  // The same check the runtime's own routes get (server/auth.ts), against
  // each open run's token in turn.
  authorize(request: Request): AgentRun | undefined {
    for (const { token, run } of this.runs.values())
      if (authorized(request, token)) return run;
    return undefined;
  }
}
