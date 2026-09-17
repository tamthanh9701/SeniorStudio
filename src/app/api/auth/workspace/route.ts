import { NextResponse } from "next/server";
import { createClient } from "@/supabase/server";
import { getVerifiedUser } from "@/lib/auth/verified-user";

export async function GET() {
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  const { data: projects } = await supabase.from("projects").select("id, name").order("created_at", { ascending: false });
  return NextResponse.json({ user: { email: user.email }, projects: projects ?? [] });
}
