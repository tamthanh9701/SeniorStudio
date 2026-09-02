"use client";

import { Activity, LogOut, Mail } from "lucide-react";
import ProviderSettings from "@/components/studio/ProviderSettings";
import ProjectSidebar from "@/components/studio/ProjectSidebar";
import StudioShell from "@/components/studio/StudioShell";
import { createClient } from "@/supabase/client";

export default function SettingsSurface({ projects, userEmail, heartbeat }: { projects: Array<{ id: string; name: string }>; userEmail: string; heartbeat: string | null }) {
  const signOut = async () => { await createClient().auth.signOut(); window.location.assign("/login"); };
  const sidebar = <ProjectSidebar projects={projects} userEmail={userEmail} />;
  const center = <div className="h-full overflow-y-auto pb-24 xl:pb-0"><div className="mx-auto max-w-3xl px-5 py-10 sm:px-8"><p className="text-sm font-medium text-[#7c5cff]">Account</p><h1 className="mt-2 text-3xl font-semibold">Settings</h1><div className="studio-card mt-8"><ProviderSettings /></div><div className="studio-card mt-6 divide-y divide-white/10"><div className="flex items-center gap-4 p-5"><span className="flex size-10 items-center justify-center rounded-xl bg-[#35c48d]/10 text-[#66d7ae]"><Activity className="size-5" /></span><div className="min-w-0 flex-1"><p className="font-medium">Service heartbeat</p><p className="mt-1 text-sm text-[#98a2b3]">{heartbeat ? `Last seen ${new Date(heartbeat).toLocaleString()}` : "No heartbeat has been recorded"}</p></div><span className={`size-2.5 rounded-full ${heartbeat ? "bg-[#35c48d]" : "bg-[#f2b84b]"}`} aria-label={heartbeat ? "Service heartbeat available" : "Service heartbeat unavailable"} /></div><div className="flex items-center gap-4 p-5"><span className="flex size-10 items-center justify-center rounded-xl bg-white/[0.05] text-[#98a2b3]"><Mail className="size-5" /></span><div className="min-w-0"><p className="font-medium">Signed-in email</p><p className="mt-1 truncate text-sm text-[#98a2b3]">{userEmail}</p></div></div></div><div className="studio-card mt-6 p-5"><h2 className="font-semibold">Sign out</h2><p className="mt-2 text-sm leading-6 text-[#98a2b3]">End this browser session. Your projects, generated assets, and provider configuration remain safely stored.</p><button onClick={signOut} className="studio-button-danger mt-5"><LogOut className="size-4" />Sign out</button></div></div></div>;
  return <StudioShell projects={projects} userEmail={userEmail} leftSidebar={sidebar} center={center} />;
}
