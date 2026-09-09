import { describe, expect, it } from "vitest";
import { buildStyleClarificationQuestions } from "../src/lib/style/clarification-questions";
import { normalizeStyleClarificationAnswers } from "../src/lib/style/clarification-answers";
import { applyStyleSchemaPatch } from "../src/lib/style/schema-patch";
import { scoreStyleOperability } from "../src/lib/style/operability-scorer";
import { evaluateStyleFidelity } from "../src/lib/style/fidelity-evaluator";
import { getReferenceLimit, getStyleBudget } from "../src/lib/style/cost-modes";

const FLAT_CONTRACT = {
  version: "1.0" as const,
  visual_family: "Flat vector icon",
  visual_family_id: "flat_vector_icon" as const,
  must_match: [], should_match: [], optional_elements: [], forbidden_elements: [],
  outline_system: { primary_outline_color: "#000000", stroke_weight: "thick" as const, stroke_shape: "round", line_consistency: "clean", forbidden: [] },
  fill_system: { fill_type: "flat_matte_pastel" as const, allowed_shading: [], forbidden_shading: [] },
  texture_system: { pattern_type: "none", density: "none" as const, placement_rule: "none" },
  composition_system: { layout: "centered", background_policy: "transparent", object_scale: "large" },
  content_to_ignore: [], evidence_notes: [], confidence: 0.9,
};

describe("style interactive features", () => {
  it("asks about outline role for flat icon styles", () => {
    const result = buildStyleClarificationQuestions({ schema: { style_name: "Icon", artistic_style: { medium: "vector" } }, contract: FLAT_CONTRACT });
    expect(result.questions.some((question) => question.id === "confirm_outline_role")).toBe(true);
  });

  it("reports unanswered required clarification questions", () => {
    const questions = buildStyleClarificationQuestions({ schema: {}, contract: FLAT_CONTRACT });
    const result = normalizeStyleClarificationAnswers({ questions, rawAnswers: [] });
    expect(result.ok).toBe(false);
    expect(result.missing_required_question_ids.length).toBeGreaterThan(0);
  });

  it("applies an allowed set patch", () => {
    const schema = applyStyleSchemaPatch({ lighting: { light_quality: "soft" } }, [{ op: "set", path: "lighting.light_quality", value: "hard", reason: "test", source_question_ids: [], confidence: 1 }]);
    expect(schema.lighting.light_quality).toBe("hard");
  });

  it("marks an empty schema not ready", () => {
    const result = scoreStyleOperability({ promptSchema: {} });
    expect(result.grade).toBe("not_ready");
    expect(result.score).toBeLessThan(50);
  });

  it("marks a complete schema production ready", () => {
    const result = scoreStyleOperability({ promptSchema: {
      style_name: "Production Icon", subject_type: "object",
      color_palette: { dominant_colors: ["#111111", "#222222", "#333333"] },
      artistic_style: { rendering_style: "crisp flat vector" },
      negative_prompt: { avoid_artifacts: ["blur"] },
      composition: { framing: "centered" },
    }, referenceSummary: { hasAnyAlpha: true, dominantAssetFormat: "transparent_sticker", qualityReport: { hasLowResolutionReferences: false, pixelArtAmbiguity: "unknown" } } });
    expect(result.grade).toBe("production_ready");
    expect(result.score).toBeGreaterThanOrEqual(85);
  });

  it("uses deterministic neutral fidelity defaults", () => {
    const result = evaluateStyleFidelity({});
    expect(result.style_fidelity).toBe(0.77);
  });

  it("exposes cost mode budgets", () => {
    expect(getStyleBudget("strict_style")).toBe(2800);
    expect(getReferenceLimit("balanced")).toBe(2);
  });
});
