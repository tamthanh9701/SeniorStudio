import { z } from "zod";

export const PRESETS_TABLE = "presets";

export const PresetKindSchema = z.enum(["generation", "edit", "document"]);
export type PresetKind = z.infer<typeof PresetKindSchema>;

export const PresetSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  name: z.string(),
  kind: PresetKindSchema,
  definition: z.record(z.string(), z.unknown()),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type Preset = z.infer<typeof PresetSchema>;

export const CreatePresetInputSchema = z.object({
  workspace_id: z.string().uuid(),
  name: z.string().min(1).max(100),
  kind: PresetKindSchema,
  definition: z.record(z.string(), z.unknown()),
});

export const UpdatePresetInputSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  definition: z.record(z.string(), z.unknown()).optional(),
});
