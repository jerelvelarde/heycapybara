import { test } from "node:test";
import assert from "node:assert/strict";
import { runtimeConfig } from "../server/config";
import { authorized } from "../server/auth";
test("learning container remains stable and invalid IDs fail early", () => {
  assert.equal(runtimeConfig({}).containerId, "desktop-workflows");
  assert.throws(
    () => runtimeConfig({ CPK_INTELLIGENCE_LEARNING_CONTAINER_ID: "../other" }),
    /container/,
  );
  assert.equal(runtimeConfig({ OPENAI_API_KEY: "test" }).modelConfigured, true);
  assert.equal(
    runtimeConfig({
      OPENAI_API_KEY: "test",
      KITE_MODEL: "anthropic/claude-sonnet-4-5",
    }).modelConfigured,
    false,
  );
});
test("runtime rejects missing or wrong token and foreign origins", () => {
  const token = "abc";
  const req = (auth: string, origin?: string) =>
    new Request("http://127.0.0.1/api", {
      headers: { authorization: auth, ...(origin ? { origin } : {}) },
    });
  assert.equal(authorized(req(""), token), false);
  assert.equal(authorized(req("Bearer wrong"), token), false);
  assert.equal(
    authorized(req("Bearer abc", "https://evil.example"), token),
    false,
  );
  assert.equal(authorized(req("Bearer abc", "null"), token), true);
  assert.equal(
    authorized(req("Bearer abc", "http://127.0.0.1:5173"), token),
    true,
  );
});
