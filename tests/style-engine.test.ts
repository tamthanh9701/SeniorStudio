import { describe, expect, it } from "vitest";
import { buildStyleGenerationPrompt, createEmptyPrompt, getGroupCategory, negativePromptToText, toStringArray, type PromptSchema } from "../src/lib/style/prompt-schema";
import { normalizePromptSchema } from "../src/lib/style/normalize-prompt-schema";
import { lintAndFixStyleSchema } from "../src/lib/style/linter";
import { buildStyleFingerprint, styleFingerprintToPrompt } from "../src/lib/style/fingerprint";
import { buildStyleInvariantContract } from "../src/lib/style/invariant-contract";
import { preprocessReferences } from "../src/lib/style/reference-preprocess";

const onePixelPng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlS8AAAAASUVORK5CYII=", "base64");

describe("normalizePromptSchema", () => {
  it("passes a well-formed schema through unchanged in shape", () => {
    const schema = createEmptyPrompt("Test");
    const normalized = normalizePromptSchema(schema) as PromptSchema;
    expect(normalized.style_name).toBe("Test");
    expect(normalized.negative_prompt.avoid_elements).toEqual([]);
  });

  it("coerces string dominant_colors into an array", () => {
    const normalized = normalizePromptSchema({ color_palette: { dominant_colors: "red, blue" } }) as Record<string, { dominant_colors: string[] }>;
    expect(normalized.color_palette.dominant_colors).toEqual(["red", "blue"]);
  });

  it("coerces string avoid_* fields and keeps non-objects untouched", () => {
    const normalized = normalizePromptSchema({ negative_prompt: { avoid_elements: "trees, people" } }) as { negative_prompt: { avoid_elements: string[] } };
    expect(normalized.negative_prompt.avoid_elements).toEqual(["trees", "people"]);
    expect(normalizePromptSchema("not an object")).toBe("not an object");
    expect(normalizePromptSchema(null)).toBe(null);
  });
});

describe("lintAndFixStyleSchema", () => {
  it("fixes transparent-background conflict language when references have alpha", () => {
    const summary = { hasAnyAlpha: true, dominantAssetFormat: "transparent_sticker", dominantColors: [], qualityReport: { hasLowResolutionReferences: false, lowResolutionCount: 0, tinyIconSourceCount: 0, pixelArtAmbiguity: "unknown", likelyArtifacts: [], recommendedPolicy: {}, warnings: [] } } as never;
    const result = lintAndFixStyleSchema({ environment: { setting: "dark cafe interior" } }, { referenceSummary: summary });
    expect(String((result.schema as Record<string, Record<string, unknown>>).environment.setting)).toContain("transparent");
    expect(result.issues.some((issue) => issue.type === "conflict")).toBe(true);
  });

  it("autofixes missing palette with reference hex colors", () => {
    const summary = { dominantColors: ["#FF00AA"], hasAnyAlpha: false, dominantAssetFormat: "isolated_asset", qualityReport: { hasLowResolutionReferences: false } } as never;
    const result = lintAndFixStyleSchema({ color_palette: { dominant_colors: "vague wording" } }, { referenceSummary: summary });
    expect((result.schema as Record<string, Record<string, unknown>>).color_palette.dominant_colors).toEqual(["#FF00AA"]);
    expect(result.issues.some((issue) => issue.type === "autofix")).toBe(true);
  });

  it("returns non-record input untouched with a fallback fingerprint", () => {
    const result = lintAndFixStyleSchema("junk");
    expect(result.schema).toBe("junk");
    expect(result.fingerprint.version).toBe("1.0");
  });
});

describe("buildStyleGenerationPrompt", () => {
  it("renders a full capsule with all sections", () => {
    const schema = createEmptyPrompt("Ink Botany");
    schema.artistic_style.medium = "pen and ink";
    schema.color_palette.dominant_colors = ["#112233", "#445566"];
    schema.lighting.primary_light_source = "soft window light";
    const capsule = buildStyleGenerationPrompt(schema);
    expect(capsule).toContain("Style capsule: Ink Botany");
    expect(capsule).toContain("Rendering: pen and ink");
    expect(capsule).toContain("Palette: #112233, #445566");
    expect(capsule).toContain("Lighting: soft window light");
  });

  it("never leaks subject fields into the capsule", () => {
    const schema = createEmptyPrompt("Leak Test");
    schema.subject.main_subject = "a ceramic teapot with dragon engraving";
    schema.environment.setting = "misty forest";
    schema.subject_character!.hair_style = "long braids";
    const capsule = buildStyleGenerationPrompt(schema);
    expect(capsule).not.toContain("teapot");
    expect(capsule).not.toContain("forest");
    expect(capsule).not.toContain("braids");
  });

  it("respects maxChars truncation (upstream appends ellipsis after word clip)", () => {
    const schema = createEmptyPrompt("Long Style");
    schema.artistic_style.rendering_style = "x".repeat(4000);
    const capsule = buildStyleGenerationPrompt(schema, 1800);
    expect(capsule.length).toBeLessThanOrEqual(1803); // 1799 clipped + "..."
    expect(capsule.endsWith("...")).toBe(true);
  });

  it("falls back for null or malformed schema", () => {
    expect(buildStyleGenerationPrompt(null)).toBe("Coherent reusable visual style.");
    expect(buildStyleGenerationPrompt(undefined, 500)).toBe("Coherent reusable visual style.");
  });
});

describe("buildStyleFingerprint", () => {
  const baseSummary = { dominantColors: [], hasAnyAlpha: false, dominantAssetFormat: "unknown" };

  it("is deterministic for the same schema and summary family", () => {
    const schema = createEmptyPrompt("Fam");
    schema.artistic_style.style_reference = "risograph print";
    const one = buildStyleFingerprint(schema, baseSummary as never);
    const two = buildStyleFingerprint(schema, baseSummary as never);
    expect(one).toEqual(two);
    expect(one.style_family).toBe("risograph print");
  });

  it("marks transparent sticker references", () => {
    const fingerprint = buildStyleFingerprint(null, { ...baseSummary, hasAnyAlpha: true, dominantAssetFormat: "transparent_sticker" } as never);
    expect(fingerprint.composition_grammar.format).toBe("compact_isolated_sticker");
    expect(fingerprint.background_policy.type).toBe("transparent_or_plain_light");
  });

  it("handles missing data gracefully", () => {
    const fingerprint = buildStyleFingerprint(null, null);
    expect(fingerprint.palette_system.mode).toBe("tritone"); // paletteMode(3) default
    expect(styleFingerprintToPrompt(fingerprint)).toContain("Style format:");
  });
});

describe("buildStyleInvariantContract", () => {
  it("produces sticker family rules for transparent references", () => {
    const summary = { hasAnyAlpha: true, dominantAssetFormat: "transparent_sticker", dominantColors: ["#FF00AA"], qualityReport: { hasLowResolutionReferences: false } } as never;
    const lint = lintAndFixStyleSchema(createEmptyPrompt("Sticker"), { referenceSummary: summary });
    const contract = buildStyleInvariantContract({ schema: lint.schema, fingerprint: lint.fingerprint, referenceSummary: summary });
    expect(contract.visual_family_id).toBe("transparent_sticker_icon");
    expect(contract.must_match.length).toBeGreaterThan(0);
    expect(contract.fill_system.fill_type).toBe("flat_matte_pastel");
  });

  it("falls back to unknown family with generic invariants", () => {
    const contract = buildStyleInvariantContract({ schema: {}, fingerprint: null, referenceSummary: null });
    expect(contract.visual_family_id).toBe("unknown");
    expect(contract.must_match.length).toBeGreaterThan(0);
  });
});

describe("preprocessReferences", () => {
  it("parses a valid PNG buffer and reports stats", async () => {
    const summary = await preprocessReferences([{ id: "ref-1", buffer: onePixelPng, mimeType: "image/png" }]);
    expect(summary.total).toBe(1);
    expect(summary.ok).toBe(1);
    expect(summary.stats[0]).toMatchObject({ id: "ref-1", width: 1, height: 1, mimeType: "image/png" });
  });

  it("degrades corrupt bytes to ok-with-null-dimensions without throwing (upstream parse-degrade contract)", async () => {
    const summary = await preprocessReferences([{ id: "bad", buffer: Buffer.from([0x00, 0x01, 0x02]), mimeType: "image/png" }]);
    expect(summary.stats[0].ok).toBe(true);
    expect(summary.stats[0].width).toBeNull();
    expect(summary.hasAnyAlpha).toBe(false);
  });

  it("accepts buffers only — the API has no URL path", async () => {
    // Signature-level SSRF guard: ReferenceInput carries { id, buffer, mimeType }.
    const summary = await preprocessReferences([
      { id: "a", buffer: onePixelPng, mimeType: "image/png" },
      { id: "b", buffer: Buffer.from("not an image"), mimeType: "image/jpeg" },
    ]);
    expect(summary.total).toBe(2);
    expect(summary.stats.every((stat) => !("source" in stat))).toBe(true);
  });
});

describe("group helpers", () => {
  it("classifies groups and coerces negative prompts", () => {
    expect(getGroupCategory("artistic_style")).toBe("style");
    expect(getGroupCategory("subject")).toBe("subject");
    expect(getGroupCategory("style_name")).toBe("meta");
    expect(toStringArray("a, b")).toEqual(["a", "b"]);
    expect(negativePromptToText({ avoid_elements: "x", avoid_styles: ["y"] })).toBe("x, y");
  });
});
