import { test } from "node:test";
import assert from "node:assert/strict";
import { RunRegistry } from "../server/run-registry";

const mcpCall = (token: string, headers: Record<string, string> = {}) =>
  new Request("http://127.0.0.1/mcp", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, ...headers },
  });

test("a run's token authorizes that run and no other", () => {
  const runs = new RunRegistry();
  const a = runs.start(new AbortController().signal);
  const b = runs.start(new AbortController().signal);
  assert.match(a.token, /^[0-9a-f]{64}$/);
  assert.notEqual(a.token, b.token);
  assert.notEqual(a.run.id, b.run.id);
  assert.equal(runs.authorize(mcpCall(a.token)), a.run);
  assert.equal(runs.authorize(mcpCall(b.token)), b.run);
  assert.equal(runs.authorize(mcpCall("0".repeat(64))), undefined);
  assert.equal(
    runs.authorize(new Request("http://127.0.0.1/mcp", { method: "POST" })),
    undefined,
  );
});

test("a run's token still gets the runtime's origin check", () => {
  const runs = new RunRegistry();
  const { token, run } = runs.start(new AbortController().signal);
  assert.equal(
    runs.authorize(mcpCall(token, { Origin: "https://example.com" })),
    undefined,
  );
  assert.equal(runs.authorize(mcpCall(token, { Origin: "null" })), run);
});

test("ending a run revokes its token and aborts its signal", () => {
  const runs = new RunRegistry();
  const { token, run, end } = runs.start(new AbortController().signal);
  assert.equal(run.signal.aborted, false);
  end();
  assert.equal(run.signal.aborted, true);
  assert.equal(runs.authorize(mcpCall(token)), undefined);
  // A second end, as the runner's `finally` does after Stop, is harmless.
  end();
});

test("aborting the signal a run started with ends the run at once", () => {
  const runs = new RunRegistry();
  const stop = new AbortController();
  const { token, run } = runs.start(stop.signal);
  stop.abort();
  assert.equal(run.signal.aborted, true);
  assert.equal(runs.authorize(mcpCall(token)), undefined);
});

test("a run started with an already-aborted signal is over from the start", () => {
  const runs = new RunRegistry();
  const { token, run } = runs.start(AbortSignal.abort());
  assert.equal(run.signal.aborted, true);
  assert.equal(runs.authorize(mcpCall(token)), undefined);
});
