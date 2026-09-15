"use client";

import Link from "next/link";
import { ImageIcon, LogOut, Settings, Sparkles, SwatchBook } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import type { ProjectJobFeedItem } from "@/db/ai-jobs";
import { JOB_STATUS_LABELS } from "@/lib/ai/presentation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
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
          <Button
            key={id}
            asChild
            variant="ghost"
            className={cn(
              "h-auto min-h-11 w-full justify-start gap-3 rounded-xl px-3 font-normal",
              id === active
                ? "bg-primary/10 text-primary hover:bg-primary/10 hover:text-primary"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <Link href={href} aria-current={id === active ? "page" : undefined}>
              <Icon className="size-4 shrink-0" />
              <span className="truncate">{label}</span>
            </Link>
          </Button>
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
          <Button key={job.id} asChild variant="ghost" className="h-auto w-full flex-col items-stretch gap-0.5 rounded-xl px-3 py-2.5 font-normal">
            <Link href={job.project_id ? `/projects/${job.project_id}` : "/style"}>
              <span className="w-full truncate text-sm text-foreground">{job.input.original_prompt ?? job.input.prompt}</span>
              <span className="mt-1 w-full text-[11px] text-muted-foreground">{JOB_STATUS_LABELS[job.status]}</span>
            </Link>
          </Button>
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
    <div className="mt-3 border-t border-border pt-3">
      <Button asChild variant="ghost" className="h-auto min-h-11 w-full justify-start gap-3 rounded-xl px-3 font-normal text-muted-foreground hover:text-foreground">
        <Link href="/settings"><Settings className="size-4" />Settings</Link>
      </Button>
      <div className="mt-2 flex items-center gap-2 rounded-xl bg-accent p-2 pl-3">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{userEmail}</span>
        <Button variant="outline" size="icon" className="size-9" aria-label="Sign out" onClick={signOut}><LogOut className="size-4" /></Button>
      </div>
    </div>
  );
}

export function SidebarBranding() {
  return (
    <Button asChild variant="ghost" className="mb-3 h-auto min-h-11 w-full justify-start gap-3 rounded-xl px-3 font-semibold">
      <Link href="/projects">
        <span className="flex size-8 items-center justify-center rounded-lg bg-primary text-white"><Sparkles className="size-4" /></span>
        SeniorStudio
      </Link>
    </Button>
  );
}

export function SectionLabel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <p className={cn("px-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground", className)}>{children}</p>;
}

export default function ModuleContextSidebar({ currentModule, recentJobs = [], userEmail, contextLabel, libraryTabs = [] }: {
  currentModule: ModuleId;
  recentJobs?: ProjectJobFeedItem[];
  userEmail: string;
  contextLabel?: string | null;
  libraryTabs?: Array<{ id: string; name: string }>;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col p-3">
      <SidebarBranding />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <SectionLabel>Modules</SectionLabel>
        <ModuleLinks active={currentModule} className="mt-2" />
        {libraryTabs.length > 0 && (
          <>
            <SectionLabel className="mt-6">Libraries</SectionLabel>
            <ul className="mt-2 space-y-0.5">
              {libraryTabs.map((library) => <li key={library.id} className="truncate rounded-xl px-3 py-2 text-sm text-muted-foreground" title={library.name}>{library.name}</li>)}
            </ul>
          </>
        )}
        {contextLabel && (
          <>
            <SectionLabel className="mt-6">Context</SectionLabel>
            <p className="mt-2 truncate rounded-xl bg-accent px-3 py-2.5 text-sm text-foreground" title={contextLabel}>{contextLabel}</p>
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
