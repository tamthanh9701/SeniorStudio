import { describe, expect, it } from "vitest";
import { normalizeStyleClarificationAnswers } from "../src/lib/style/clarification-answers";

describe("style clarification validation", () => {
  it("rejects selected_option not in question.options for single_choice", () => {
    const questions = {
      version: "style_clarification_questions_v1" as const,
      status: "needs_user_confirmation" as const,
      recommended_next_action: "can_generate_but_user_confirmation_improves_schema" as const,
      questions: [
        {
          id: "color_priority",
          axis: "color_palette" as const,
          priority: "recommended" as const,
          type: "single_choice" as const,
          question: "Which color palette mode?",
          help_text: "",
          options: ["monochromatic", "analogous", "complementary"],
          default_answer: null,
          schema_target: ["color_palette", "mode"],
          reason: "test",
        },
      ],
    };

    const rawAnswers = [
      { question_id: "color_priority", selected_option: "triadic" },
    ];

    const result = normalizeStyleClarificationAnswers({ questions, rawAnswers });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("color_priority"))).toBe(true);
  });

  it("rejects duplicate/unknown question IDs", () => {
    const questions = {
      version: "style_clarification_questions_v1" as const,
      status: "needs_user_confirmation" as const,
      recommended_next_action: "can_generate_but_user_confirmation_improves_schema" as const,
      questions: [
        {
          id: "known_question",
          axis: "color_palette" as const,
          priority: "required" as const,
          type: "single_choice" as const,
          question: "Lighting type?",
          help_text: "",
          options: ["natural", "artificial"],
          default_answer: null,
          schema_target: ["lighting", "type"],
          reason: "test",
        },
      ],
    };

    const rawAnswers = [
      { question_id: "known_question", selected_option: "natural" },
      { question_id: "unknown_question", selected_option: "something" },
    ];

    const result = normalizeStyleClarificationAnswers({ questions, rawAnswers });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("Unknown question_id: unknown_question"))).toBe(true);
  });

  it("accepts valid selected_option in options array", () => {
    const questions = {
      version: "style_clarification_questions_v1" as const,
      status: "needs_user_confirmation" as const,
      recommended_next_action: "can_generate_but_user_confirmation_improves_schema" as const,
      questions: [
        {
          id: "color_priority",
          axis: "color_palette" as const,
          priority: "recommended" as const,
          type: "single_choice" as const,
          question: "Which color palette mode?",
          help_text: "",
          options: ["monochromatic", "analogous", "complementary"],
          default_answer: null,
          schema_target: ["color_palette", "mode"],
          reason: "test",
        },
      ],
    };

    const rawAnswers = [
      { question_id: "color_priority", selected_option: "analogous" },
    ];

    const result = normalizeStyleClarificationAnswers({ questions, rawAnswers });
    expect(result.ok).toBe(true);
    expect(result.answers).toHaveLength(1);
    expect(result.answers[0].selected_option).toBe("analogous");
  });

  it("accepts custom_text for single_choice with no options", () => {
    const questions = {
      version: "style_clarification_questions_v1" as const,
      status: "needs_user_confirmation" as const,
      recommended_next_action: "can_generate_but_user_confirmation_improves_schema" as const,
      questions: [
        {
          id: "custom_style",
          axis: "color_palette" as const,
          priority: "optional" as const,
          type: "single_choice" as const,
          question: "Describe the custom style",
          help_text: "",
          options: undefined,
          default_answer: null,
          schema_target: ["artistic_style", "medium"],
          reason: "test",
        },
      ],
    };

    const rawAnswers = [
      { question_id: "custom_style", custom_text: "watercolor with ink wash" },
    ];

    const result = normalizeStyleClarificationAnswers({ questions, rawAnswers });
    expect(result.ok).toBe(true);
    expect(result.answers[0].custom_text).toBe("watercolor with ink wash");
  });
});
