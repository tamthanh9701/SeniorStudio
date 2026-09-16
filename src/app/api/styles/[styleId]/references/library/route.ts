// References a style may borrow: live images from the other styles of its
// library. Signed in bulk, and capped so one library cannot produce an
// unbounded response.
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/supabase/server";
import { getSignedUrls } from "@/lib/assets/service";
import { styleProfilesEnabled } from "@/lib/style/flag";
import { getVerifiedUser } from "@/lib/auth/verified-user";

const MAX_LIBRARY_REFERENCES = 200;

// The embedded style is what proves the library membership, so it is parsed
// rather than trusted: a row without it is dropped, never lent.
const LibraryReferenceRowSchema = z.object({
  id: z.string().uuid(),
  style_id: z.string().uuid(),
  storage_path: z.string().min(1),
  content_hash: z.string().nullable(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  styles: z.object({ id: z.string().uuid(), name: z.string(), library_id: z.string().uuid() }),
});

function flagDisabled() {
  return NextResponse.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
}

export async function GET(_request: Request, { params }: { params: Promise<{ styleId: string }> }) {
  if (!styleProfilesEnabled()) return flagDisabled();
  const { styleId } = await params;
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });

  const { data: style } = await supabase.from("styles").select("id, library_id").eq("id", styleId).maybeSingle();
  if (!style) return NextResponse.json({ error: { code: "STYLE_NOT_FOUND", message: "Style not found" } }, { status: 404 });
  if (!style.library_id) {
    return NextResponse.json({ error: { code: "NO_LIBRARY", message: "Assign this style to a library before borrowing references" } }, { status: 400 });
  }

  // The join re-checks the owner's library, so a style moved out of the library
  // stops lending its images immediately.
  const { data: rows, error } = await supabase
    .from("style_references")
    .select("id, style_id, storage_path, content_hash, width, height, styles!inner(id, name, library_id)")
    .eq("styles.library_id", style.library_id)
    .neq("style_id", styleId)
    .is("retired_at", null)
    .order("created_at", { ascending: false })
    .limit(MAX_LIBRARY_REFERENCES);
  if (error) return NextResponse.json({ error: { code: "LOAD_FAILED", message: "Unable to load library references" } }, { status: 500 });

  const parsedRows = (rows ?? []).flatMap((row) => {
    const parsed = LibraryReferenceRowSchema.safeParse(row);
    return parsed.success && parsed.data.styles.library_id === style.library_id ? [parsed.data] : [];
  });
  const signed = await getSignedUrls(supabase, parsedRows.map((row) => row.storage_path));
  const references = parsedRows.flatMap((row) => {
    const signedUrl = signed.get(row.storage_path);
    if (!signedUrl) return [];
    return [{
      id: row.id,
      styleId: row.styles.id,
      styleName: row.styles.name,
      contentHash: row.content_hash,
      width: row.width,
      height: row.height,
      signedUrl,
    }];
  });
  return NextResponse.json({ references });
}
