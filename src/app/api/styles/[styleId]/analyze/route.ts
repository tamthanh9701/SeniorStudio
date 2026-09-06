// Synchronous style analysis. No job queue: the vision call is a single
// long-running REST request bounded by maxDuration and the provider timeout.
import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/supabase/server";
import { styleProfilesEnabled } from "@/lib/style/flag";
import { analyzeStyleProfile } from "@/lib/style/service";
import { StyleError, styleErrorStatus } from "@/lib/style/errors";

export const maxDuration = 180;

const AnalyzeSchema = z.object({ userContext: z.string().trim().max(2000).optional() });

function flagDisabled() {
  return NextResponse.json({ error: { code: "NOT_FOUND", message: "Not found" } }, { status: 404 });
}

export async function POST(request: Request, { params }: { params: Promise<{ styleId: string }> }) {
  if (!styleProfilesEnabled()) return flagDisabled();
  const { styleId } = await params;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED", message: "Unauthorized" } }, { status: 401 });
  const parsed = AnalyzeSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "userContext must be at most 2000 characters" } }, { status: 400 });

  try {
    const style = await analyzeStyleProfile({ styleId, userContext: parsed.data.userContext, client: supabase });
    return NextResponse.json({ style });
  } catch (error) {
    if (error instanceof StyleError) {
      return NextResponse.json({ error: { code: error.code, message: error.message } }, { status: styleErrorStatus(error.code) });
    }
    console.error("style analysis failed:", error);
    return NextResponse.json({ error: { code: "STYLE_ANALYSIS_FAILED", message: "Style analysis failed" } }, { status: 502 });
  }
}
