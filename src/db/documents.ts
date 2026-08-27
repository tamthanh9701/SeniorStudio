import { z } from "zod";

export const EDITOR_DOCUMENTS_TABLE = "editor_documents";

export const LayerTypeSchema = z.enum(["image", "text", "shape", "draw"]);
export type LayerType = z.infer<typeof LayerTypeSchema>;

export const LayerSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  type: LayerTypeSchema,
  visible: z.boolean().default(true),
  locked: z.boolean().default(false),
  opacity: z.number().min(0).max(1).default(1),
  transform: z.object({
    x: z.number().default(0),
    y: z.number().default(0),
    scaleX: z.number().default(1),
    scaleY: z.number().default(1),
    rotation: z.number().default(0),
  }).default({ x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }),
  zIndex: z.number(),
  payload: z.record(z.string(), z.unknown()),
});
export type Layer = z.infer<typeof LayerSchema>;

export const EditorDocumentV1Schema = z.object({
  width: z.number(),
  height: z.number(),
  layers: z.array(LayerSchema),
});
export type EditorDocumentV1 = z.infer<typeof EditorDocumentV1Schema>;

export const EditorDocumentSchema = z.object({
  id: z.string().uuid(),
  asset_id: z.string().uuid(),
  base_version_id: z.string().uuid(),
  schema_version: z.number().default(1),
  document: EditorDocumentV1Schema,
  updated_at: z.string().datetime(),
});
export type EditorDocument = z.infer<typeof EditorDocumentSchema>;

export const SaveDocumentInputSchema = z.object({
  asset_id: z.string().uuid(),
  document: EditorDocumentV1Schema,
  expected_updated_at: z.string().datetime().optional(),
});
