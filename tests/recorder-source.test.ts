import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// The helper's behaviour can't run in tests without posting real input, so
// these pin the source of native/Recorder.swift instead.
const swiftSource = () =>
  readFile(new URL("../native/Recorder.swift", import.meta.url), "utf8");

// The body of one `case "--<name>":` in the helper's argument switch, up to
// the next case.
function swiftCase(source: string, name: string) {
  const match = new RegExp(
    `case "--${name}":([\\s\\S]*?)\\n    (?:case "|default:)`,
  ).exec(source);
  assert.ok(match, `native/Recorder.swift must handle --${name}`);
  return match[1];
}

// The body of one top-level `func <name>(...)`, up to its closing brace.
function swiftFunction(source: string, name: string) {
  const match = new RegExp(`func ${name}\\([\\s\\S]*?\\n\\}`).exec(source);
  assert.ok(match, `native/Recorder.swift must define ${name}`);
  return match[0];
}

function swiftStrings(text: string) {
  return [...text.matchAll(/"([a-z0-9_]+)"/g)].map((entry) => entry[1]);
}

const secureFieldMessage =
  "The focused field is a password field. OpenMuse doesn't type into password fields; ask the user to type it themselves.";

const allowedInPasswordFields = [
  "tab",
  "return",
  "left",
  "right",
  "up",
  "down",
  "escape",
  "delete",
  "forward_delete",
  "home",
  "end",
  "page_up",
  "page_down",
];

test("--keys refuses to type into a password field with the same message --type uses", async () => {
  const source = await swiftSource();
  for (const name of ["type", "keys"]) {
    const body = swiftCase(source, name);
    assert.ok(body.includes("focusedFieldIsSecure()"), name);
    assert.ok(body.includes(secureFieldMessage), name);
  }
  const keys = swiftCase(source, "keys");
  // Checked before anything is sent.
  assert.ok(keys.indexOf("focusedFieldIsSecure()") < keys.indexOf("postKeys("));
  // Character keys are refused unless Command or Control makes them a
  // shortcut, and Command-V, which pastes, is refused whatever else is held.
  assert.ok(keys.includes("characterKeys.contains(args[2])"));
  assert.ok(keys.includes("isDisjoint(with: [.maskCommand, .maskControl])"));
  assert.ok(keys.includes(`args[2] == "v" && flags.contains(.maskCommand)`));
});

test("characterKeys holds every letter, digit and punctuation key and no navigation key", async () => {
  const source = await swiftSource();
  const set = /let characterKeys: Set<String> = \[([\s\S]*?)\n\]/.exec(source);
  assert.ok(set, "native/Recorder.swift must define characterKeys");
  const characterKeys = swiftStrings(set[1]);
  assert.equal(new Set(characterKeys).size, characterKeys.length);

  const codes = /let keyCodes: \[String: CGKeyCode\] = \[([\s\S]*?)\n\]/.exec(
    source,
  );
  assert.ok(codes, "native/Recorder.swift must define keyCodes");
  const keyNames = [...codes[1].matchAll(/"([a-z0-9_]+)":/g)].map(
    (entry) => entry[1],
  );
  const punctuation = [
    "equal",
    "minus",
    "left_bracket",
    "right_bracket",
    "quote",
    "semicolon",
    "backslash",
    "comma",
    "slash",
    "period",
    "grave",
    "space",
  ];
  const expected = keyNames.filter(
    (name) => /^[a-z0-9]$/.test(name) || punctuation.includes(name),
  );
  assert.equal(expected.length, 26 + 10 + punctuation.length);
  assert.deepEqual([...characterKeys].sort(), expected.sort());
  for (const name of characterKeys) assert.ok(keyNames.includes(name), name);
  for (const name of allowedInPasswordFields) {
    assert.ok(keyNames.includes(name), name);
    assert.ok(!characterKeys.includes(name), name);
  }
  for (const name of keyNames.filter((key) => /^f\d+$/.test(key)))
    assert.ok(!characterKeys.includes(name), name);
});

test("connectedPoint tests Quartz coordinates with CGGetDisplaysWithPoint, and --point uses it", async () => {
  const source = await swiftSource();
  const body = swiftFunction(source, "connectedPoint");
  assert.ok(body.includes("CGGetDisplaysWithPoint(point, 0, nil, &count)"));
  assert.ok(body.includes("count > 0"));
  // Flipping to Cocoa and using NSRect.contains rejects the primary
  // display's top row and accepts the row below a display's bottom.
  assert.ok(!body.includes(".frame.contains("));
  assert.ok(!body.includes("primaryTop()"));
  assert.ok(!source.includes("$0.frame.contains(cocoaPoint)"));
  for (const name of ["point", "click", "scroll"])
    assert.ok(
      swiftCase(source, name).includes("connectedPoint(args[2], args[3])"),
      name,
    );
});
