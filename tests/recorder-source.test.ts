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
    assert.ok(body.includes("focusedFieldCheck()"), name);
    assert.ok(body.includes(secureFieldMessage), name);
  }
  const keys = swiftCase(source, "keys");
  // Checked before anything is sent.
  assert.ok(keys.indexOf("focusedFieldCheck()") < keys.indexOf("postKeys("));
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

const uncheckedFieldMessage =
  "OpenMuse couldn't check whether the focused field is a password field. Wait a moment, click the field and try again.";

test("the password check refuses when Accessibility can't answer", async () => {
  const source = await swiftSource();
  const check = swiftFunction(source, "focusedFieldCheck");
  // Only "nothing is focused" counts as clear; a timeout or any other
  // error is unknown, never "not a password field".
  assert.ok(check.includes("case .success"));
  assert.ok(check.includes("case .noValue: return .clear"));
  assert.ok(check.includes("default: return .unknown"));
  assert.ok(!check.includes("axElement(system"));
  // A failed subrole read on the element itself is unknown too.
  assert.ok(swiftFunction(source, "secureState").includes("return .unknown"));
  assert.ok(!source.includes("func focusedFieldIsSecure("));
  for (const name of ["type", "keys"]) {
    const body = swiftCase(source, name);
    assert.ok(body.includes(uncheckedFieldMessage), name);
    assert.ok(
      body.indexOf("focusedFieldCheck()") < body.lastIndexOf("post"),
      name,
    );
  }
});

const refusedApps = [
  "com.apple.Terminal",
  "com.googlecode.iterm2",
  "dev.warp.Warp-Stable",
  "com.mitchellh.ghostty",
  "com.apple.ScriptEditor2",
  "com.apple.Automator",
];

test("--type and --keys refuse an unknown frontmost app, OpenMuse, terminals and script editors", async () => {
  const source = await swiftSource();
  const set = /let refusedTypingApps: Set<String> = \[([\s\S]*?)\n\]/.exec(
    source,
  );
  assert.ok(set, "native/Recorder.swift must define refusedTypingApps");
  const listed = [...set[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
  assert.deepEqual([...listed].sort(), [...refusedApps].sort());

  const check = swiftFunction(source, "frontmostTarget");
  // No frontmost app is a refusal, not a pass.
  assert.ok(
    check.includes("guard let front = NSWorkspace.shared.frontmostApplication"),
  );
  assert.ok(check.includes("Wait a moment and try again."));
  assert.ok(check.includes("front.processIdentifier != getppid()"));
  assert.ok(check.includes("refusedTypingApps.contains("));
  assert.ok(
    check.includes(
      "OpenMuse doesn't type into terminals or script editors; ask the user to run the command themselves.",
    ),
  );
  assert.ok(
    !source.includes("frontmostApplication?.processIdentifier == getppid()"),
  );
  for (const name of ["type", "keys"]) {
    const body = swiftCase(source, name);
    assert.ok(body.includes("frontmostTarget("), name);
    assert.ok(
      body.indexOf("frontmostTarget(") < body.lastIndexOf("post"),
      name,
    );
  }
});

test("every input event is created before any is sent, and a failure reports an error", async () => {
  const source = await swiftSource();
  // Optional-chained posting silently skips an event macOS didn't create.
  assert.ok(!/\)\?\.post\(/.test(source));
  assert.ok(!source.includes("event?.post("));
  const cases = {
    postClick: "click",
    postScroll: "scroll",
    postText: "type",
    postKeys: "keys",
  };
  for (const [post, name] of Object.entries(cases)) {
    assert.ok(swiftFunction(source, post).includes("-> Bool"), post);
    const body = swiftCase(source, name);
    assert.ok(body.includes(`guard ${post}(`), name);
    assert.ok(body.includes("eventsFailedError"), name);
  }
});

test("--keys refuses the chords server/computer-schema.ts blocks", async () => {
  const source = await swiftSource();
  const schema = await readFile(
    new URL("../server/computer-schema.ts", import.meta.url),
    "utf8",
  );
  const chords = (text: string) =>
    [
      ...text.matchAll(
        /key: "([a-z0-9_]+)", modifiers: \[((?:"[a-z]+"(?:, )?)*)\]/g,
      ),
    ]
      .map((entry) => `${entry[1]}:${swiftStrings(entry[2]).sort().join("+")}`)
      .sort();
  const ts = /const BLOCKED_CHORDS[\s\S]*?\n\];/.exec(schema);
  assert.ok(ts, "server/computer-schema.ts must define BLOCKED_CHORDS");
  const swift = /let blockedChords[\s\S]*?\n\]/.exec(source);
  assert.ok(swift, "native/Recorder.swift must define blockedChords");
  assert.equal(chords(ts[0]).length, 3);
  assert.deepEqual(chords(swift[0]), chords(ts[0]));

  const keys = swiftCase(source, "keys");
  assert.ok(keys.includes("flags.isSuperset(of:"));
  assert.ok(
    keys.includes(
      "That shortcut logs out, locks the Mac or opens Force Quit, so OpenMuse doesn't send it. Ask the user to do it themselves.",
    ),
  );
  // An argument check: before the permission check and anything sent.
  assert.ok(
    keys.indexOf("blockedChords") < keys.indexOf("eventAccessGranted()"),
  );
});

test("--open-url refuses an address with a user name or password", async () => {
  const source = await swiftSource();
  const body = swiftCase(source, "open-url");
  assert.ok(body.includes("url.user == nil"));
  assert.ok(body.includes("url.password == nil"));
  assert.ok(body.includes("Use a web address without a user name or password"));
  assert.ok(
    body.indexOf("url.user == nil") < body.indexOf("NSWorkspace.shared.open("),
  );
});
