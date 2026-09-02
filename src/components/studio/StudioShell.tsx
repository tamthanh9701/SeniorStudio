"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ImageIcon, Menu, Paintbrush, Settings2, Sparkles, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { ProjectJobFeedItem } from "@/db/ai-jobs";

export type StudioShellProps = {
  projects: Array<{ id: string; name: string }>;
  activeProjectId?: string;
  userEmail: string;
  recentJobs?: ProjectJobFeedItem[];
  leftSidebar: ReactNode;
  center: ReactNode;
  inspector?: ReactNode;
};

export default function StudioShell({ projects, activeProjectId, leftSidebar, center, inspector }: StudioShellProps) {
  const pathname = usePathname();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  useEffect(() => setInspectorOpen(false), [pathname]);
  useEffect(() => { const handler = (event: KeyboardEvent) => { if (event.key === "Escape") setInspectorOpen(false); }; window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler); }, []);
  const activeProject = projects.find((project) => project.id === activeProjectId);

  return (
    <div className="h-dvh overflow-hidden bg-[#0b0d10] text-[#f5f7fa]">
      <header className="flex h-14 items-center gap-3 border-b border-white/10 bg-[#111419] px-3 xl:hidden">
        <Link href="/projects" className="flex min-h-11 items-center gap-2 rounded-xl px-2 font-semibold">
          <Sparkles className="size-5 text-[#7c5cff]" aria-hidden="true" />
          <span className="hidden sm:inline">SeniorStudio</span>
        </Link>
        <label className="min-w-0 flex-1">
          <span className="sr-only">Active project</span>
          <select className="studio-control truncate" value={activeProjectId ?? ""} onChange={(event) => { if (event.target.value) window.location.assign(`/projects/${event.target.value}`); }}>
            {!activeProjectId && <option value="">Projects</option>}
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        {inspector && <button className="studio-icon-button" onClick={() => setInspectorOpen(true)} aria-label="Open tool settings"><Settings2 className="size-5" /></button>}
      </header>

      <div className="grid h-[calc(100dvh-3.5rem)] grid-cols-1 xl:h-dvh xl:grid-cols-[248px_minmax(0,1fr)_360px]">
        <aside className="hidden min-h-0 border-r border-white/10 bg-[#111419] xl:block">{leftSidebar}</aside>
        <main className="min-h-0 min-w-0 overflow-hidden">{center}</main>
        {inspector && <aside className="hidden min-h-0 overflow-y-auto border-l border-white/10 bg-[#111419] xl:block">{inspector}</aside>}
      </div>

      <nav aria-label="Studio navigation" className="fixed inset-x-0 bottom-0 z-30 grid h-16 grid-cols-4 border-t border-white/10 bg-[#111419]/95 px-2 backdrop-blur xl:hidden">
        <Link href="/projects" className="flex min-h-11 flex-col items-center justify-center gap-1 text-[11px] text-[#98a2b3]"><ImageIcon className="size-5" />Library</Link>
        <Link href={activeProjectId ? `/projects/${activeProjectId}` : "/projects"} className="flex min-h-11 flex-col items-center justify-center gap-1 text-[11px] text-[#98a2b3]"><Sparkles className="size-5" />Create</Link>
        <Link href={activeProjectId ? `/projects/${activeProjectId}` : "/projects"} className="flex min-h-11 flex-col items-center justify-center gap-1 text-[11px] text-[#98a2b3]"><Paintbrush className="size-5" />Inpaint</Link>
        <button onClick={() => setInspectorOpen(true)} disabled={!inspector} className="flex min-h-11 flex-col items-center justify-center gap-1 text-[11px] text-[#98a2b3] disabled:opacity-40"><Menu className="size-5" />Tools</button>
      </nav>

      {inspector && inspectorOpen && <div className="fixed inset-0 z-50 bg-black/70 xl:hidden" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setInspectorOpen(false); }}>
        <section role="dialog" aria-modal="true" aria-label="Tool settings" className="absolute inset-y-0 right-0 w-full max-w-md overflow-y-auto border-l border-white/10 bg-[#111419] shadow-2xl">
          <button className="studio-icon-button absolute right-3 top-3 z-10" onClick={() => setInspectorOpen(false)} aria-label="Close tool settings"><X className="size-5" /></button>
          {inspector}
        </section>
      </div>}
      <span className="sr-only" aria-live="polite">{activeProject ? `${activeProject.name} workspace` : "Projects"}</span>
    </div>
  );
}
