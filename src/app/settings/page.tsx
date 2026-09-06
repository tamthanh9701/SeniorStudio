export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { createClient } from "@/supabase/server";
import SettingsSurface from "@/components/studio/SettingsSurface";

export default async function SettingsPage() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: heartbeat } = await supabase
    .from("service_heartbeats")
    .select("last_seen_at")
    .eq("service", "vercel-daily")
    .single();

  const { data: projects } = await supabase.from("projects").select("id, name").order("created_at", { ascending: false });
  return <SettingsSurface projects={projects ?? []} userEmail={user.email ?? "Signed in"} heartbeat={heartbeat?.last_seen_at ?? null} />;
}
