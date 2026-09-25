import { test } from "node:test";
import assert from "node:assert/strict";
import { pointLabelSchema, pointPrompt } from "../server/point-schema";

test("accepts short visible labels, including ones joined by ZWJ or ZWNJ", () => {
  assert.equal(pointLabelSchema.safeParse("Export button").success, true);
  assert.equal(pointLabelSchema.safeParse("Exportér ✓ button").success, true);
  const zwjEmojiLabel = "Save 👩" + "\u200D" + "💻 button";
  assert.equal(pointLabelSchema.safeParse(zwjEmojiLabel).success, true);
  const persianZwnjLabel = "می" + "\u200C" + "خواهم";
  assert.equal(pointLabelSchema.safeParse(persianZwnjLabel).success, true);
});

test("rejects multi-line labels, line/paragraph separators, bidi overrides and over-long labels", () => {
  assert.equal(pointLabelSchema.safeParse("a\nb").success, false);
  assert.equal(pointLabelSchema.safeParse("\u2028").success, false);
  assert.equal(pointLabelSchema.safeParse("\u2029").success, false);
  assert.equal(pointLabelSchema.safeParse("a".repeat(61)).success, false);

  const bidiOverride = pointLabelSchema.safeParse("\u202E");
  assert.equal(bidiOverride.success, false);
  if (!bidiOverride.success)
    assert.equal(
      bidiOverride.error.issues[0].message,
      "Use a single-line label without control or invisible formatting characters",
    );
});

test("rejects labels that would leave the approval prompt with no visible target", () => {
  const invisibleOnlyLabels = [
    "\u200D", // ZWJ alone
    "\u3164", // Hangul filler alone
    "\u2800", // Braille pattern blank alone
    "\u0301", // combining acute accent alone, no base letter
  ];
  for (const label of invisibleOnlyLabels) {
    const parsed = pointLabelSchema.safeParse(label);
    assert.equal(parsed.success, false, `expected ${label} to be rejected`);
    if (!parsed.success)
      assert.equal(
        parsed.error.issues[0].message,
        "Use a label with visible text",
      );
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
