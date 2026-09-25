import { test } from "node:test";
import assert from "node:assert/strict";
import { pointLabelSchema, pointPrompt } from "../server/point-schema";

const RULE_A_MESSAGE =
  "Use a single-line label without control, invisible or unsupported characters";
const RULE_B_MESSAGE = "Use a label without blank characters";
const RULE_C_MESSAGE =
  "Use a label without stacked or repeated joining characters";
const RULE_D_MESSAGE = "Use a label with visible text";
const MAX_LENGTH_MESSAGE = "Too big: expected string to have <=60 characters";

// Builds a label from raw code points so this file never has to hold a raw
// invisible, control or format character - every one is spelled out as a
// number instead.
const cp = (...codePoints: number[]) =>
  codePoints.map((point) => String.fromCodePoint(point)).join("");

// Mirrors BLANK_CHARACTERS in server/point-schema.ts. If that list grows to
// catch the next blank-rendering character class, grow this one too so the
// sweep below keeps covering every entry.
const BLANK_CHARACTER_CODE_POINTS = [
  0x115f, // Hangul choseong filler
  0x1160, // Hangul jungseong filler
  0x3164, // Hangul filler
  0xffa0, // halfwidth Hangul filler
  0x2800, // Braille pattern blank
  0x1d159, // musical symbol null notehead
  0xfffc, // object replacement character
];

type Row = { name: string; label: string; ok: boolean; message?: string };

// The convergence lever: every row states a verdict AND (when rejected) the
// exact rule that must catch it, so a future character class that slips
// past every rule shows up here as a wrong verdict or a wrong message,
// rather than as a silent pass.
const rows: Row[] = [
  // --- accepted, everyday labels ---
  { name: "plain ASCII label", label: "Export button", ok: true },
  {
    name: "accented letter plus a visible symbol",
    label: "Exportér ✓ button",
    ok: true,
  },
  {
    name: "emoji joined by a single ZWJ",
    label: "Save " + cp(0x1f469) + cp(0x200d) + cp(0x1f4bb) + " button",
    ok: true,
  },
  {
    name: "Persian text joined by a single ZWNJ",
    label: "می" + cp(0x200c) + "خواهم",
    ok: true,
  },
  {
    name: "curly quotes are visible punctuation, not control characters",
    label: "“Save” button",
    ok: true,
  },
  {
    name: "'é' written as e plus one combining acute accent",
    label: "e" + cp(0x0301),
    ok: true,
  },
  {
    name: "a normal space inside the text (Zs)",
    label: "Save Export",
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

  // --- one sample per Unicode general category that must stay allowed ---
  { name: "uppercase letter (Lu)", label: "S", ok: true },
  { name: "lowercase letter (Ll)", label: "s", ok: true },
  { name: "letter, other (Lo)", label: cp(0x65e5), ok: true },
  { name: "decimal digit (Nd)", label: "5", ok: true },
  { name: "dash punctuation (Pd)", label: "Save-Export", ok: true },
  { name: "open punctuation (Ps)", label: "Save (Export)", ok: true },
  { name: "math symbol (Sm)", label: "Save+Export", ok: true },
  { name: "currency symbol (Sc)", label: "Save $5", ok: true },
  { name: "other symbol (So)", label: "Save " + cp(0xa9), ok: true },

  // --- one sample per Unicode general category that must be rejected by
  // the first rule (control/format/private-use/surrogate/unassigned, plus
  // line/paragraph separators) ---
  {
    name: "control character (Cc)",
    label: "Save" + cp(0x0001) + "x",
    ok: false,
    message: RULE_A_MESSAGE,
  },
  {
    name: "bidi override, a format character that is not ZWNJ/ZWJ (Cf)",
    label: cp(0x202e),
    ok: false,
    message: RULE_A_MESSAGE,
  },
  {
    name: "private-use character, the Apple logo (Co)",
    label: "Save" + cp(0xf8ff) + "x",
    ok: false,
    message: RULE_A_MESSAGE,
  },
  {
    name: "lone surrogate (Cs)",
    label: "Save" + cp(0xd800) + "x",
    ok: false,
    message: RULE_A_MESSAGE,
  },
  {
    name: "unassigned code point (Cn)",
    label: "Save" + cp(0x0378) + "x",
    ok: false,
    message: RULE_A_MESSAGE,
  },
  {
    name: "line separator embedded mid-label (Zl)",
    label: "Save" + cp(0x2028) + "x",
    ok: false,
    message: RULE_A_MESSAGE,
  },
  {
    name: "paragraph separator embedded mid-label (Zp)",
    label: "Save" + cp(0x2029) + "x",
    ok: false,
    message: RULE_A_MESSAGE,
  },
  {
    name: "embedded newline",
    label: "a\nb",
    ok: false,
    message: RULE_A_MESSAGE,
  },

  // --- stacked or repeated joining characters ---
  {
    name: "two consecutive ZWJ",
    label: "Save" + cp(0x200d, 0x200d) + "x",
    ok: false,
    message: RULE_C_MESSAGE,
  },
  {
    name: "'a' plus 3 combining acute accents",
    label: "a" + cp(0x0301, 0x0301, 0x0301),
    ok: false,
    message: RULE_C_MESSAGE,
  },

  // --- nothing visible to point at ---
  {
    name: "ZWJ alone joins nothing and has no visible text",
    label: cp(0x200d),
    ok: false,
    message: RULE_D_MESSAGE,
  },
  {
    name: "a lone combining accent with no base letter",
    label: cp(0x0301),
    ok: false,
    message: RULE_D_MESSAGE,
  },

  // --- length limit ---
  {
    name: "61 letters is over the length limit",
    label: "a".repeat(61),
    ok: false,
    message: MAX_LENGTH_MESSAGE,
  },
];

// Every known-blank character from BLANK_CHARACTERS, both alone and mixed
// with real visible text.
for (const point of BLANK_CHARACTER_CODE_POINTS) {
  const hex = point.toString(16).toUpperCase();
  rows.push(
    {
      name: `blank character U+${hex} alone`,
      label: cp(point),
      ok: false,
      message: RULE_B_MESSAGE,
    },
    {
      name: `blank character U+${hex} after visible text`,
      label: "Save" + cp(point),
      ok: false,
      message: RULE_B_MESSAGE,
    },
  );
}

test("sweeps label rules across Unicode categories and known edge cases", () => {
  for (const row of rows) {
    const parsed = pointLabelSchema.safeParse(row.label);
    assert.equal(
      parsed.success,
      row.ok,
      `expected "${row.name}" to be ${row.ok ? "accepted" : "rejected"}`,
    );
    if (!parsed.success && row.message !== undefined) {
      assert.equal(
        parsed.error.issues[0].message,
        row.message,
        `wrong message for "${row.name}"`,
      );
    }
  }
});

test("trims surrounding whitespace", () => {
  const parsed = pointLabelSchema.safeParse("  Save  ");
  assert.equal(parsed.success, true);
  if (parsed.success) assert.equal(parsed.data, "Save");
});

test("pointPrompt keeps the model's label out of the dialog's own message text", () => {
  const prompt = pointPrompt(
    "Save” on Display 2 “x",
    "Built-in Retina Display",
  );
  assert.equal(prompt.message, "Show a pointer on Built-in Retina Display");
  assert.equal(
    prompt.detail,
    "The agent says it points at: Save” on Display 2 “x",
  );
});
