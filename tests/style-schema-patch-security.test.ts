import { describe, expect, it } from "vitest";
import { applyStyleSchemaPatch, validateStyleSchemaPatch } from "../src/lib/style/schema-patch";

describe("schema patch security", () => {
  it("rejects __proto__ in path", () => {
    expect(() =>
      applyStyleSchemaPatch(
        {},
        [{ op: "set", path: "lighting.__proto__.polluted", value: true, reason: "test", source_question_ids: [], confidence: 1 }]
      )
    ).toThrow();
  });

  it("rejects prototype in path", () => {
    expect(() =>
      applyStyleSchemaPatch(
        {},
        [{ op: "set", path: "lighting.prototype.polluted", value: true, reason: "test", source_question_ids: [], confidence: 1 }]
      )
    ).toThrow();
  });

  it("rejects constructor in path", () => {
    expect(() =>
      applyStyleSchemaPatch(
        {},
        [{ op: "set", path: "lighting.constructor.polluted", value: true, reason: "test", source_question_ids: [], confidence: 1 }]
      )
    ).toThrow();
  });

  it("remove with value filters array items", () => {
    const schema = { negative_prompt: { avoid_quality: ["High resolution", "blur"] } };
    const result = applyStyleSchemaPatch(schema, [
      { op: "remove", path: "negative_prompt.avoid_quality", value: ["High resolution"], reason: "test", source_question_ids: [], confidence: 1 },
    ]);
    const patched = result as Record<string, unknown>;
    const negativePrompt = patched.negative_prompt as Record<string, unknown>;
    expect(negativePrompt.avoid_quality).toEqual(["blur"]);
  });

  it("remove without value deletes entire field", () => {
    const schema = { negative_prompt: { avoid_quality: ["High resolution"] } };
    const result = applyStyleSchemaPatch(schema, [
      { op: "remove", path: "negative_prompt.avoid_quality", reason: "test", source_question_ids: [], confidence: 1 },
    ]);
    const patched = result as Record<string, unknown>;
    const negativePrompt = patched.negative_prompt as Record<string, unknown>;
    expect(negativePrompt.avoid_quality).toBeUndefined();
  });

  it("validate rejects blocked segments", () => {
    const result = validateStyleSchemaPatch([
      { op: "set", path: "__proto__.x", value: 1, reason: "test", source_question_ids: [], confidence: 1 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("__proto__");
  });
});
