export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { createClient } from "@/supabase/server";
import { getVerifiedUser } from "@/lib/auth/verified-user";

export default async function Home() {
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  redirect(user ? "/projects" : "/login");
}
