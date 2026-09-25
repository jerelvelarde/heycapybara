import { z } from "zod";
import {
  bundleIdSchema,
  pointLabelSchema,
  screenshotIdSchema,
} from "./point-schema";

// At most this many characters per type_text call, counted in code points
// as zod counts them. The helper types one character per key event pair, a
// few milliseconds apart (native/Recorder.swift --type), so a call stays
// within a few seconds.
export const TYPE_MAX_LENGTH = 1000;

// A refine rather than .regex(), for the reason given at pointLabelSchema: a
// published JSON Schema pattern has no `u` flag.
export const typedTextSchema = z
  .string()
  .min(1, "Give the text to type")
  .max(TYPE_MAX_LENGTH, `Type at most ${TYPE_MAX_LENGTH} characters per call`)
  .refine(
    // Control characters (\p{Cc}, which include line breaks and tabs), lone
    // surrogates (\p{Cs}), and line and paragraph separators. Return, Tab and
    // the like are keys, which press_keys sends. Format characters, such as
    // the joiner inside a joined emoji, stay allowed.
    (text) => !/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}]/u.test(text),
    "Type text without line breaks, tabs or control characters. Use press_keys for Return, Tab and other keys.",
  );

// Key positions on a US ANSI keyboard, named for the key rather than the
// character, so "slash" is the key that types / on that layout. Must match
// native/Recorder.swift's keyCodes, which maps each to its virtual key code
// (guarded by a parity test in tests/computer-schema.test.ts). On another
// layout a letter or punctuation key can type something else; type_text is
// how to enter characters.
export const KEY_NAMES = [
  "a",
  "b",
  "c",
  "d",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
  "0",
  "1",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "return",
  "tab",
  "space",
  "delete",
  "forward_delete",
  "escape",
  "left",
  "right",
  "up",
  "down",
  "home",
  "end",
  "page_up",
  "page_down",
  "minus",
  "equal",
  "left_bracket",
  "right_bracket",
  "backslash",
  "semicolon",
  "quote",
  "comma",
  "period",
  "slash",
  "grave",
  "f1",
  "f2",
  "f3",
  "f4",
  "f5",
  "f6",
  "f7",
  "f8",
  "f9",
  "f10",
  "f11",
  "f12",
] as const;

export const MODIFIERS = ["command", "shift", "option", "control"] as const;

export const keyNameSchema = z.enum(KEY_NAMES);

export const modifiersSchema = z
  .array(z.enum(MODIFIERS))
  .max(MODIFIERS.length)
  .refine(
    (list) => new Set(list).size === list.length,
    "List each modifier at most once",
  )
  .default([]);

// Shortcuts that end the user's session or take the Mac out of their hands:
// log out (Shift-Command-Q, and with Option added, without asking), lock the
// screen (Control-Command-Q) and the Force Quit window
// (Option-Command-Escape). A chord that holds every modifier of one of these
// and more is blocked too. Everything else is up to the task the user
// granted.
const BLOCKED_CHORDS: readonly {
  key: string;
  modifiers: readonly string[];
}[] = [
  { key: "q", modifiers: ["command", "shift"] },
  { key: "q", modifiers: ["command", "control"] },
  { key: "escape", modifiers: ["command", "option"] },
];

export const BLOCKED_CHORD_MESSAGE =
  "That shortcut logs out, locks the Mac or opens Force Quit, so OpenMuse doesn't send it. Ask the user to do it themselves.";

export function blockedChord(key: string, modifiers: readonly string[]) {
  return BLOCKED_CHORDS.some(
    (chord) =>
      chord.key === key &&
      chord.modifiers.every((modifier) => modifiers.includes(modifier)),
  );
}

export const SCROLL_DIRECTIONS = ["up", "down", "left", "right"] as const;
// Wheel notches per scroll_on_screen call. The helper sends each notch as
// one wheel event of three lines (native/Recorder.swift --scroll).
export const SCROLL_MAX = 10;
export const scrollDirectionSchema = z.enum(SCROLL_DIRECTIONS);
export const scrollAmountSchema = z.number().int().min(1).max(SCROLL_MAX);

// A double or triple click is one gesture with a rising click count, which
// is how apps tell it from separate clicks (native/Recorder.swift --click).
export const CLICKS_MAX = 3;
export const clicksSchema = z.number().int().min(1).max(CLICKS_MAX).default(1);
export const mouseButtonSchema = z.enum(["left", "right"]).default("left");

export const URL_MAX_LENGTH = 2048;

function urlProblem(text: string) {
  // Checked before parsing: the URL parser silently drops tabs and line
  // breaks from the middle of an address.
  if (/[\s\p{C}]/u.test(text))
    return "Use a web address without spaces or control characters";
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return "Use a full web address that starts with https://";
  }
  // The parser itself refuses an https address without a host.
  if (url.protocol !== "https:")
    return "Only https:// web addresses can be opened";
  if (url.username || url.password)
    return "Use a web address without a user name or password";
  return undefined;
}

// A superRefine, not a transform: the MCP SDK publishes each tool's input
// schema as JSON Schema, which a transform can't be written as.
export const httpsUrlSchema = z
  .string()
  .max(
    URL_MAX_LENGTH,
    `Use a web address of at most ${URL_MAX_LENGTH} characters`,
  )
  .superRefine((text, context) => {
    const problem = urlProblem(text);
    if (problem) context.addIssue({ code: "custom", message: problem });
  });

// What the prompt shows and the helper opens: the parser's own
// serialization, which percent-encodes anything outside ASCII and writes the
// host in punycode, so Swift's URL(string:) reads the address the user saw.
export function normalizedUrl(text: string) {
  return new URL(text).href;
}

const target = {
  screenshotId: screenshotIdSchema,
  x: z.number(),
  y: z.number(),
  label: pointLabelSchema,
};

// Every action the main process takes from the runtime. electron/main.ts
// parses each one again, whatever server/tools.ts already checked.
export const desktopActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("open-app"), bundleId: bundleIdSchema }),
  z.object({ type: z.literal("point"), ...target }),
  z.object({
    type: z.literal("open-url"),
    url: httpsUrlSchema,
    bundleId: bundleIdSchema,
  }),
  z.object({ type: z.literal("screenshot") }),
  z.object({
    type: z.literal("click"),
    ...target,
    button: mouseButtonSchema,
    clicks: clicksSchema,
  }),
  z.object({
    type: z.literal("scroll"),
    ...target,
    direction: scrollDirectionSchema,
    amount: scrollAmountSchema,
  }),
  z.object({ type: z.literal("type"), text: typedTextSchema }),
  z.object({
    type: z.literal("keys"),
    key: keyNameSchema,
    modifiers: modifiersSchema,
  }),
]);
