export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { createClient, getServiceClient } from "@/supabase/server";
import SettingsSurface from "@/components/studio/SettingsSurface";
import { getVerifiedUser } from "@/lib/auth/verified-user";

export default async function SettingsPage() {
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);

  if (!user) {
    redirect("/login");
  }

  // service_heartbeats is deliberately readable only by the service role, so a
  // user-scoped client always returns zero rows and the indicator would report
  // "unknown" forever.  This one infrastructure read is done with the service
  // client; nothing about it is user data.
  const { data: heartbeat } = await getServiceClient()
    .from("service_heartbeats")
    .select("last_seen_at")
    .eq("service", "ai_worker")
    .maybeSingle();

  const { data: projects } = await supabase.from("projects").select("id, name").order("created_at", { ascending: false });
  return <SettingsSurface projects={projects ?? []} userEmail={user.email ?? "Signed in"} heartbeat={heartbeat?.last_seen_at ?? null} />;
}
