import { z } from "zod";

export const INGREDIENTS_TABLE = "project_ingredients";

export const IngredientSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  alias: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{1,31}$/),
  asset_id: z.string().uuid(),
  version_id: z.string().uuid(),
  created_at: z.string().datetime(),
});
export type Ingredient = z.infer<typeof IngredientSchema>;

export const CreateIngredientInputSchema = z.object({
  project_id: z.string().uuid(),
  alias: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{1,31}$/),
  asset_id: z.string().uuid(),
  version_id: z.string().uuid(),
});

export const CompilePromptInputSchema = z.object({
  project_id: z.string().uuid(),
  prompt: z.string(),
});
