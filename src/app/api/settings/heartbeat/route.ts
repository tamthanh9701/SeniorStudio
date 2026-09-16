import { NextResponse } from "next/server";
import { createClient, getServiceClient } from "@/supabase/server";
import { getVerifiedUser } from "@/lib/auth/verified-user";

export const dynamic = "force-dynamic";

export async function GET() {
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  // The heartbeat table is service-role only, so reading it with the caller's
  // client would always report "unknown"; this read exposes one timestamp and
  // no user data.
  const { data: heartbeat } = await getServiceClient()
    .from("service_heartbeats")
    .select("last_seen_at")
    .eq("service", "ai_worker")
    .maybeSingle();
  return NextResponse.json({ lastSeenAt: heartbeat?.last_seen_at ?? null });
}
