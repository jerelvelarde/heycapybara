import { z } from "zod";

export const screenshotIdSchema = z.string().regex(/^shot_[0-9a-f]{8}$/);

// Known blank-rendering characters: each occupies a code point but draws
// nothing (the Hangul jamo fillers and the halfwidth Hangul filler, Braille's
// blank pattern, the musical "null notehead", and the object replacement
// character used as an embedded-object placeholder). This list is not
// exhaustive - it cannot be, since Unicode keeps adding characters that
// render blank in some font. The rule that actually guards the approval
// dialog is the "visible text" rule below; this list only gives known
// offenders their own clearer, more specific rejection message before that
// final check would otherwise catch them too.
const BLANK_CHARACTERS = /[\u115F\u1160\u3164\uFFA0\u2800\u{1D159}\uFFFC]/u;

// A refine rather than .regex(): a published JSON Schema pattern has no `u`
// flag, so other MCP clients would read \p{...} differently.
//
// Each rule below is checked independently - zod runs every .refine() and
// reports every one that fails - but they stay in this order so the FIRST
// issue a caller sees is the most specific: control or invisible characters
// first, then known-blank characters, then stacked joining characters, then
// whether there is any visible text at all.
export const pointLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .refine(
    // Control, format, private-use, surrogate and unassigned characters
    // (\p{C}), plus line/paragraph separators - except ZWNJ and ZWJ, which
    // are themselves format characters (\p{Cf}) but are kept because they
    // join letters in scripts like Persian and join emoji into one glyph.
    (label) => !/(?![\u200C\u200D])[\p{C}\p{Zl}\p{Zp}]/u.test(label),
    "Use a single-line label without control, invisible or unsupported characters",
  )
  .refine(
    (label) => !BLANK_CHARACTERS.test(label),
    "Use a label without blank characters",
  )
  .refine(
    // A run of two or more ZWNJ/ZWJ with nothing joined in between joins
    // nothing real - legitimate multi-join emoji (a family sequence, say)
    // always have an actual character between one ZWJ and the next. In the
    // same spirit, one or two combining marks make a real accented letter;
    // three or more stack into a tall glyph that can draw over the dialog.
    (label) => !/[\u200C\u200D]{2,}|\p{M}{3,}/u.test(label),
    "Use a label without stacked or repeated joining characters",
  )
  .refine(
    (label) => /[\p{L}\p{N}]/u.test(label),
    "Use a label with visible text",
  );

// The label comes from the model, so it gets its own attributed line and
// can't rewrite the part of the prompt OpenMuse writes. That it is safe to
// show at all - one line, no control, invisible or blank characters -
// depends entirely on the label having already passed pointLabelSchema;
// this function does no validation of its own.
export function pointPrompt(label: string, displayName: string) {
  return {
    message: `Show a pointer on ${displayName}`,
    detail: `The agent says it points at: ${label}`,
  };
}
