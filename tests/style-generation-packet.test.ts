import { describe, expect, it } from "vitest";

import { StyleError } from "../src/lib/style/errors";
import {
  compileStyleGenerationPacket,
  StyleGenerationPacketSchema,
} from "../src/lib/style/generation-packet";
import { createEmptyPrompt } from "../src/lib/style/prompt-schema";

const STYLE_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_VERSION_ID = "22222222-2222-4222-8222-222222222222";
const REFERENCE_ONE = "33333333-3333-4333-8333-333333333333";
const REFERENCE_TWO = "44444444-4444-4444-8444-444444444444";

function styleSchema() {
  const schema = createEmptyPrompt("Ink locked");
  schema.artistic_style.medium = "black India ink";
  schema.artistic_style.rendering_style = "precise cross-hatching";
  schema.lighting.light_quality = "hard directional light";
  schema.negative_prompt.avoid_styles = ["watercolor wash"];
  return schema;
}

function compile(overrides: Record<string, unknown> = {}) {
  return compileStyleGenerationPacket({
    styleId: STYLE_ID,
    styleRevision: "2026-09-09T08:00:00.000Z",
    schema: styleSchema(),
    originalPrompt: "A fox reading beside a window",
    contentOverrides: {
      environment: { time_of_day: "midnight" },
    },
    references: [
      { id: REFERENCE_TWO, content_hash: "hash-two" },
      { id: REFERENCE_ONE, content_hash: "hash-one" },
    ],
    operation: "text_to_image",
    sourceVersionId: null,
    sourcePacket: null,
    editTarget: null,
    model: "openai/gpt-image-2",
    size: "1024x1024",
    quality: "high",
    count: 2,
    ...overrides,
  });
}

describe("style generation packet", () => {
  it("compiles the same request deterministically into a valid v1 packet", () => {
    const first = compile();
    const second = compile();

    expect(first).toEqual(second);
    expect(StyleGenerationPacketSchema.parse(first)).toEqual(first);
    expect(first.effective_content.subject.main_subject).toBe("A fox reading beside a window");
    expect(first.compiled_prompt).toContain("STYLE\n");
    expect(first.compiled_prompt).toContain("\n\nCONTENT\n");
    expect(first.compiled_prompt).toContain("\n\nREFERENCES\n");
  });

  it("accepts typed subject overrides without allowing style rules to be replaced", () => {
    const packet = compile({
      contentOverrides: {
        composition: { framing: "tight portrait" },
      },
    });

    expect(packet.effective_content.composition.framing).toBe("tight portrait");
    expect(packet.schema_snapshot.artistic_style.medium).toBe("black India ink");
    expect(packet.compiled_prompt).toContain("artistic_style.medium: black India ink");
    expect(packet.compiled_prompt).toContain("negative_prompt: watercolor wash");

    expect(() => compile({
      contentOverrides: {
        artistic_style: { medium: "watercolor" },
      },
    })).toThrowError(expect.objectContaining({ code: "STYLE_CONFLICT" }));

    expect(() => compile({
      contentOverrides: {
        subject: { invented_field: "not in PromptSchema" },
      },
    })).toThrowError(expect.objectContaining({ code: "STYLE_CONFLICT" }));
  });

  it("preserves the selected reference order in the snapshot and renderer", () => {
    const packet = compile();

    expect(packet.reference_snapshot).toEqual([
      { id: REFERENCE_TWO, content_hash: "hash-two" },
      { id: REFERENCE_ONE, content_hash: "hash-one" },
    ]);
    expect(packet.compiled_prompt.indexOf(REFERENCE_TWO)).toBeLessThan(
      packet.compiled_prompt.indexOf(REFERENCE_ONE),
    );
  });

  it("rejects an over-limit prompt instead of truncating it", () => {
    expect(() => compile({ originalPrompt: "x".repeat(8001) })).toThrowError(
      expect.objectContaining({ code: "PROMPT_TOO_LONG", status: 400 }),
    );
  });

  it("uses the source packet snapshot for inpaint even after the group changes", () => {
    const sourcePacket = compile({
      sourceVersionId: SOURCE_VERSION_ID,
      references: [{ id: REFERENCE_ONE, content_hash: "source-hash" }],
    });
    const changedGroupSchema = styleSchema();
    changedGroupSchema.artistic_style.medium = "oil paint from a later revision";

    const inpaint = compileStyleGenerationPacket({
      styleId: STYLE_ID,
      styleRevision: "2026-09-09T12:00:00.000Z",
      schema: changedGroupSchema,
      originalPrompt: "replace the book with a folded map",
      references: [{ id: REFERENCE_ONE, content_hash: "source-hash" }],
      operation: "inpaint",
      sourceVersionId: SOURCE_VERSION_ID,
      sourcePacket,
      editTarget: "subject.subject_details",
      model: "openai/gpt-image-2",
      size: "1024x1024",
      quality: "high",
      count: 1,
    });

    expect(inpaint.style_revision).toBe(sourcePacket.style_revision);
    expect(inpaint.schema_snapshot).toEqual(sourcePacket.schema_snapshot);
    expect(inpaint.schema_snapshot.artistic_style.medium).toBe("black India ink");
    expect(inpaint.effective_content.subject.main_subject).toBe(sourcePacket.original_prompt);
    expect(inpaint.effective_content.subject.subject_details).toBe("replace the book with a folded map");
    expect(inpaint.edit).toEqual({
      target: "subject.subject_details",
      instruction: "replace the book with a folded map",
    });
    // An edit belongs to the image it came from: the references recorded with
    // that image survive even when a different set is requested.
    expect(inpaint.reference_snapshot).toEqual([
      { id: REFERENCE_ONE, content_hash: "source-hash" },
    ]);
    expect(inpaint.compiled_prompt).toContain("\n\nEDIT\nsubject.subject_details: replace the book with a folded map");
    expect(inpaint.compiled_prompt).not.toContain("oil paint from a later revision");
  });

  it("rejects an edit that requests references other than the recorded ones", () => {
    const sourcePacket = compile({
      sourceVersionId: SOURCE_VERSION_ID,
      references: [{ id: REFERENCE_ONE, content_hash: "source-hash" }],
    });

    expect(() => compileStyleGenerationPacket({
      styleId: STYLE_ID,
      styleRevision: "2026-09-09T12:00:00.000Z",
      schema: styleSchema(),
      originalPrompt: "swap the cup for a vase",
      references: [{ id: REFERENCE_TWO, content_hash: "other" }],
      operation: "inpaint",
      sourceVersionId: SOURCE_VERSION_ID,
      sourcePacket,
      editTarget: "subject.subject_object.object_state",
      model: "openai/gpt-image-2",
      size: "1024x1024",
      quality: "high",
      count: 1,
    })).toThrowError(expect.objectContaining({ code: "STYLE_CONFLICT" }));
  });

  it("keeps the analysed reference subject out of a brand new image", () => {
    const schema = styleSchema();
    schema.subject.main_subject = "clay cat figurine";
    schema.environment.setting = "wooden shelf";

    const packet = compileStyleGenerationPacket({
      styleId: STYLE_ID,
      styleRevision: "2026-09-09T08:00:00.000Z",
      schema,
      originalPrompt: "a small delivery truck",
      references: [{ id: REFERENCE_ONE, content_hash: "hash-one" }],
      operation: "text_to_image",
      sourceVersionId: null,
      sourcePacket: null,
      editTarget: null,
      model: "openai/gpt-image-2",
      size: "1024x1024",
      quality: "high",
      count: 1,
    });

    expect(packet.effective_content.subject.main_subject).toBe("a small delivery truck");
    expect(packet.compiled_prompt).toContain("subject.main_subject: a small delivery truck");
    expect(packet.compiled_prompt).not.toContain("clay cat figurine");
    expect(packet.compiled_prompt).not.toContain("wooden shelf");
    expect(packet.compiled_prompt).toContain("artistic_style.medium: black India ink");
  });

  it("rejects inpaint missing a source packet unless useCurrentStyle=true", () => {
    const changedSchema = styleSchema();
    changedSchema.artistic_style.medium = "oil paint (current revision)";
    const base = {
      styleId: STYLE_ID,
      styleRevision: "2026-09-09T12:00:00.000Z",
      schema: changedSchema,
      originalPrompt: "replace the book with a folded map",
      references: [{ id: REFERENCE_TWO, content_hash: "selected-for-inpaint" }],
      operation: "inpaint" as const,
      sourceVersionId: SOURCE_VERSION_ID,
      sourcePacket: null,
      editTarget: "subject.subject_details",
      model: "openai/gpt-image-2" as const,
      size: "1024x1024" as const,
      quality: "high" as const,
      count: 1 as const,
    };

    expect(() => compileStyleGenerationPacket(base)).toThrowError(
      expect.objectContaining({ code: "STYLE_SOURCE_SNAPSHOT_REQUIRED" }),
    );

    const fallback = compileStyleGenerationPacket({ ...base, useCurrentStyle: true });
    expect(fallback.schema_snapshot.artistic_style.medium).toBe("oil paint (current revision)");
    expect(fallback.original_prompt).toBe("");
    expect(fallback.metadata?.style_provenance).toBe("current_style_fallback");

    const withOriginal = compileStyleGenerationPacket({
      ...base,
      useCurrentStyle: true,
      sourceOriginalPrompt: "A fox reading beside a window",
    });
    expect(withOriginal.original_prompt).toBe("A fox reading beside a window");
    expect(withOriginal.metadata?.style_provenance).toBe("current_style_fallback");
  });

  it("requires explicit adoption when the source packet has no reference snapshot", () => {
    const legacySchema = styleSchema();
    const legacy = StyleGenerationPacketSchema.parse({
      ...compile(),
      reference_snapshot: [],
    });
    const base = {
      styleId: STYLE_ID,
      styleRevision: "2026-09-09T12:00:00.000Z",
      schema: legacySchema,
      originalPrompt: "brighten the window",
      references: [{ id: REFERENCE_ONE, content_hash: "hash-one" }],
      operation: "inpaint" as const,
      sourceVersionId: SOURCE_VERSION_ID,
      sourcePacket: legacy,
      editTarget: "subject.subject_details",
      model: "openai/gpt-image-2" as const,
      size: "1024x1024" as const,
      quality: "high" as const,
      count: 1 as const,
    };

    expect(() => compileStyleGenerationPacket(base)).toThrowError(
      expect.objectContaining({ code: "STYLE_SOURCE_SNAPSHOT_REQUIRED" }),
    );
    const adopted = compileStyleGenerationPacket({ ...base, useCurrentStyle: true });
    expect(adopted.metadata?.style_provenance).toBe("current_style_fallback");
    expect(adopted.reference_snapshot).toEqual([{ id: REFERENCE_ONE, content_hash: "hash-one" }]);
    expect(adopted.schema_snapshot.artistic_style.medium).toBe("black India ink");
  });

  it("rejects an invalid source packet instead of falling back silently", () => {
    expect(() => compileStyleGenerationPacket({
      styleId: STYLE_ID,
      styleRevision: "2026-09-09T12:00:00.000Z",
      schema: styleSchema(),
      originalPrompt: "shift the light",
      references: [{ id: REFERENCE_ONE, content_hash: "h" }],
      operation: "inpaint",
      sourceVersionId: SOURCE_VERSION_ID,
      sourcePacket: { not: "a valid packet" } as never,
      editTarget: "subject.subject_details",
      model: "openai/gpt-image-2",
      size: "1024x1024",
      quality: "high",
      count: 1,
    })).toThrow();
  });
});
