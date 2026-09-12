"use client";

import Link from "next/link";
import { ImageIcon, Menu, Paintbrush, Settings2, Sparkles, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";
import type { ProjectJobFeedItem } from "@/db/ai-jobs";
import { StudioDialog } from "@/components/studio/StudioDialog";

export type StudioShellProps = {
  projects: Array<{ id: string; name: string }>;
  activeProjectId?: string;
  userEmail: string;
  recentJobs?: ProjectJobFeedItem[];
  leftSidebar: ReactNode | ((options: { closeNavigation: () => void }) => ReactNode);
  center: ReactNode;
  inspector?: ReactNode;
};

export default function StudioShell({ projects, activeProjectId, leftSidebar, center, inspector }: StudioShellProps) {
  const router = useRouter();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const inspectorTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileNavTriggerRef = useRef<HTMLButtonElement>(null);
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const closeMobileNav = () => { setMobileNavOpen(false); mobileNavTriggerRef.current?.focus(); };
  const closeInspector = () => { setInspectorOpen(false); inspectorTriggerRef.current?.focus(); };

  const sidebarNode = typeof leftSidebar === "function" ? leftSidebar({ closeNavigation: closeMobileNav }) : leftSidebar;

  return (
    <div className="h-dvh overflow-hidden bg-[var(--canvas)] text-[var(--text)]">
      <header className="flex h-14 items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-3 xl:hidden">
        <Link href="/projects" className="flex min-h-11 items-center gap-2 rounded-xl px-2 font-semibold">
          <Sparkles className="size-5 text-[var(--accent)]" aria-hidden="true" />
          <span className="hidden sm:inline">SeniorStudio</span>
        </Link>
        <label className="min-w-0 flex-1">
          <span className="sr-only">Active project</span>
          <select className="studio-control truncate" value={activeProjectId ?? ""} onChange={(event) => { if (event.target.value) { setInspectorOpen(false); router.push(`/projects/${event.target.value}`); } }}>
            {!activeProjectId && <option value="">Playground</option>}
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
        </label>
        {inspector && <button ref={inspectorTriggerRef} className="studio-icon-button" onClick={() => setInspectorOpen(true)} aria-label="Open tool settings"><Settings2 className="size-5" /></button>}
      </header>

      <div className={`grid h-[calc(100dvh-3.5rem)] grid-cols-1 xl:h-dvh ${inspector ? "xl:grid-cols-[248px_minmax(0,1fr)_360px]" : "xl:grid-cols-[248px_minmax(0,1fr)]"}`}>
        <aside className="hidden min-h-0 border-r border-[var(--border)] bg-[var(--panel)] xl:block">{sidebarNode}</aside>
        <main className="min-h-0 min-w-0 overflow-hidden">{center}</main>
        {inspector && <aside className="hidden min-h-0 overflow-y-auto border-l border-[var(--border)] bg-[var(--panel)] xl:block">{inspector}</aside>}
      </div>

      <button ref={mobileNavTriggerRef} className="fixed bottom-3 left-3 z-40 flex min-h-11 items-center gap-2 rounded-xl bg-[var(--accent)] px-4 text-sm font-semibold text-white shadow-lg xl:hidden" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation"><Menu className="size-4" />Menu</button>

      <StudioDialog open={mobileNavOpen} onClose={closeMobileNav} label="Navigation" returnFocusRef={mobileNavTriggerRef} className="fixed inset-y-0 left-0 w-80 max-w-[calc(100%-2rem)] border-r border-[var(--border)] bg-[var(--panel)] p-3 shadow-2xl" style={{ position: "fixed" } as React.CSSProperties}>
        <div className="flex min-h-full flex-col overflow-y-auto">
          <button className="studio-icon-button ml-auto" onClick={closeMobileNav} aria-label="Close navigation"><X className="size-5" /></button>
          {sidebarNode}
          <div className="mt-auto border-t border-[var(--border)] pt-3">
            <Link href="/settings" className="flex min-h-11 items-center rounded-xl px-3 text-sm text-[var(--muted)] hover:bg-[var(--surface-hover)]" onClick={closeMobileNav}>Settings</Link>
          </div>
        </div>
      </StudioDialog>

      {inspector && (
        <StudioDialog open={inspectorOpen} onClose={closeInspector} label="Tool settings" returnFocusRef={inspectorTriggerRef} className="fixed inset-y-0 right-0 w-full max-w-md overflow-y-auto border-l border-[var(--border)] bg-[var(--panel)] shadow-2xl" style={{ position: "fixed" } as React.CSSProperties}>
          <div className="relative p-4">
            <button className="studio-icon-button absolute right-3 top-3 z-10" onClick={closeInspector} aria-label="Close tool settings"><X className="size-5" /></button>
            {inspector}
          </div>
        </StudioDialog>
      )}

      <span className="sr-only" aria-live="polite">{activeProject ? `${activeProject.name} workspace` : "Image Playground"}</span>
    </div>
  );
}
