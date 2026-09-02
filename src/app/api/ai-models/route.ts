import { NextResponse } from "next/server";
import { getModelCatalog } from "@/lib/ai/models";
import { createClient } from "@/supabase/server";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  try {
    return NextResponse.json({ models: await getModelCatalog(supabase) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to load provider models";
    return NextResponse.json({ error: { code: "PROVIDER_MODEL_CATALOG_UNAVAILABLE", message } }, { status: 503 });
  }
}
