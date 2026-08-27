import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/supabase/server";
import { SaveDocumentInputSchema } from "@/db/documents";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ assetId: string }> }
) {
  const { assetId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { data: document, error } = await supabase
    .from("editor_documents")
    .select("*")
    .eq("asset_id", assetId)
    .single();

  if (error || !document) {
    return NextResponse.json({ error: "Document not found" }, { status: 404 });
  }

  return NextResponse.json({ document });
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ assetId: string }> }
) {
  const { assetId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = await request.json();
  const result = SaveDocumentInputSchema.safeParse(body);

  if (!result.success) {
    return NextResponse.json({ error: result.error.flatten() }, { status: 400 });
  }

  const { asset_id, document, expected_updated_at } = result.data;

  // Check for optimistic concurrency conflict
  if (expected_updated_at) {
    const { data: existing } = await supabase
      .from("editor_documents")
      .select("updated_at")
      .eq("asset_id", asset_id)
      .single();

    if (existing && existing.updated_at !== expected_updated_at) {
      return NextResponse.json(
        { error: "CONFLICT", message: "Document was modified by another session" },
        { status: 409 }
      );
    }
  }

  // Upsert document
  const { data: savedDocument, error } = await supabase
    .from("editor_documents")
    .upsert({
      asset_id,
      base_version_id: "", // Will be set on first save
      schema_version: 1,
      document,
      updated_at: new Date().toISOString(),
    }, { onConflict: "asset_id" })
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ document: savedDocument });
}
