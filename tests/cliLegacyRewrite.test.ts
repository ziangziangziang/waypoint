import test from "node:test";
import assert from "node:assert/strict";
import { rewriteLegacyArgv } from "../cli/legacyRewrite.ts";

test("rewrites provider model ls to models <provider>", () => {
  const result = rewriteLegacyArgv(["provider", "model", "ls", "pcai"]);
  assert.equal(result.legacyUsed, true);
  assert.deepEqual(result.argv, ["models", "pcai"]);
  assert.equal(result.ruleId, "provider-model-list");
});

test("rewrites provider models to models <provider>", () => {
  const result = rewriteLegacyArgv(["provider", "models", "pcai"]);
  assert.equal(result.legacyUsed, true);
  assert.deepEqual(result.argv, ["models", "pcai"]);
  assert.equal(result.ruleId, "provider-models-list");
});

test("rewrites provider model show to models show provider/model", () => {
  const result = rewriteLegacyArgv(["provider", "model", "show", "pcai", "gpt-4o"]);
  assert.equal(result.legacyUsed, true);
  assert.deepEqual(result.argv, ["models", "show", "pcai/gpt-4o"]);
  assert.equal(result.ruleId, "provider-model-show");
});

test("rewrites provider model set-key to models set-key provider/model", () => {
  const result = rewriteLegacyArgv([
    "provider",
    "model",
    "set-key",
    "pcai",
    "gpt-4o",
    "--env-var",
    "PCAI_KEY",
  ]);
  assert.equal(result.legacyUsed, true);
  assert.deepEqual(result.argv, ["models", "set-key", "pcai/gpt-4o", "--env-var", "PCAI_KEY"]);
  assert.equal(result.ruleId, "provider-model-set-key");
});

test("leaves canonical commands unchanged", () => {
  const result = rewriteLegacyArgv(["models", "pcai"]);
  assert.equal(result.legacyUsed, false);
  assert.deepEqual(result.argv, ["models", "pcai"]);
});
