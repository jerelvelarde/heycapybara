import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BLANK_CODE_POINTS,
  pointLabelSchema,
  pointPrompt,
} from "../server/point-schema";

const EMPTY_MESSAGE = "Use a label that is not empty";
const TOO_LONG_MESSAGE = "Use a label of at most 60 characters";
const CONTROL_MESSAGE =
  "Use a single-line label without control, invisible or unsupported characters";
const BLANK_MESSAGE = "Use a label without blank characters";
const INVISIBLE_MESSAGE = "Use a label without invisible characters";
const STACK_MESSAGE =
  "Use a label without stacked accent marks or repeated joiners";
const SPACES_MESSAGE = "Use single spaces between words";
const LETTER_MESSAGE = "Use a label with at least one letter or number";

// Builds a label from code points, so this file holds no raw non-ASCII
// character: every one, visible or not, is spelled out as a number instead.
const cp = (...codePoints: number[]) =>
  codePoints.map((point) => String.fromCodePoint(point)).join("");

const ZWNJ = 0x200c;
const ZWJ = 0x200d;
const ACUTE = 0x0301; // combining acute accent
const EMOJI_STYLE = 0xfe0f; // variation selector-16
const TEXT_STYLE = 0xfe0e; // variation selector-15

type Row = { name: string; label: string } & (
  { ok: true } | { ok: false; message: string }
);

// Every row states a verdict and, when rejected, the message that must come
// first, so a character that slips past every rule, or that the wrong rule
// catches, fails here instead of passing unnoticed.
const rows: Row[] = [
  // --- accepted, everyday labels ---
  { name: "plain ASCII label", label: "Export button", ok: true },
  {
    name: "accented letter plus a visible symbol",
    label: "Export" + cp(0xe9) + "r " + cp(0x2713) + " button",
    ok: true,
  },
  {
    name: "emoji joined by a single ZWJ",
    label: "Save " + cp(0x1f469, ZWJ, 0x1f4bb) + " button",
    ok: true,
  },
  {
    name: "family emoji: a real character between one ZWJ and the next",
    label: "Family " + cp(0x1f468, ZWJ, 0x1f469, ZWJ, 0x1f467),
    ok: true,
  },
  {
    name: "Persian text joined by a single ZWNJ",
    label: cp(0x645, 0x6cc, ZWNJ, 0x62e, 0x648, 0x627, 0x647, 0x645),
    ok: true,
  },
  {
    name: "curly quotes are visible punctuation, not control characters",
    label: cp(0x201c) + "Save" + cp(0x201d) + " button",
    ok: true,
  },
  {
    name: "leading and trailing spaces are trimmed away",
    label: "  Save  ",
    ok: true,
  },
  {
    name: "exactly 60 letters is at the length limit",
    label: "a".repeat(60),
    ok: true,
  },

  // --- real words that put three or more marks in a row: marks outside the
  // stacking accent blocks are not limited ---
  {
    name: "Hindi: nukta, vowel sign and anusvara on one consonant",
    label: cp(0x91a, 0x940, 0x91c, 0x93c, 0x947, 0x902),
    ok: true,
  },
  {
    name: "Burmese: a spacing medial and two vowel signs side by side",
    label: cp(
      0x1000,
      0x103c,
      0x102d,
      0x102f,
      0x1006,
      0x102d,
      0x102f,
      0x1015,
      0x102b,
      0x1010,
      0x101a,
      0x103a,
    ),
    ok: true,
  },
  {
    name: "Tibetan: two subjoined letters and a vowel sign under one letter",
    label: cp(0xf66, 0xf92, 0xfb2, 0xf74, 0xf56),
    ok: true,
  },
  {
    name: "pointed Hebrew: patah, dagesh and shin dot on one letter",
    label: cp(0x5e9, 0x5b7, 0x5bc, 0x5c1, 0x5d1, 0x5b8, 0x5bc, 0x5ea),
    ok: true,
  },
  {
    name: "pointed and cantillated Hebrew: hiriq, shin dot and tipeha on one letter",
    label: cp(
      0x5d1,
      0x5b0,
      0x5bc,
      0x5e8,
      0x5b5,
      0x5d0,
      0x5e9,
      0x5b4,
      0x5c1,
      0x596,
      0x5d9,
      0x5ea,
    ),
    ok: true,
  },
  {
    name: "Vietnamese with decomposed accents: e + U+0323 + U+0302 is two, not a stack",
    label: "Tie" + cp(0x302, ACUTE) + "ng Vie" + cp(0x323, 0x302) + "t",
    ok: true,
  },

  // --- emoji presentation and flags ---
  {
    name: "red heart in emoji style (U+2764 U+FE0F) next to a word",
    label: "Like " + cp(0x2764, EMOJI_STYLE),
    ok: true,
  },
  {
    name: "red heart in text style (U+2764 U+FE0E) next to a word",
    label: "Like " + cp(0x2764, TEXT_STYLE),
    ok: true,
  },
  {
    name: "heart on fire: an emoji-style selector followed by a ZWJ",
    label: cp(0x2764, EMOJI_STYLE, ZWJ, 0x1f525) + " Hot",
    ok: true,
  },
  {
    name: "regional-indicator flag next to a word",
    label: "Japan " + cp(0x1f1ef, 0x1f1f5),
    ok: true,
  },
  {
    // Rejected on purpose: tag characters are format characters (Cf).
    name: "tag-sequence flag: England is U+1F3F4 plus tag characters",
    label:
      "England " +
      cp(0x1f3f4, 0xe0067, 0xe0062, 0xe0065, 0xe006e, 0xe0067, 0xe007f),
    ok: false,
    message: CONTROL_MESSAGE,
  },

  // --- one sample for each general category a label may use: every letter,
  // mark, number, punctuation and symbol category, plus the space separator
  // (Zs). A sample that is not a letter or number sits next to one. ---
  { name: "uppercase letter (Lu)", label: "S", ok: true },
  { name: "lowercase letter (Ll)", label: "s", ok: true },
  { name: "titlecase letter (Lt)", label: cp(0x1c5) + "ep", ok: true },
  { name: "modifier letter (Lm)", label: cp(0x6642, 0x3005), ok: true },
  { name: "other letter (Lo)", label: cp(0x65e5), ok: true },
  {
    name: "nonspacing mark (Mn): e plus one combining acute accent",
    label: "e" + cp(ACUTE),
    ok: true,
  },
  {
    name: "spacing mark (Mc): a Devanagari vowel sign",
    label: cp(0x928, 0x93e, 0x92e),
    ok: true,
  },
  {
    name: "enclosing mark (Me): the keycap in a keycap emoji",
    label: "Step " + cp(0x31, EMOJI_STYLE, 0x20e3),
    ok: true,
  },
  { name: "decimal digit (Nd)", label: "5", ok: true },
  { name: "letter number (Nl)", label: "Chapter " + cp(0x2163), ok: true },
  { name: "other number (No)", label: "x" + cp(0xb2), ok: true },
  { name: "connector punctuation (Pc)", label: "save_file", ok: true },
  { name: "dash punctuation (Pd)", label: "Save-Export", ok: true },
  { name: "open punctuation (Ps)", label: "Save (Export)", ok: true },
  { name: "close punctuation (Pe)", label: "Step 1)", ok: true },
  { name: "initial quote (Pi)", label: cp(0xab) + " Back", ok: true },
  { name: "final quote (Pf)", label: "Next " + cp(0xbb), ok: true },
  { name: "other punctuation (Po)", label: "More" + cp(0x2026), ok: true },
  { name: "math symbol (Sm)", label: "Save+Export", ok: true },
  { name: "currency symbol (Sc)", label: "Save $5", ok: true },
  { name: "modifier symbol (Sk)", label: "Press ^C", ok: true },
  { name: "other symbol (So)", label: "Save " + cp(0xa9), ok: true },
  {
    name: "space separator (Zs): one space between words",
    label: "Save Export",
    ok: true,
  },

  // --- one sample per Unicode general category that must be rejected by
  // the first rule (control/format/private-use/surrogate/unassigned, plus
  // line/paragraph separators) ---
  {
    name: "control character (Cc)",
    label: "Save" + cp(0x0001) + "x",
    ok: false,
    message: CONTROL_MESSAGE,
  },
  {
    name: "bidi override, a format character that is not ZWNJ/ZWJ (Cf)",
    label: cp(0x202e),
    ok: false,
    message: CONTROL_MESSAGE,
  },
  {
    name: "private-use character, the Apple logo (Co)",
    label: "Save" + cp(0xf8ff) + "x",
    ok: false,
    message: CONTROL_MESSAGE,
  },
  {
    name: "lone surrogate (Cs)",
    label: "Save" + cp(0xd800) + "x",
    ok: false,
    message: CONTROL_MESSAGE,
  },
  {
    name: "unassigned code point (Cn)",
    label: "Save" + cp(0x0378) + "x",
    ok: false,
    message: CONTROL_MESSAGE,
  },
  {
    name: "line separator embedded mid-label (Zl)",
    label: "Save" + cp(0x2028) + "x",
    ok: false,
    message: CONTROL_MESSAGE,
  },
  {
    name: "paragraph separator embedded mid-label (Zp)",
    label: "Save" + cp(0x2029) + "x",
    ok: false,
    message: CONTROL_MESSAGE,
  },
  {
    name: "embedded newline",
    label: "a" + cp(0x0a) + "b",
    ok: false,
    message: CONTROL_MESSAGE,
  },

  // --- other invisible (default-ignorable) characters: marks or letters,
  // not format characters, so the first rule lets them through ---
  {
    name: "a pair of combining grapheme joiners (U+034F)",
    label: "Save" + cp(0x34f, 0x34f),
    ok: false,
    message: INVISIBLE_MESSAGE,
  },
  {
    name: "three combining grapheme joiners are invisible, not a stack",
    label: "a" + cp(0x34f, 0x34f, 0x34f),
    ok: false,
    message: INVISIBLE_MESSAGE,
  },
  {
    name: "Mongolian free variation selector (U+180B)",
    label: "Save" + cp(0x180b),
    ok: false,
    message: INVISIBLE_MESSAGE,
  },
  {
    name: "Khmer inherent vowel (U+17B4)",
    label: "Save" + cp(0x17b4),
    ok: false,
    message: INVISIBLE_MESSAGE,
  },
  {
    name: "a variation selector other than the text and emoji styles (U+FE00)",
    label: "Save" + cp(0xfe00),
    ok: false,
    message: INVISIBLE_MESSAGE,
  },

  // --- stacked accents or repeated joiners ---
  {
    name: "two consecutive ZWJ",
    label: "Save" + cp(ZWJ, ZWJ) + "x",
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "'a' plus 3 combining acute accents",
    label: "a" + cp(ACUTE, ACUTE, ACUTE),
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "38 accents on one letter, with a ZWJ after every pair",
    label: "a" + cp(ACUTE, ACUTE, ZWJ).repeat(19),
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "29 accents on one letter, each after a ZWJ",
    label: "a" + cp(ZWJ, ACUTE).repeat(29),
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "38 accents on one letter, with a ZWNJ after every pair",
    label: "a" + cp(ACUTE, ACUTE, ZWNJ).repeat(19),
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "38 accents on one letter, with an emoji-style selector after every pair",
    label: "a" + cp(ACUTE, ACUTE, EMOJI_STYLE).repeat(19),
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "38 accents on one letter, with a Devanagari stress sign after every pair",
    label: "a" + cp(ACUTE, ACUTE, 0x951).repeat(19),
    ok: false,
    message: STACK_MESSAGE,
  },

  // --- runs of spaces, which could push text onto what looks like a line
  // of its own in the alert ---
  {
    name: "two spaces between words",
    label: "Save  x",
    ok: false,
    message: SPACES_MESSAGE,
  },
  {
    name: "two ideographic spaces (U+3000) between words",
    label: "Save" + cp(0x3000, 0x3000) + "x",
    ok: false,
    message: SPACES_MESSAGE,
  },
  {
    name: "30 spaces before text that reads like OpenMuse's own",
    label: "Save" + " ".repeat(30) + "Approved by OpenMuse",
    ok: false,
    message: SPACES_MESSAGE,
  },
  {
    name: "two spaces with a ZWNJ between them",
    label: "Save " + cp(ZWNJ) + " Approved",
    ok: false,
    message: SPACES_MESSAGE,
  },
  {
    name: "two spaces with a combining accent between them",
    label: "Save " + cp(ACUTE) + " x",
    ok: false,
    message: SPACES_MESSAGE,
  },

  // --- no letter or number to read ---
  {
    name: "ZWJ alone joins nothing",
    label: cp(ZWJ),
    ok: false,
    message: LETTER_MESSAGE,
  },
  {
    name: "a lone combining accent with no base letter",
    label: cp(ACUTE),
    ok: false,
    message: LETTER_MESSAGE,
  },
  {
    name: "a gear symbol alone",
    label: cp(0x2699),
    ok: false,
    message: LETTER_MESSAGE,
  },
  {
    name: "an arrow alone",
    label: cp(0x2192),
    ok: false,
    message: LETTER_MESSAGE,
  },
  {
    name: "a magnifying glass emoji alone",
    label: cp(0x1f50d),
    ok: false,
    message: LETTER_MESSAGE,
  },
  { name: "a plus sign alone", label: "+", ok: false, message: LETTER_MESSAGE },
  {
    name: "an ellipsis alone",
    label: cp(0x2026),
    ok: false,
    message: LETTER_MESSAGE,
  },

  // --- length limits ---
  { name: "an empty label", label: "", ok: false, message: EMPTY_MESSAGE },
  {
    name: "a label of only spaces trims to empty",
    label: "   ",
    ok: false,
    message: EMPTY_MESSAGE,
  },
  {
    name: "61 letters is over the length limit",
    label: "a".repeat(61),
    ok: false,
    message: TOO_LONG_MESSAGE,
  },

  // --- length limit is counted in code points, not UTF-16 units - each of
  // these astral-plane letters (U+1D400 MATHEMATICAL BOLD CAPITAL A) is one
  // code point but two UTF-16 units, so 60 of them is 120 UTF-16 units and
  // must still pass ---
  {
    name: "60 astral-plane letters is at the length limit in code points",
    label: cp(0x1d400).repeat(60),
    ok: true,
  },
  {
    name: "61 astral-plane letters is over the length limit in code points",
    label: cp(0x1d400).repeat(61),
    ok: false,
    message: TOO_LONG_MESSAGE,
  },
];

// Every character in the schema's own blank list, both alone and beside
// real text.
for (const point of BLANK_CODE_POINTS) {
  const hex = point.toString(16).toUpperCase();
  rows.push(
    {
      name: `blank character U+${hex} alone`,
      label: cp(point),
      ok: false,
      message: BLANK_MESSAGE,
    },
    {
      name: `blank character U+${hex} after visible text`,
      label: "Save" + cp(point),
      ok: false,
      message: BLANK_MESSAGE,
    },
  );
}

// "accepted", or the message of the first issue.
function verdict(label: string) {
  const parsed = pointLabelSchema.safeParse(label);
  return parsed.success ? "accepted" : parsed.error.issues[0].message;
}

test("sweeps label rules across Unicode categories and known edge cases", () => {
  const wrong = rows
    .map((row) => ({
      name: row.name,
      expected: row.ok ? "accepted" : row.message,
      actual: verdict(row.label),
    }))
    .filter((row) => row.actual !== row.expected);
  assert.deepEqual(wrong, []);
});

test("the Hangul fillers also fail the invisible rule, but only the blank list catches the other blank characters", () => {
  const messages = (point: number) => {
    const parsed = pointLabelSchema.safeParse("Save" + cp(point));
    return parsed.success
      ? []
      : parsed.error.issues.map((issue) => issue.message);
  };
  for (const point of [0x115f, 0x1160, 0x3164, 0xffa0]) {
    assert.deepEqual(
      messages(point),
      [BLANK_MESSAGE, INVISIBLE_MESSAGE],
      `U+${point.toString(16).toUpperCase()}`,
    );
  }
  for (const point of [0x2800, 0x1d159, 0xfffc]) {
    assert.deepEqual(
      messages(point),
      [BLANK_MESSAGE],
      `U+${point.toString(16).toUpperCase()}`,
    );
  }
});

test("trims surrounding whitespace", () => {
  const parsed = pointLabelSchema.safeParse("  Save  ");
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data, "Save");
});

test("pointPrompt names the agent in its own message and keeps the model's label out of it", () => {
  const label = "Save" + cp(0x201d) + " on Display 2 " + cp(0x201c) + "x";
  const prompt = pointPrompt(label, "Built-in Retina Display");
  assert.equal(
    prompt.message,
    "The agent wants to show a pointer on Built-in Retina Display",
  );
  assert.equal(prompt.detail, "The agent says it points at: " + label);
});
