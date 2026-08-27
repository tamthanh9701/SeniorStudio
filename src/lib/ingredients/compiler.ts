import { getServiceClient } from "@/supabase/server";
import { INGREDIENTS_TABLE } from "@/db/ingredients";

export async function compilePrompt(projectId: string, prompt: string) {
  const serviceClient = getServiceClient();
  
  // Find all @alias tokens in prompt
  const tokenRegex = /@(\w+)/g;
  const tokens = [...prompt.matchAll(tokenRegex)].map((match) => match[1]);
  
  if (tokens.length === 0) {
    return { compiledPrompt: prompt, resolvedIngredients: [] };
  }

  // Get all ingredients for project
  const { data: ingredients, error } = await serviceClient
    .from(INGREDIENTS_TABLE)
    .select("*")
    .eq("project_id", projectId);

  if (error) throw error;

  // Check for unknown tokens
  const unknownTokens = tokens.filter(
    (token) => !ingredients?.some((ing) => ing.alias === token)
  );

  if (unknownTokens.length > 0) {
    throw new Error(`UNKNOWN_INGREDIENT: ${unknownTokens.join(", ")}`);
  }

  // Build resolved ingredients list
  const resolvedIngredients = ingredients
    ?.filter((ing) => tokens.includes(ing.alias))
    .map((ing) => ({
      alias: ing.alias,
      version_id: ing.version_id,
      asset_id: ing.asset_id,
    })) || [];

  return {
    compiledPrompt: prompt,
    resolvedIngredients,
  };
}
