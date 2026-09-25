import { test } from "node:test";
import assert from "node:assert/strict";
import type { z } from "zod";
import {
  BLOCKED_CHORD_MESSAGE,
  CLICKS_MAX,
  KEY_NAMES,
  MODIFIERS,
  SCROLL_MAX,
  TYPE_MAX_LENGTH,
  URL_MAX_LENGTH,
  blockedChord,
  clicksSchema,
  desktopActionSchema,
  httpsUrlSchema,
  keyNameSchema,
  modifiersSchema,
  mouseButtonSchema,
  normalizedUrl,
  scrollAmountSchema,
  typedTextSchema,
} from "../server/computer-schema";
import type { DesktopAction } from "../src/types";

// Compile-time only: every action the schema accepts is a DesktopAction, so
// electron/main.ts can hand a parsed action to code typed against
// src/types.ts. A variant that drifts fails `npm run typecheck`.
const parsedIsDesktopAction = (
  action: z.infer<typeof desktopActionSchema>,
): DesktopAction => action;
void parsedIsDesktopAction;

const firstIssue = (result: {
  success: boolean;
  error?: { issues: { message: string }[] };
}) => result.error?.issues[0]?.message;

test("typed text is 1 to TYPE_MAX_LENGTH characters, counted in code points", () => {
  const smile = String.fromCodePoint(0x1f600);
  assert.equal(TYPE_MAX_LENGTH, 1000);
  assert.equal(typedTextSchema.safeParse("hello world").success, true);
  assert.equal(
    typedTextSchema.safeParse(smile.repeat(TYPE_MAX_LENGTH)).success,
    true,
  );
  assert.equal(
    firstIssue(typedTextSchema.safeParse("a".repeat(TYPE_MAX_LENGTH + 1))),
    "Type at most 1000 characters per call",
  );
  assert.equal(
    firstIssue(typedTextSchema.safeParse("")),
    "Give the text to type",
  );
});

test("typed text refuses line breaks, tabs, control characters, separators and lone surrogates, but keeps joined emoji", () => {
  const message =
    "Type text without line breaks, tabs or control characters. Use press_keys for Return, Tab and other keys.";
  for (const bad of [
    "a\nb",
    "a\tb",
    "a\rb",
    "a" + String.fromCodePoint(0x7) + "b",
    "a" + String.fromCodePoint(0x2028) + "b",
    "a" + String.fromCodePoint(0x2029) + "b",
    "a" + String.fromCharCode(0xd800) + "b",
  ])
    assert.equal(
      firstIssue(typedTextSchema.safeParse(bad)),
      message,
      JSON.stringify(bad),
    );
  const family = [0x1f468, 0x200d, 0x1f469]
    .map((codePoint) => String.fromCodePoint(codePoint))
    .join("");
  assert.equal(typedTextSchema.safeParse(family).success, true);
});

test("key names are 73 unique US key positions, and nothing else parses", () => {
  assert.equal(KEY_NAMES.length, 73);
  assert.equal(new Set(KEY_NAMES).size, KEY_NAMES.length);
  for (const name of [
    "a",
    "z",
    "0",
    "9",
    "return",
    "tab",
    "space",
    "escape",
    "delete",
    "forward_delete",
    "up",
    "page_down",
    "slash",
    "f1",
    "f12",
  ])
    assert.equal(keyNameSchema.safeParse(name).success, true, name);
  for (const name of [
    "enter",
    "A",
    "cmd",
    "f13",
    "",
    String.fromCodePoint(0xe4),
  ])
    assert.equal(keyNameSchema.safeParse(name).success, false, name);
});

test("modifiers are the four Mac modifier keys, each at most once, and default to none", () => {
  assert.deepEqual([...MODIFIERS], ["command", "shift", "option", "control"]);
  assert.deepEqual(modifiersSchema.parse(undefined), []);
  assert.deepEqual(modifiersSchema.parse(["command", "shift"]), [
    "command",
    "shift",
  ]);
  assert.equal(
    firstIssue(modifiersSchema.safeParse(["command", "command"])),
    "List each modifier at most once",
  );
  for (const bad of [
    ["fn"],
    ["cmd"],
    ["command", "shift", "option", "control", "command"],
  ])
    assert.equal(
      modifiersSchema.safeParse(bad).success,
      false,
      JSON.stringify(bad),
    );
});

test("shortcuts that log out, lock the Mac or open Force Quit are blocked, extra modifiers or not", () => {
  assert.equal(blockedChord("q", ["command", "shift"]), true);
  assert.equal(blockedChord("q", ["shift", "option", "command"]), true);
  assert.equal(blockedChord("q", ["control", "command"]), true);
  assert.equal(blockedChord("escape", ["option", "command"]), true);
  assert.equal(blockedChord("q", ["command"]), false);
  assert.equal(blockedChord("escape", []), false);
  assert.equal(blockedChord("l", ["command"]), false);
  assert.equal(
    BLOCKED_CHORD_MESSAGE,
    "That shortcut logs out, locks the Mac or opens Force Quit, so OpenMuse doesn't send it. Ask the user to do it themselves.",
  );
});

test("scrolls are 1 to SCROLL_MAX whole notches; clicks are 1 to CLICKS_MAX, left or right", () => {
  assert.equal(SCROLL_MAX, 10);
  assert.equal(CLICKS_MAX, 3);
  for (const amount of [1, 10])
    assert.equal(scrollAmountSchema.safeParse(amount).success, true);
  for (const amount of [0, 11, 1.5, -1])
    assert.equal(
      scrollAmountSchema.safeParse(amount).success,
      false,
      String(amount),
    );
  assert.equal(clicksSchema.parse(undefined), 1);
  assert.equal(clicksSchema.parse(3), 3);
  for (const clicks of [0, 4, 1.5])
    assert.equal(clicksSchema.safeParse(clicks).success, false, String(clicks));
  assert.equal(mouseButtonSchema.parse(undefined), "left");
  assert.equal(mouseButtonSchema.parse("right"), "right");
  assert.equal(mouseButtonSchema.safeParse("middle").success, false);
});

test("web addresses must be https, with no spaces, user name or password", () => {
  assert.equal(
    httpsUrlSchema.safeParse("https://mail.google.com/mail/u/0/#inbox").success,
    true,
  );
  const refusals: [string, string][] = [
    ["http://example.com", "Only https:// web addresses can be opened"],
    ["javascript:alert(1)", "Only https:// web addresses can be opened"],
    ["file:///etc/hosts", "Only https:// web addresses can be opened"],
    ["mail.google.com", "Use a full web address that starts with https://"],
    [
      "https://user:secret@example.com",
      "Use a web address without a user name or password",
    ],
    [
      "https://exa mple.com",
      "Use a web address without spaces or control characters",
    ],
    [
      "https://example.com/\n",
      "Use a web address without spaces or control characters",
    ],
  ];
  for (const [text, message] of refusals)
    assert.equal(firstIssue(httpsUrlSchema.safeParse(text)), message, text);
  assert.equal(
    httpsUrlSchema.safeParse(
      "https://example.com/" + "a".repeat(URL_MAX_LENGTH),
    ).success,
    false,
  );
});

test("the helper gets the URL parser's serialization: punycode host, percent-encoded path and query", () => {
  const umlaut = String.fromCodePoint(0xe4);
  assert.equal(
    normalizedUrl(`https://ex${umlaut}mple.com/a?q=${umlaut}`),
    "https://xn--exmple-cua.com/a?q=%C3%A4",
  );
});

test("the desktop action schema accepts each action and refuses malformed ones", () => {
  const target = {
    screenshotId: "shot_1a2b3c4d",
    x: 10,
    y: 20,
    label: "Inbox",
  };
  for (const action of [
    { type: "screenshot" },
    { type: "click", ...target, button: "left", clicks: 2 },
    { type: "scroll", ...target, direction: "down", amount: 3 },
    { type: "type", text: "hello" },
    { type: "keys", key: "l", modifiers: ["command"] },
    {
      type: "open-url",
      url: "https://mail.google.com",
      bundleId: "com.google.Chrome",
    },
    { type: "open-app", bundleId: "com.apple.TextEdit" },
    { type: "point", ...target },
  ])
    assert.equal(
      desktopActionSchema.safeParse(action).success,
      true,
      JSON.stringify(action),
    );
  for (const action of [
    { type: "click", ...target, button: "middle", clicks: 1 },
    { type: "click", ...target, label: " ", button: "left", clicks: 1 },
    { type: "scroll", ...target, direction: "sideways", amount: 3 },
    { type: "keys", key: "enter", modifiers: [] },
    { type: "type", text: "a\nb" },
    {
      type: "open-url",
      url: "http://mail.google.com",
      bundleId: "com.google.Chrome",
    },
    { type: "shell", command: "ls" },
  ])
    assert.equal(
      desktopActionSchema.safeParse(action).success,
      false,
      JSON.stringify(action),
    );
});
