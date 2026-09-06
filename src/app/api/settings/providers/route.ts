import { NextResponse } from "next/server";
import { z } from "zod";
import { AiProviderSchema } from "@/db/ai-jobs";
import { createClient } from "@/supabase/server";

const SaveSchema = z.object({ provider: AiProviderSchema, apiKey: z.string().trim().min(1).max(512) });

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  const { data, error } = await supabase.from("provider_settings").select("provider, updated_at").order("provider");
  if (error) return NextResponse.json({ error: { code: "LOAD_FAILED", message: error.message } }, { status: 500 });
  return NextResponse.json({ providers: (data ?? []).map((row) => ({ provider: row.provider, updatedAt: row.updated_at })) });
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  const parsed = SaveSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "Provider and API key are required" } }, { status: 400 });
  const { error } = await supabase.rpc("upsert_provider_setting", { p_provider: parsed.data.provider, p_api_key: parsed.data.apiKey });
  if (error) return NextResponse.json({ error: { code: "SAVE_FAILED", message: error.message } }, { status: 500 });
  return NextResponse.json({ saved: true }, { status: 201 });
}

export async function DELETE(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  const parsed = AiProviderSchema.safeParse(new URL(request.url).searchParams.get("provider"));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "Unknown provider" } }, { status: 400 });
  const { error } = await supabase.rpc("delete_provider_setting", { p_provider: parsed.data });
  if (error) return NextResponse.json({ error: { code: "DELETE_FAILED", message: error.message } }, { status: 500 });
  return NextResponse.json({ deleted: true });
}
