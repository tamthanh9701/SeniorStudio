import { NextResponse } from "next/server";
import { createClient } from "@/supabase/server";
import { CreatePresetInputSchema } from "@/db/presets";
import { getVerifiedUser } from "@/lib/auth/verified-user";

export async function GET(request: Request) {
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const workspaceId = searchParams.get("workspace_id");

  if (!workspaceId) {
    return NextResponse.json({ error: "Missing workspace_id" }, { status: 400 });
  }

  const { data: presets, error } = await supabase
    .from("presets")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ presets });
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const result = CreatePresetInputSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 400 });
  }

  const { data: preset, error } = await supabase
    .from("presets")
    .insert(result.data)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ preset });
}
