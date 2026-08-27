import { NextResponse } from "next/server";
import { getEnv } from "@/env";
import { getServiceClient } from "@/supabase/server";

export async function GET(request: Request) {
  const env = getEnv();
  const authHeader = request.headers.get("authorization");
  
  if (authHeader !== `Bearer ${env.CRON_SECRET}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const serviceClient = getServiceClient();
  
  const { error } = await serviceClient
    .from("service_heartbeats")
    .upsert({
      service: "vercel-daily",
      last_seen_at: new Date().toISOString(),
    }, { onConflict: "service" });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ success: true, timestamp: new Date().toISOString() });
}
