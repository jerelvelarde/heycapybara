import { z } from "zod";

export const screenshotIdSchema = z.string().regex(/^shot_[0-9a-f]{8}$/);

// Characters known to render blank. The four Hangul fillers, Braille's blank
// pattern and the musical null notehead draw nothing, and the object
// replacement character, a placeholder for an embedded object, has no
// reliable glyph: some fonts draw an "OBJ" box, others nothing.
//
// The Hangul fillers are letters (general category Lo), so the
// letter-or-number rule accepts them. They are also default-ignorable, so
// the invisible-characters rule catches them too; this list just names them
// first. For U+2800, U+1D159 and U+FFFC, which are symbols (So), this list
// is the only guard: next to real text, every other rule accepts them.
//
// The list is not exhaustive, and can't be: Unicode keeps adding characters
// that render blank in some font.
export const BLANK_CODE_POINTS: readonly number[] = Object.freeze([
  0x115f, // Hangul choseong filler
  0x1160, // Hangul jungseong filler
  0x3164, // Hangul filler
  0xffa0, // halfwidth Hangul filler
  0x2800, // Braille pattern blank
  0x1d159, // musical symbol null notehead
  0xfffc, // object replacement character
]);

// Built from the list, so the list above is the only copy.
const BLANK_CHARACTERS = new RegExp(
  `[${String.fromCodePoint(...BLANK_CODE_POINTS)}]`,
  "u",
);

// The accent marks that fonts stack one above another on a single letter,
// by block. These five blocks get their own, tighter threshold below (three
// marks, not five), because real Latin-script words never stack that many
// diacritics on one letter. Real words in other scripts, such as Hindi,
// Burmese, Tibetan and pointed Hebrew, do put three or four marks in a row,
// so ANY_SCRIPT_STACK below gives every script the same four-mark cap
// (five or more rejected) instead of reusing this block list.
const ACCENT_BLOCKS: readonly [number, number][] = [
  [0x0300, 0x036f], // Combining Diacritical Marks
  [0x1ab0, 0x1aff], // Combining Diacritical Marks Extended
  [0x1dc0, 0x1dff], // Combining Diacritical Marks Supplement
  [0x20d0, 0x20ff], // Combining Diacritical Marks for Symbols
  [0xfe20, 0xfe2f], // Combining Half Marks
];
const ACCENT = `[${ACCENT_BLOCKS.map(
  ([first, last]) =>
    `${String.fromCodePoint(first)}-${String.fromCodePoint(last)}`,
).join("")}]`;

// Two joiners in a row join nothing: a real multi-join emoji (a family
// sequence, say) has a character between one ZWJ and the next. Three
// accents on one letter build a tall glyph that can draw over the alert.
// A mark, joiner or variation selector between two accents still belongs to
// the same letter, so it doesn't reset the count.
const STACKED = new RegExp(
  String.raw`[\u200C\u200D]{2,}|${ACCENT}(?:[\p{M}\u200C\u200D]*${ACCENT}){2,}`,
  "u",
);

// Five or more combining marks in a row build a tall glyph in any script,
// even when no single block above supplies three by itself: the well-known
// Thai, Tibetan, Arabic, Hebrew, Devanagari and Cyrillic tall-text tricks
// all stack marks outside the five Latin-centred blocks. A joiner may sit
// between marks without resetting the run, same as above. Variation
// selectors are marks too (general category Mn), so a run of dozens of
// emoji-style selectors alone is caught here as well; a single selector
// after one base character still passes.
const JOINERS = String.fromCodePoint(0x200c, 0x200d); // ZWNJ, ZWJ
const ANY_SCRIPT_STACK = new RegExp(
  String.raw`\p{M}(?:[${JOINERS}]*\p{M}){4,}`,
  "u",
);

// Two spaces with only marks or joiners between them. A run of blank space
// can push the rest of the label onto what looks like a line of its own.
const SPACE_RUN = /\p{Zs}[\p{M}\u200C\u200D]*\p{Zs}/u;

// A refine rather than .regex(): a published JSON Schema pattern has no `u`
// flag, so other MCP clients would read \p{...} differently.
//
// zod runs every check below and reports every one that fails, so the order
// decides only which issue a caller sees FIRST, and they stay in this order
// so that issue is the most specific: the length, then control and format
// characters, then known-blank characters, then other invisible characters,
// then stacked accents or repeated joiners, then runs of spaces, and last
// whether there is a letter or number at all.
export const pointLabelSchema = z
  .string()
  .trim()
  .min(1, "Use a label that is not empty")
  .max(60, "Use a label of at most 60 characters")
  .refine(
    // Control, format, private-use, surrogate and unassigned characters
    // (\p{C}), plus line/paragraph separators - except ZWNJ and ZWJ, which
    // are themselves format characters (\p{Cf}) but are kept because they
    // join letters in scripts like Persian and join emoji into one glyph.
    // Tag characters are format characters too, so a flag spelled with them,
    // such as England's (U+1F3F4 followed by tags), is rejected. That is
    // intended: allowing it would take a sequence check to tell a real flag
    // from tags that spell hidden text.
    (label) => !/(?![\u200C\u200D])[\p{C}\p{Zl}\p{Zp}]/u.test(label),
    "Use a single-line label without control, invisible or unsupported characters",
  )
  .refine(
    (label) => !BLANK_CHARACTERS.test(label),
    "Use a label without blank characters",
  )
  .refine(
    // Default-ignorable characters have no glyph of their own. Most are
    // format characters the first rule already rejects; this catches the
    // marks and letters among them, such as the combining grapheme joiner,
    // the Mongolian free variation selectors and the Khmer inherent vowels.
    // ZWNJ and ZWJ stay allowed, as above, and so do U+FE0E and U+FE0F,
    // which pick text or emoji style for the symbol before them.
    (label) =>
      !/(?![\u200C\u200D])(?![\uFE0E\uFE0F])\p{Default_Ignorable_Code_Point}/u.test(
        label,
      ),
    "Use a label without invisible characters",
  )
  .refine(
    (label) => !STACKED.test(label) && !ANY_SCRIPT_STACK.test(label),
    "Use a label without stacked accent marks or repeated joiners",
  )
  .refine((label) => !SPACE_RUN.test(label), "Use single spaces between words")
  .refine(
    (label) => /[\p{L}\p{N}]/u.test(label),
    "Use a label with at least one letter or number",
  );

// macOS doesn't show an alert's title, so the message itself says who is
// asking. The message is OpenMuse's own text; the label comes from the
// model, so it goes on its own attributed line in the detail, where it can't
// rewrite the message. This function does no validation: what a label may
// contain, and so what is safe to show, is pointLabelSchema's job, and the
// label must already have passed it.
export function pointPrompt(label: string, displayName: string) {
  return {
    message: `The agent wants to show a pointer on ${displayName}`,
    detail: `The agent says it points at: ${label}`,
  };
}

// Must match native/Recorder.swift's --open-app pattern (guarded by a
// parity test in tests/tools.test.ts): a bundle id there is rejected by the
// native helper even after the user has approved it here, so the two checks
// have to agree on exactly what counts as a valid bundle id.
export const bundleIdSchema = z
  .string()
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/);
