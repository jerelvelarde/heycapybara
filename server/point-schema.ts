import { z } from "zod";

export const screenshotIdSchema = z.string().regex(/^shot_[0-9a-f]{8}$/);

// These characters render as nothing, so a label made only of them would
// leave the approval prompt without a visible target.
const BLANK_LETTERS = /[\u115F\u1160\u3164\uFFA0\u2800]/gu;

// A refine rather than .regex(): a published JSON Schema pattern has no `u`
// flag, so other MCP clients would read \p{...} differently.
export const pointLabelSchema = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .refine(
    (label) => !/(?![\u200C\u200D])[\p{C}\p{Zl}\p{Zp}]/u.test(label),
    "Use a single-line label without control or invisible formatting characters",
  )
  .refine(
    (label) => /[\p{L}\p{N}\p{P}\p{S}]/u.test(label.replace(BLANK_LETTERS, "")),
    "Use a label with visible text",
  );

// The label comes from the model, so it gets its own attributed line and
// can't rewrite the part of the prompt OpenMuse writes.
export function pointPrompt(label: string, displayName: string) {
  return {
    message: `Show a pointer on ${displayName}`,
    detail: `The agent says it points at: ${label}`,
  };
}
