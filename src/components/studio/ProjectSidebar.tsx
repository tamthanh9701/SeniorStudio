"use client";

import Link from "next/link";
import { FolderPlus, LogOut, Settings, Sparkles } from "lucide-react";
import type { ProjectJobFeedItem } from "@/db/ai-jobs";
import { JOB_STATUS_LABELS } from "@/lib/ai/presentation";
import { createClient } from "@/supabase/client";

export default function ProjectSidebar({ projects, activeProjectId, recentJobs = [], userEmail, onNewProject }: {
  projects: Array<{ id: string; name: string }>;
  activeProjectId?: string;
  recentJobs?: ProjectJobFeedItem[];
  userEmail: string;
  onNewProject?: () => void;
}) {
  const signOut = async () => {
    await createClient().auth.signOut();
    window.location.assign("/login");
  };
  return <div className="flex h-full min-h-0 flex-col p-3">
    <Link href="/projects" className="mb-3 flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-semibold hover:bg-white/[0.05]">
      <span className="flex size-8 items-center justify-center rounded-lg bg-[#7c5cff]"><Sparkles className="size-4" /></span>
      SeniorStudio
    </Link>
    <button onClick={onNewProject} className="studio-button-secondary w-full justify-start"><FolderPlus className="size-4" />New project</button>
    <div className="mt-5 min-h-0 flex-1 overflow-y-auto">
      <p className="px-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#667085]">Projects</p>
      <div className="mt-2 space-y-1">
        {projects.map((project) => <Link key={project.id} href={`/projects/${project.id}`} className={`block min-h-11 truncate rounded-xl px-3 py-3 text-sm transition ${project.id === activeProjectId ? "bg-white/[0.09] text-white" : "text-[#98a2b3] hover:bg-white/[0.05] hover:text-white"}`}>{project.name}</Link>)}
      </div>
      {recentJobs.length > 0 && <><p className="mt-6 px-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#667085]">Recent prompts</p><div className="mt-2 space-y-1">{recentJobs.slice(-12).reverse().map(({ job }) => <Link key={job.id} href={`/projects/${job.project_id}`} className="block rounded-xl px-3 py-2.5 hover:bg-white/[0.05]"><span className="block truncate text-sm text-[#d0d5dd]">{job.input.prompt}</span><span className="mt-1 block text-[11px] text-[#667085]">{JOB_STATUS_LABELS[job.status]}</span></Link>)}</div></>}
    </div>
    <div className="mt-3 border-t border-white/10 pt-3">
      <Link href="/settings" className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm text-[#98a2b3] hover:bg-white/[0.05] hover:text-white"><Settings className="size-4" />Settings</Link>
      <div className="mt-2 flex items-center gap-2 rounded-xl bg-white/[0.035] p-2 pl-3"><span className="min-w-0 flex-1 truncate text-xs text-[#98a2b3]">{userEmail}</span><button onClick={signOut} className="studio-icon-button size-9 min-h-9" aria-label="Sign out"><LogOut className="size-4" /></button></div>
    </div>
  </div>;
}
