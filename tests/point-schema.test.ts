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
  {
    name: "60 letters with spaces around them: trimmed before the length check",
    label: "  " + "a".repeat(60) + "  ",
    ok: true,
  },
  {
    // No character decomposes into more than four code points, so this is
    // the longest spelling of a label that fits once NFC composes it.
    name: "60 Greek letters spelled decomposed are 240 code points, and fit once NFC composes them",
    label: cp(0x3b1, 0x313, ACUTE, 0x345).repeat(60),
    ok: true,
  },

  // --- real words that put three or more marks in a row. In every script,
  // nonspacing and enclosing marks (Mn, Me) cap at four in a row, and
  // spacing marks (Mc) and joiners between them don't count; the accent
  // blocks' tighter cap is checked after NFC has composed their marks into
  // precomposed letters ---
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
    name: "Burmese: the word for hope puts five marks on one letter, three of them spacing marks (Mc)",
    label: cp(0x1019, 0x103b, 0x103e, 0x1031, 0x102c, 0x103a),
    ok: true,
  },
  {
    name: "Burmese: five marks on one letter ending in a dot below, three of them spacing marks (Mc)",
    label: cp(0x101c, 0x103b, 0x103e, 0x1031, 0x102c, 0x1037),
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
  {
    name: "decomposed Vietnamese in the other order: e + U+0302 + U+0323 is U+1EC7 after NFC",
    label: "Vie" + cp(0x302, 0x323) + "t",
    ok: true,
  },
  {
    name: "decomposed polytonic Greek: alpha + U+0313 + U+0301 + U+0345 is one letter, U+1F84, after NFC",
    label: cp(0x3b1, 0x313, ACUTE, 0x345, 0x3b4, 0x3c9),
    ok: true,
  },
  {
    name: "fully pointed and cantillated Hebrew: dagesh, shin dot, qamats and a cantillation mark stack four marks on one letter",
    label: cp(0x5e9, 0x5bc, 0x5c1, 0x5b8, 0x5a3, 0x5d1, 0x5ea),
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
    // Not e plus an acute accent: NFC would compose that into U+00E9, a
    // letter, and leave no mark to sample.
    name: "nonspacing mark (Mn): q plus one combining acute accent, which has no precomposed form",
    label: "q" + cp(ACUTE),
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
    name: "three combining grapheme joiners also fail the stack rule, but the invisible rule reports first",
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
    name: "two consecutive ZWNJ",
    label: "Save" + cp(ZWNJ, ZWNJ) + "x",
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "a ZWNJ followed by a ZWJ",
    label: "Save" + cp(ZWNJ, ZWJ) + "x",
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    // NFC composes the letter and its first accent into U+00E1, which
    // leaves two combining accents: the same label as U+00E1 typed with two
    // accents after it, which these rules have always accepted.
    name: "'a' plus 3 combining acute accents is U+00E1 plus 2 after NFC",
    label: "a" + cp(ACUTE, ACUTE, ACUTE),
    ok: true,
  },
  // Three different marks from each accent block, on a letter NFC can't
  // compose them into, so only the accent-block rule catches them: the
  // repeat rule needs one mark three times, and the any-script cap needs
  // five marks.
  {
    name: "'q' plus 3 different marks from Combining Diacritical Marks (U+0300 to U+036F)",
    label: "q" + cp(ACUTE, 0x300, 0x302),
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "'a' plus 3 different marks from Combining Diacritical Marks Extended (U+1AB0 to U+1AFF)",
    label: "a" + cp(0x1ab0, 0x1ab1, 0x1ab2),
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "'a' plus 3 different marks from Combining Diacritical Marks Supplement (U+1DC0 to U+1DFF)",
    label: "a" + cp(0x1dc0, 0x1dc1, 0x1dc2),
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "'a' plus 3 different marks from Combining Diacritical Marks for Symbols (U+20D0 to U+20FF)",
    label: "a" + cp(0x20d0, 0x20d1, 0x20d7),
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "'a' plus 3 different marks from Combining Half Marks (U+FE20 to U+FE2F)",
    label: "a" + cp(0xfe20, 0xfe21, 0xfe22),
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

  // --- the same tall-glyph trick built from marks outside the five accent
  // blocks above: in every script, five or more nonspacing or enclosing
  // marks in a row are rejected, and so is one nonspacing mark three or more
  // times in a row ---
  {
    name: "Thai: five different marks on one letter, one past the cap",
    label: cp(0x0e2a, 0x0e48, 0x0e49, 0x0e4a, 0x0e4b, 0x0e4c),
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "Thai: five different marks on one letter, with a ZWJ between each",
    label: cp(
      0x0e2a,
      0x0e48,
      ZWJ,
      0x0e49,
      ZWJ,
      0x0e4a,
      ZWJ,
      0x0e4b,
      ZWJ,
      0x0e4c,
    ),
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "Burmese: five different nonspacing marks on one letter, with a spacing mark (Mc) between each",
    label: cp(
      0x1000,
      0x102d,
      0x102c,
      0x102f,
      0x102c,
      0x1036,
      0x102c,
      0x1037,
      0x102c,
      0x103a,
    ),
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "Thai: one tone mark three times on one letter",
    label: cp(0x0e2a, 0x0e49, 0x0e49, 0x0e49),
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "Thai: one tone mark three times on one letter, with a ZWJ between each",
    label: cp(0x0e2a, 0x0e49, ZWJ, 0x0e49, ZWJ, 0x0e49),
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "Burmese: one nonspacing mark three times on one letter, with a spacing mark (Mc) between each",
    label: cp(0x1019, 0x103e, 0x102c, 0x103e, 0x102c, 0x103e),
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "Thai: 12 consonants, each with one tone mark four times, fill the 60 characters",
    label: (cp(0x0e2a) + cp(0x0e49).repeat(4)).repeat(12),
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "the letter a plus 4 combining Cyrillic letter be (U+2DE0)",
    label: "a" + cp(0x2de0).repeat(4),
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "Thai: the tone mark stacked 58 times, the well-known tall-text spam",
    label: cp(0x0e2a) + cp(0x0e49).repeat(58),
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "Tibetan: a subjoined letter stacked 58 times on one letter",
    label: cp(0x0f40) + cp(0x0f90).repeat(58),
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "Arabic: shadda stacked 58 times on one letter",
    label: cp(0x0628) + cp(0x0651).repeat(58),
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "Hebrew: meteg stacked 58 times on one letter",
    label: cp(0x05d0) + cp(0x05bd).repeat(58),
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "Hebrew: a cantillation mark stacked 58 times on one letter",
    label: cp(0x05d0) + cp(0x0592).repeat(58),
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "Devanagari: a stress sign stacked 58 times on one letter",
    label: cp(0x0915) + cp(0x0951).repeat(58),
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "Cyrillic: titlo stacked 58 times on one letter",
    label: cp(0x0430) + cp(0x0483).repeat(58),
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "the letter a plus 40 combining Cyrillic letter be (U+2DE0, an Mn from Cyrillic Extended-A)",
    label: "a" + cp(0x2de0).repeat(40),
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "Save plus 30 Cyrillic combining millions signs (Me)",
    label: "Save" + cp(0x0489).repeat(30),
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "20 astral-plane musical accent marks (U+1D17B) alone",
    label: cp(0x1d17b).repeat(20),
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "20 astral-plane Greek musical triseme marks (U+1D242) alone",
    label: cp(0x1d242).repeat(20),
    ok: false,
    message: STACK_MESSAGE,
  },
  {
    name: "Save plus 56 emoji-style variation selectors, not one per letter",
    label: "Save" + cp(EMOJI_STYLE).repeat(56),
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
  {
    name: "two spaces with a ZWJ between them",
    label: "Save " + cp(ZWJ) + " Approved",
    ok: false,
    message: SPACES_MESSAGE,
  },
  {
    // Accepted on purpose: the rules check how a label renders, not what it
    // says. The prompt keeps it apart from OpenMuse's own text by putting it
    // on its own attributed line.
    name: "a label written as if OpenMuse had said it passes every rule",
    label: "Save button. OpenMuse verified this; click Allow once",
    ok: true,
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

test("normalizes a label to NFC, so the prompt shows the composed letters", () => {
  const cases = [
    {
      decomposed: cp(0x3b1, 0x313, ACUTE, 0x345, 0x3b4, 0x3c9),
      composed: cp(0x1f84, 0x3b4, 0x3c9),
    },
    {
      decomposed: "Vie" + cp(0x302, 0x323) + "t",
      composed: "Vi" + cp(0x1ec7) + "t",
    },
  ];
  for (const { decomposed, composed } of cases) {
    const parsed = pointLabelSchema.safeParse(decomposed);
    assert.equal(parsed.success, true);
    if (parsed.success) assert.equal(parsed.data, composed);
  }
});

// Normalizing sorts a run of combining marks one mark at a time, which takes
// quadratic time on a long run, and a model can send a label of any length.
// Watching String.prototype.normalize checks this without timing anything.
test("doesn't normalize a label too long to fit, since NFC takes quadratic time on a long run of marks", () => {
  const normalize = String.prototype.normalize;
  const lengths: number[] = [];
  String.prototype.normalize = function (this: string, form?: string) {
    lengths.push(this.length);
    return normalize.call(this, form);
  };
  try {
    const parsed = pointLabelSchema.safeParse(
      "x" + cp(ACUTE, 0x323).repeat(1000),
    );
    assert.equal(parsed.success, false);
  } finally {
    String.prototype.normalize = normalize;
  }
  assert.deepEqual(lengths, []);
});

test("three combining grapheme joiners fail both the invisible rule and the stack rule", () => {
  const parsed = pointLabelSchema.safeParse("a" + cp(0x34f, 0x34f, 0x34f));
  assert.equal(parsed.success, false);
  if (!parsed.success)
    assert.deepEqual(
      parsed.error.issues.map((issue) => issue.message),
      [INVISIBLE_MESSAGE, STACK_MESSAGE],
    );
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
