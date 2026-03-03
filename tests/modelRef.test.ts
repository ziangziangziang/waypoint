import test from "node:test";
import assert from "node:assert/strict";
import { parseModelRef } from "../cli/modelRef.ts";

test("parseModelRef parses provider/model format", () => {
  const parsed = parseModelRef("pcai/gpt-4o");
  assert.equal(parsed.providerId, "pcai");
  assert.equal(parsed.modelId, "gpt-4o");
  assert.equal(parsed.canonical, "pcai/gpt-4o");
});

test("parseModelRef leaves model-only refs unchanged", () => {
  const parsed = parseModelRef("gpt-4o");
  assert.equal(parsed.providerId, undefined);
  assert.equal(parsed.modelId, "gpt-4o");
  assert.equal(parsed.canonical, undefined);
});

test("parseModelRef treats malformed refs as model-only", () => {
  const parsed = parseModelRef("pcai/");
  assert.equal(parsed.providerId, undefined);
  assert.equal(parsed.modelId, "pcai/");
});
