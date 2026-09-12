import { NextResponse } from "next/server";
import { createClient } from "@/supabase/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  const { data: heartbeat } = await supabase
    .from("service_heartbeats")
    .select("last_seen_at")
    .eq("service", "ai_worker")
    .single();
  return NextResponse.json({ lastSeenAt: heartbeat?.last_seen_at ?? null });
}
