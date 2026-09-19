// Structural guarantees for the Game UI contracts: the element map is what an
// export crops, so an inconsistent parent chain or an off-image box must fail
// before anything is stored, not at crop time.
import { describe, expect, it } from "vitest";

import {
  MAX_DOCUMENT_BYTES,
  elementGraphProblems,
  parseElementDocument,
  parseScreenSpec,
  type ElementDocument,
  type GameUiElement,
} from "@/lib/game-ui/contracts";
import { parseGameUiStyleSchema } from "@/lib/game-ui/style-schema";
import { GameUiError } from "@/lib/game-ui/errors";

const RENDER_ID = "11111111-1111-4111-8111-111111111111";
const SOURCE_VERSION_ID = "22222222-2222-4222-8222-222222222222";
const REQUIREMENT_ID = "33333333-3333-4333-8333-333333333333";

function element(overrides: Partial<GameUiElement> & Pick<GameUiElement, "id" | "kind" | "bounds">): GameUiElement {
  return {
    parent_id: null,
    custom_type: null,
    name: overrides.kind,
    purpose: "",
    visible_text: null,
    visible_state: null,
    z_index: 0,
    occluded: false,
    confidence: null,
    notes: "",
    reviewed: false,
    ...overrides,
  };
}

function document(overrides: Partial<ElementDocument> = {}): ElementDocument {
  return {
    schema_version: 1,
    render_id: RENDER_ID,
    source_version_id: SOURCE_VERSION_ID,
    canvas: { width: 1024, height: 768 },
    elements: [],
    coverage: [],
    ...overrides,
  };
}

const TRACK_ID = "44444444-4444-4444-8444-444444444444";
const FILL_ID = "55555555-5555-4555-8555-555555555555";
const LABEL_ID = "66666666-6666-4666-8666-666666666666";

describe("element documents", () => {
  it("accepts a bar with visible track, fill and label children", () => {
    const parsed = parseElementDocument(
      document({
        elements: [
          element({ id: TRACK_ID, kind: "bar_track", name: "Track", bounds: { x: 0, y: 0, width: 400, height: 40 } }),
          element({
            id: FILL_ID,
            kind: "bar_fill",
            name: "Fill",
            parent_id: TRACK_ID,
            bounds: { x: 4, y: 4, width: 240, height: 32 },
            z_index: 1,
          }),
          element({ id: LABEL_ID, kind: "text", name: "Label", parent_id: TRACK_ID, bounds: { x: 160, y: 10, width: 60, height: 20 }, z_index: 2 }),
        ],
        coverage: [{ requirement_id: REQUIREMENT_ID, element_ids: [TRACK_ID], status: "present", note: "" }],
      }),
    );
    expect(parsed.elements.map((entry) => entry.kind)).toEqual(["bar_track", "bar_fill", "text"]);
    expect(parsed.elements[1].parent_id).toBe(TRACK_ID);
  });

  it("refuses a parent chain that loops", () => {
    const problems = elementGraphProblems(
      document({
        elements: [
          element({ id: TRACK_ID, kind: "panel", bounds: { x: 0, y: 0, width: 100, height: 100 }, parent_id: FILL_ID }),
          element({ id: FILL_ID, kind: "panel", bounds: { x: 0, y: 0, width: 100, height: 100 }, parent_id: TRACK_ID }),
        ],
      }),
    );
    expect(problems.some((problem) => problem.includes("loops"))).toBe(true);
  });

  it("refuses a parent from another document and a parent that does not contain its child", () => {
    const foreignParent = elementGraphProblems(
      document({ elements: [element({ id: FILL_ID, kind: "bar_fill", bounds: { x: 0, y: 0, width: 10, height: 10 }, parent_id: TRACK_ID })] }),
    );
    expect(foreignParent[0]).toContain("not in this document");
    const outside = elementGraphProblems(
      document({
        elements: [
          element({ id: TRACK_ID, kind: "panel", bounds: { x: 0, y: 0, width: 50, height: 50 } }),
          element({ id: FILL_ID, kind: "icon", bounds: { x: 40, y: 0, width: 50, height: 10 }, parent_id: TRACK_ID }),
        ],
      }),
    );
    expect(outside[0]).toContain("does not contain it");
  });

  it("refuses boxes outside the image, zero sizes and unknown kinds", () => {
    expect(() =>
      parseElementDocument(document({ elements: [element({ id: FILL_ID, kind: "icon", bounds: { x: 1000, y: 0, width: 100, height: 10 } })] })),
    ).toThrow(/outside the 1024×768 image/);
    const zero = parseElementDocument(document({ elements: [element({ id: FILL_ID, kind: "icon", bounds: { x: 0, y: 0, width: 1, height: 1 } })] }));
    expect(zero.elements).toHaveLength(1);
    expect(() =>
      parseElementDocument(document({ elements: [{ ...element({ id: FILL_ID, kind: "icon", bounds: { x: 0, y: 0, width: 0, height: 4 } }) }] })),
    ).toThrow(GameUiError);
    expect(() =>
      parseElementDocument(document({ elements: [{ ...element({ id: FILL_ID, kind: "icon", bounds: { x: 0, y: 0, width: 4, height: 4 } }), kind: "banner" as never }] })),
    ).toThrow(GameUiError);
    expect(() =>
      parseElementDocument(document({ elements: [element({ id: FILL_ID, kind: "icon", bounds: { x: 0.5, y: 0, width: 4, height: 4 } })] })),
    ).toThrow(GameUiError);
  });

  it("requires custom_type exactly for custom elements", () => {
    expect(() => parseElementDocument(document({ elements: [element({ id: FILL_ID, kind: "custom", bounds: { x: 0, y: 0, width: 8, height: 8 } })] }))).toThrow(
      /needs custom_type/,
    );
    expect(() =>
      parseElementDocument(document({ elements: [element({ id: FILL_ID, kind: "icon", custom_type: "sigil", bounds: { x: 0, y: 0, width: 8, height: 8 } })] })),
    ).toThrow(/only allowed for kind "custom"/);
    const custom = parseElementDocument(
      document({ elements: [element({ id: FILL_ID, kind: "custom", custom_type: "sigil", bounds: { x: 0, y: 0, width: 8, height: 8 } })] }),
    );
    expect(custom.elements[0].custom_type).toBe("sigil");
  });

  it("refuses duplicate ids, unknown coverage references and a canvas that disagrees with the image", () => {
    expect(() =>
      parseElementDocument(
        document({
          elements: [
            element({ id: FILL_ID, kind: "icon", bounds: { x: 0, y: 0, width: 8, height: 8 } }),
            element({ id: FILL_ID, kind: "icon", bounds: { x: 20, y: 0, width: 8, height: 8 } }),
          ],
        }),
      ),
    ).toThrow(/share the id/);
    expect(() =>
      parseElementDocument(document({ coverage: [{ requirement_id: REQUIREMENT_ID, element_ids: [FILL_ID], status: "present", note: "" }] })),
    ).toThrow(/not in this document/);
    expect(() => parseElementDocument(document(), { width: 512, height: 512 })).toThrow(/does not match the image/);
    expect(() => parseElementDocument({ ...document(), rows: [] })).toThrow(GameUiError);
  });

  it("refuses a document larger than the limit", () => {
    const big = document({
      elements: Array.from({ length: 100 }, (_unused, index) =>
        element({
          id: `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`,
          kind: "panel",
          name: "P".repeat(100),
          bounds: { x: 0, y: 0, width: 4, height: 4 },
          purpose: "p".repeat(1000),
          visible_text: "t".repeat(500),
          visible_state: "s".repeat(200),
          notes: "n".repeat(1000),
        }),
      ),
    });
    expect(new TextEncoder().encode(JSON.stringify(big)).byteLength).toBeGreaterThan(MAX_DOCUMENT_BYTES);
    expect(() => parseElementDocument(big)).toThrow(/limit is/);
  });
});

describe("screen specifications", () => {
  const requirement = { id: REQUIREMENT_ID, kind: "button", custom_type: null, name: "Continue", purpose: "", visible_text: "Continue", visible_state: null, required: true };

  it("accepts a requirement list and defaults required to true", () => {
    const spec = parseScreenSpec({
      schema_version: 1,
      name: "Battle HUD",
      description: "Top bar with avatar and health",
      layout_notes: "",
      requirements: [{ ...requirement, required: undefined }],
    });
    expect(spec.requirements[0].required).toBe(true);
  });

  it("refuses duplicate requirement ids and mismatched custom types", () => {
    expect(() => parseScreenSpec({ schema_version: 1, name: "A", description: "", layout_notes: "", requirements: [requirement, requirement] })).toThrow(/share the id/);
    expect(() =>
      parseScreenSpec({ schema_version: 1, name: "A", description: "", layout_notes: "", requirements: [{ ...requirement, kind: "custom" }] }),
    ).toThrow(/needs custom_type/);
  });
});

describe("game ui style schema", () => {
  const base = {
    schema_version: 1,
    domain: "game_ui",
    name: "Arcane HUD",
    visual_language: "Painted fantasy chrome with gold bevels",
    palette: [{ id: "gold", role: "accent", color: "#d4a24a", notes: "bevel highlight" }],
    typography: [{ role: "button", family_description: "serif with square terminals", weight: "bold", casing: "uppercase", effects: "outer glow" }],
    layout: { density: "balanced", spacing_rules: "", alignment_rules: "", safe_area_rules: "", hierarchy_rules: "" },
    shape: { corner_rules: "8px bevel", border_rules: "", silhouette_rules: "" },
    surface: { materials: "brushed gold", shading: "", shadows: "", highlights: "" },
    iconography: { construction: "solid glyphs with gold outline", stroke_rules: "", detail_level: "" },
    components: [{ kind: "button", appearance: "gold frame with inner gradient", text_rules: "", composition_rules: "" }],
    invariants: ["gold bevel on every frame"],
    avoid: ["flat vector"], 
    uncertainties: [],
  };

  it("accepts a complete schema and parses an invalid color or kind with a field path", () => {
    expect(parseGameUiStyleSchema(base).components[0].kind).toBe("button");
    expect(() => parseGameUiStyleSchema({ ...base, palette: [{ ...base.palette[0], color: "gold" }] })).toThrow(/palette\.0\.color/);
    expect(() => parseGameUiStyleSchema({ ...base, components: [{ ...base.components[0], kind: "banner" }] })).toThrow(/components\.0\.kind/);
  });

  it("refuses duplicate palette ids, duplicate component kinds and an empty invariant list", () => {
    expect(() => parseGameUiStyleSchema({ ...base, palette: [base.palette[0], base.palette[0]] })).toThrow(/duplicate palette ids/);
    expect(() => parseGameUiStyleSchema({ ...base, components: [base.components[0], base.components[0]] })).toThrow(/duplicate components/);
    expect(() => parseGameUiStyleSchema({ ...base, invariants: [] })).toThrow(/invariants/);
    expect(() => parseGameUiStyleSchema({ ...base, visual: "extra" })).toThrow(/Unrecognized key|invalid/i);
  });
});
