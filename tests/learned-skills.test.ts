import { test } from "node:test";
import assert from "node:assert/strict";
import { learnedSkillCatalog } from "../server/learned-skills";

test("the learned-skill catalog names the kite tools the agent can call", () => {
  const text = learnedSkillCatalog([
    { name: "zeta-report", description: "Send the weekly report" },
    {
      name: "gmail-spam-triage",
      description: "Label a Gmail message as spam or not spam",
    },
  ]);
  assert.match(text, /load_learned_skill/);
  assert.match(text, /read_learned_skill_file/);
  // The SDK's formatSkillCatalog names tools this app does not have.
  assert.doesNotMatch(text, /copilotkit_load_skill|copilotkit_read_skill_file/);
  assert.ok(
    text.indexOf("gmail-spam-triage") < text.indexOf("zeta-report"),
    "skills are listed in name order",
  );
  assert.match(text, /Label a Gmail message as spam or not spam/);
});

test("an empty learned-skill catalog says there are none", () => {
  const text = learnedSkillCatalog([]);
  assert.match(text, /No learned skills are available yet\./);
  assert.doesNotMatch(text, /load_learned_skill/);
});
