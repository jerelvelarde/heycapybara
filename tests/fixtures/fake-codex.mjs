#!/usr/bin/env node
// Stands in for the `codex` CLI in tests/runtime-e2e.test.ts. The Codex SDK
// spawns it as `codex exec --experimental-json ... --image <path>` and writes
// the prompt to its stdin. It records that call, then prints a JSONL event
// stream shaped like a real Codex turn -- though all a run actually needs to
// finish successfully is one `agent_message` item and a `turn.completed`
// event (see codexEvents and KiteCodexAgent.run in server/codex-agent.ts).
//
// A prompt containing HANG_TRIGGER switches it into hang mode instead: it
// records its own pid, then blocks forever, printing nothing, until an
// external signal (SIGTERM, via Node's spawn({signal}) integration -- see
// CodexRunner.run and KiteCodexAgent.abortRun in server/codex-agent.ts) kills
// it. tests/runtime-e2e.test.ts uses this to confirm that `agent/stop`
// actually ends the Codex process instead of leaving it running.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// Kept identical to tests/runtime-e2e.test.ts's own copy of this constant.
// This file runs as a separate process the Codex SDK spawns, so it can't
// import from the test file; the trigger text is duplicated instead, the
// same way FAKE_REPLY's text is duplicated there.
const HANG_TRIGGER = "__FAKE_CODEX_HANG_UNTIL_KILLED__";

// The runtime hands Codex only an allowlisted environment (codexEnvironment
// in server/codex-agent.ts), so a variable the test sets never reaches this
// process. CODEX_HOME does: CodexRunner points it into the state directory
// the test gives startRuntime.
const home = process.env.CODEX_HOME;
if (!home) throw new Error("fake-codex: CODEX_HOME is not set");

const argv = process.argv.slice(2);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks).toString("utf8");

// CodexRunner deletes its copies of the images once the run ends, so what
// identifies each one is read now: its size and its first 24 bytes -- the
// 8-byte PNG signature plus the start of the IHDR chunk (length, tag, width
// and height; see pngSize in server/screenshots.ts), not the whole chunk.
const images = [];
argv.forEach((arg, index) => {
  if (arg !== "--image") return;
  const bytes = readFileSync(argv[index + 1]);
  images.push({
    size: bytes.length,
    header: bytes.subarray(0, 24).toString("hex"),
  });
});

// One entry per call, so a test can tell one call from several.
const record = join(home, "fake-codex-calls.json");
const calls = existsSync(record)
  ? JSON.parse(readFileSync(record, "utf8"))
  : [];

if (stdin.includes(HANG_TRIGGER)) {
  // `pid` only appears on a hang-mode call: the test looks for it to learn
  // when this process is up and running, then to confirm it later exits.
  calls.push({
    argv,
    stdin,
    images,
    pid: process.pid,
    // Recorded only in hang mode, where the run is still open, so a test can
    // call the runtime's /mcp route with it (server/run-registry.ts).
    mcpToken: process.env.KITE_MCP_TOKEN,
  });
  writeFileSync(record, JSON.stringify(calls, null, 2));
  // Fires forever instead of resolving -- there is no promise here to
  // resolve -- which keeps the event loop alive (a bare pending Promise
  // would not do that on its own) so the process waits for an external kill
  // instead of exiting once there is nothing left to do.
  setInterval(() => {}, 1 << 30);
} else {
  calls.push({ argv, stdin, images });
  writeFileSync(record, JSON.stringify(calls, null, 2));

  const events = [
    { type: "thread.started", thread_id: randomUUID() },
    { type: "turn.started" },
    {
      type: "item.completed",
      item: {
        id: "item_0",
        type: "agent_message",
        text: "Fake Codex finished the turn.",
      },
    },
    {
      type: "turn.completed",
      usage: {
        input_tokens: 0,
        cached_input_tokens: 0,
        cache_write_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
      },
    },
  ];
  for (const event of events)
    process.stdout.write(JSON.stringify(event) + "\n");
}
