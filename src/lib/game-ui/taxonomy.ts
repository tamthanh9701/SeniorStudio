// Element taxonomy. One closed list so the UI, the SQL validator and the
// analysis prompts agree on what an element can be; a free-form kind would make
// export manifests and reusable element sets meaningless.

export const ELEMENT_KINDS = [
  "group",
  "health_bar",
  "resource_bar",
  "progress_bar",
  "bar_track",
  "bar_fill",
  "avatar",
  "icon",
  "button",
  "popup",
  "modal",
  "panel",
  "frame",
  "text",
  "badge",
  "counter",
  "tab",
  "toggle",
  "slider",
  "input",
  "list_item",
  "tooltip",
  "background",
  "decoration",
  "custom",
] as const;

export type ElementKind = (typeof ELEMENT_KINDS)[number];

/**
 * Kinds that describe a whole region made of other visible parts.  Their
 * children are still separate pixels, so a composite can be exported and so can
 * one of its parts.
 */
export const COMPOSITE_KINDS: readonly ElementKind[] = ["health_bar", "resource_bar", "progress_bar"];

/** A group only organizes the tree: it has no pixels of its own to export. */
export const ORGANIZATIONAL_KINDS: readonly ElementKind[] = ["group"];

/** Full-screen artwork, never a default member of a transparent-element pack. */
export const FULL_SCREEN_KINDS: readonly ElementKind[] = ["background"];

export function isElementKind(value: unknown): value is ElementKind {
  return typeof value === "string" && (ELEMENT_KINDS as readonly string[]).includes(value);
}

export function kindLabel(kind: ElementKind, customType: string | null): string {
  if (kind === "custom") return customType?.trim() || "Custom element";
  return kind
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** What each kind means, shown in the picker and given to the analysis model. */
export const KIND_DESCRIPTIONS: Record<ElementKind, string> = {
  group: "Organizational parent with no pixels of its own",
  health_bar: "Visible health bar, optionally split into track, fill and label",
  resource_bar: "Visible mana/energy/stamina bar, optionally split into track and fill",
  progress_bar: "Visible progress or loading bar, optionally split into track and fill",
  bar_track: "Background groove of a bar",
  bar_fill: "Filled portion of a bar",
  avatar: "Character portrait artwork, optionally framed",
  icon: "Small pictogram or symbol",
  button: "Pressable control including its visible label and icon",
  popup: "Floating message or container above the screen",
  modal: "Dialog shown as blocking the screen behind it",
  panel: "Persistent bordered section of the screen",
  frame: "Border or chrome that encloses another element",
  text: "Rendered text as pixels, not an editable font",
  badge: "Small status marker or notification dot",
  counter: "Numeric readout such as coins or score",
  tab: "Selectable tab in a tab strip",
  toggle: "Switch with visible on/off state",
  slider: "Track with a visible handle",
  input: "Text or value entry field",
  list_item: "One row of a list",
  tooltip: "Small explanatory callout",
  background: "Full-screen artwork behind the UI",
  decoration: "Ornament with no interaction",
  custom: "Element that does not fit another kind",
};

/**
 * The wording the analysis and detection prompts reuse, so the model's kinds
 * match the stored enum exactly instead of inventing near-misses.
 */
export function kindCatalogForPrompt(): string {
  return ELEMENT_KINDS.map((kind) => `${kind}: ${KIND_DESCRIPTIONS[kind]}`).join("\n");
}
