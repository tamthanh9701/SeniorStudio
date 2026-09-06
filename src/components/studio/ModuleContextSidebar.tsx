"use client";

import Link from "next/link";
import { ImageIcon, LogOut, Settings, Sparkles, SwatchBook } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import type { ProjectJobFeedItem } from "@/db/ai-jobs";
import { JOB_STATUS_LABELS } from "@/lib/ai/presentation";
import { createClient } from "@/supabase/client";

export type ModuleId = "playground" | "style";

const MODULES: Array<{ id: ModuleId; label: string; href: string; icon: ComponentType<{ className?: string }> }> = [
  { id: "playground", label: "Image Playground", href: "/projects", icon: ImageIcon },
  { id: "style", label: "Style", href: "/style", icon: SwatchBook },
];

export function ModuleLinks({ active, className }: { active: ModuleId; className?: string }) {
  return (
    <nav aria-label="Modules" className={className}>
      <div className="space-y-1">
        {MODULES.map(({ id, label, href, icon: Icon }) => (
          <Link
            key={id}
            href={href}
            aria-current={id === active ? "page" : undefined}
            className={`flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm transition ${id === active ? "bg-white/[0.09] text-white" : "text-[#98a2b3] hover:bg-white/[0.05] hover:text-white"}`}
          >
            <Icon className="size-4 shrink-0" />
            <span className="truncate">{label}</span>
          </Link>
        ))}
      </div>
    </nav>
  );
}

export function RecentPrompts({ items, className }: { items: ProjectJobFeedItem[]; className?: string }) {
  return (
    <div className={className}>
      <div className="space-y-1">
        {items.slice(-12).reverse().map(({ job }) => (
          <Link key={job.id} href={job.project_id ? `/projects/${job.project_id}` : "/style"} className="block rounded-xl px-3 py-2.5 hover:bg-white/[0.05]">
            <span className="block truncate text-sm text-[#d0d5dd]">{job.input.original_prompt ?? job.input.prompt}</span>
            <span className="mt-1 block text-[11px] text-[#667085]">{JOB_STATUS_LABELS[job.status]}</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function SidebarFooter({ userEmail }: { userEmail: string }) {
  const signOut = async () => {
    await createClient().auth.signOut();
    window.location.assign("/login");
  };
  return (
    <div className="mt-3 border-t border-white/10 pt-3">
      <Link href="/settings" className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm text-[#98a2b3] hover:bg-white/[0.05] hover:text-white"><Settings className="size-4" />Settings</Link>
      <div className="mt-2 flex items-center gap-2 rounded-xl bg-white/[0.035] p-2 pl-3"><span className="min-w-0 flex-1 truncate text-xs text-[#98a2b3]">{userEmail}</span><button onClick={signOut} className="studio-icon-button size-9 min-h-9" aria-label="Sign out"><LogOut className="size-4" /></button></div>
    </div>
  );
}

export function SidebarBranding() {
  return (
    <Link href="/projects" className="mb-3 flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm font-semibold hover:bg-white/[0.05]">
      <span className="flex size-8 items-center justify-center rounded-lg bg-[#7c5cff]"><Sparkles className="size-4" /></span>
      SeniorStudio
    </Link>
  );
}

export function SectionLabel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={`px-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-[#667085] ${className}`}>{children}</p>;
}

export default function ModuleContextSidebar({ currentModule, recentJobs = [], userEmail, contextLabel }: {
  currentModule: ModuleId;
  recentJobs?: ProjectJobFeedItem[];
  userEmail: string;
  contextLabel?: string | null;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col p-3">
      <SidebarBranding />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SectionLabel>Modules</SectionLabel>
        <ModuleLinks active={currentModule} className="mt-2" />
        {contextLabel && (
          <>
            <SectionLabel className="mt-6">Context</SectionLabel>
            <p className="mt-2 truncate rounded-xl bg-white/[0.06] px-3 py-2.5 text-sm text-white" title={contextLabel}>{contextLabel}</p>
          </>
        )}
        {recentJobs.length > 0 && (
          <>
            <SectionLabel className="mt-6">Recent prompts</SectionLabel>
            <RecentPrompts items={recentJobs} className="mt-2" />
          </>
        )}
      </div>
      <SidebarFooter userEmail={userEmail} />
    </div>
  );
}
