import { redirect } from "next/navigation";
import { createClient } from "@/supabase/server";
import Link from "next/link";

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

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-2xl mx-auto">
        <div className="mb-6">
          <Link
            href="/projects"
            className="text-blue-600 hover:underline"
          >
            Back to Projects
          </Link>
        </div>

        <h1 className="text-2xl font-bold mb-8">Settings</h1>

        <div className="space-y-6">
          <div className="p-6 border rounded-lg">
            <h2 className="text-lg font-semibold mb-4">Service Status</h2>
            <div className="space-y-2">
              <div className="flex justify-between">
                <span className="text-gray-600">Supabase Heartbeat:</span>
                <span>
                  {heartbeat?.last_seen_at
                    ? new Date(heartbeat.last_seen_at).toLocaleString()
                    : "Never"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600">Your Email:</span>
                <span>{user.email}</span>
              </div>
            </div>
          </div>

          <div className="p-6 border rounded-lg">
            <h2 className="text-lg font-semibold mb-4">Account</h2>
            <form action="/auth/signout" method="post">
              <button
                type="submit"
                className="bg-red-600 text-white px-4 py-2 rounded-md hover:bg-red-700"
              >
                Sign Out
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
