import { test } from "node:test";
import assert from "node:assert/strict";
import { helperResult } from "../electron/helper-result";

test("status output with a clean exit does not throw", () => {
  assert.doesNotThrow(() =>
    helperResult('{"kind":"status","detail":"Point displayed"}\n', false),
  );
});

test("a reported error throws its own detail when the process also failed", () => {
  const stdout =
    '{"kind":"error","detail":"Point lies outside connected displays"}\n';
  assert.throws(() => helperResult(stdout, true), {
    message: "Point lies outside connected displays",
  });
});

test("a reported error throws its own detail even when the process did not fail", () => {
  const stdout =
    '{"kind":"error","detail":"Point lies outside connected displays"}\n';
  assert.throws(() => helperResult(stdout, false), {
    message: "Point lies outside connected displays",
  });
});

test("empty stdout with a failed process throws a generic reason", () => {
  assert.throws(() => helperResult("", true), /failed without a reason/);
});

test("the thrown message never contains the helper's file path", () => {
  const stdout =
    '{"kind":"error","detail":"Point lies outside connected displays"}\n';
  let caught: unknown;
  try {
    helperResult(stdout, true);
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.doesNotMatch(caught.message, /kite-recorder/);
});
