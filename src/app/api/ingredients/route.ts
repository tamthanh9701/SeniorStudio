import { NextResponse } from "next/server";
import { createClient } from "@/supabase/server";
import { CreateIngredientInputSchema } from "@/db/ingredients";

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const result = CreateIngredientInputSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 400 });
  }

  const { project_id, alias, asset_id, version_id } = result.data;

  // Verify asset and version exist
  const { data: asset } = await supabase
    .from("assets")
    .select("id")
    .eq("id", asset_id)
    .eq("project_id", project_id)
    .single();

  if (!asset) {
    return NextResponse.json({ error: "Asset not found" }, { status: 404 });
  }

  const { data: version } = await supabase
    .from("asset_versions")
    .select("id")
    .eq("id", version_id)
    .eq("asset_id", asset_id)
    .single();

  if (!version) {
    return NextResponse.json({ error: "Version not found" }, { status: 404 });
  }

  // Create ingredient
  const { data: ingredient, error } = await supabase
    .from("project_ingredients")
    .insert({
      project_id,
      alias,
      asset_id,
      version_id,
    })
    .select()
    .single();

  if (error) {
    if (error.code === "23505") {
      return NextResponse.json({ error: "Alias already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ ingredient });
}
