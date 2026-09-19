"use client";

import Image from "next/image";
import Link from "next/link";
import { ImageIcon, LayoutPanelTop, Mail, Settings, Sparkles, SwatchBook } from "lucide-react";
import type { ComponentType, ReactNode } from "react";
import type { ProjectJobFeedItem } from "@/db/ai-jobs";
import { JOB_STATUS_LABELS } from "@/lib/ai/presentation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export type ModuleId = "playground" | "style" | "game_ui";

const MODULES: Array<{ id: ModuleId; label: string; href: string; icon: ComponentType<{ className?: string }> }> = [
  { id: "playground", label: "Image Playground", href: "/projects", icon: ImageIcon },
  { id: "style", label: "Style", href: "/style", icon: SwatchBook },
  { id: "game_ui", label: "Game UI Style", href: "/game-ui", icon: LayoutPanelTop },
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

/** Where a feed entry leads: the image it produced, else the surface it ran in. */
function hrefForJob(job: ProjectJobFeedItem["job"]) {
  if (job.asset_id && job.project_id) return `/projects/${job.project_id}/assets/${job.asset_id}`;
  if (job.project_id) return `/projects/${job.project_id}`;
  // A Game UI job belongs to the module that owns its style; routing it through
  // /style would only bounce off the visual workspace's redirect.
  if (job.input.game_ui && job.input.style_id) return `/game-ui/${job.input.style_id}`;
  if (job.input.style_id) return `/style/${job.input.style_id}`;
  return "/style";
}

export function RecentPrompts({ items, className }: { items: ProjectJobFeedItem[]; className?: string }) {
  return (
    <div className={className}>
      <div className="space-y-1">
        {items.slice(-12).reverse().map(({ job, result_urls }) => (
          <Button key={job.id} asChild variant="ghost" className="h-auto w-full items-start gap-2.5 rounded-xl px-3 py-2.5 font-normal">
            {/* A prompt is best recognised by what it produced. */}
            <Link href={hrefForJob(job)} className="flex w-full items-start gap-2.5">
              <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-accent">
                {result_urls[0] ? <Image src={result_urls[0]} alt="" width={72} height={72} className="size-9 object-cover" /> : <ImageIcon className="size-4 text-muted-foreground" aria-hidden />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block w-full truncate text-sm text-foreground">{job.input.original_prompt ?? job.input.prompt}</span>
                <span className="mt-0.5 block w-full text-[11px] text-muted-foreground">{JOB_STATUS_LABELS[job.status]}</span>
              </span>
            </Link>
          </Button>
        ))}
      </div>
    </div>
  );
}

export function SidebarFooter({ userEmail }: { userEmail: string }) {
  return (
    <div className="mt-3 border-t border-border pt-3">
      <div className="flex items-center gap-3 rounded-xl px-3 py-2">
        <Mail className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground" title={userEmail}>{userEmail}</span>
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

export default function ModuleContextSidebar({ currentModule, userEmail, contextLabel, libraryTabs = [], recentStyles = [] }: {
  currentModule: ModuleId;
  userEmail: string;
  contextLabel?: string | null;
  libraryTabs?: Array<{ id: string; name: string }>;
  /** Style list for the Style module's sidebar; the workspace is the other view of it. */
  recentStyles?: Array<{ id: string; name: string; imageCount: number }>;
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
        {recentStyles.length > 0 && (
          <>
            <SectionLabel className="mt-6">Recent styles</SectionLabel>
            <div className="mt-2 space-y-0.5">
              {recentStyles.map((style) => (
                <Button key={style.id} asChild variant="ghost" className="h-auto min-h-11 w-full flex-col items-stretch gap-0.5 rounded-xl px-3 py-2 font-normal">
                  <Link href={`/style/${style.id}`}>
                    <span className="w-full truncate text-sm text-foreground">{style.name}</span>
                    <span className="mt-1 w-full text-[11px] text-muted-foreground">
                      {style.imageCount} image{style.imageCount === 1 ? "" : "s"}
                    </span>
                  </Link>
                </Button>
              ))}
            </div>
          </>
        )}
      </div>
      <SidebarFooter userEmail={userEmail} />
    </div>
  );
}
