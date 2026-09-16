"use client";

import Link from "next/link";
import { Images, Settings2, Sparkles, SwatchBook, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";
import type { ProjectJobFeedItem } from "@/db/ai-jobs";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export type StudioShellProps = {
  projects: Array<{ id: string; name: string }>;
  activeProjectId?: string;
  userEmail: string;
  recentJobs?: ProjectJobFeedItem[];
  leftSidebar: ReactNode;
  center: ReactNode;
  inspector?: ReactNode;
};

/** Radix Select rejects empty item values, so the playground scope uses a sentinel. */
const PLAYGROUND = "__playground__";

export default function StudioShell({ projects, activeProjectId, leftSidebar, center, inspector }: StudioShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const inspectorTriggerRef = useRef<HTMLButtonElement>(null);
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const closeInspector = () => { setInspectorOpen(false); inspectorTriggerRef.current?.focus(); };



  return (
    <div className="h-dvh overflow-hidden bg-background text-foreground">
      <header className="flex h-14 items-center gap-3 border-b border-border bg-muted px-3 xl:hidden">
        <Link href="/projects" className="flex min-h-11 items-center gap-2 rounded-xl px-2 font-semibold">
          <Sparkles className="size-5 text-primary" aria-hidden="true" />
          <span className="hidden sm:inline">SeniorStudio</span>
        </Link>
        <div className="min-w-0 flex-1">
          <Select value={activeProjectId ?? PLAYGROUND} onValueChange={(value) => { if (value !== PLAYGROUND) { setInspectorOpen(false); router.push(`/projects/${value}`); } }}>
            <SelectTrigger className="w-full min-w-0" aria-label="Active project">
              <SelectValue placeholder="Playground" />
            </SelectTrigger>
            <SelectContent>
              {!activeProjectId && <SelectItem value={PLAYGROUND}>Playground</SelectItem>}
              {projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        {inspector && <Button ref={inspectorTriggerRef} variant="outline" size="icon" onClick={() => setInspectorOpen(true)} aria-label="Open tool settings"><Settings2 className="size-5" /></Button>}
      </header>

      <div className={`grid h-[calc(100dvh-7rem)] grid-cols-1 xl:h-dvh ${inspector ? "xl:grid-cols-[248px_minmax(0,1fr)_360px]" : "xl:grid-cols-[248px_minmax(0,1fr)]"}`}>
        <aside className="hidden min-h-0 border-r border-border bg-muted xl:block">{leftSidebar}</aside>
        <main className="min-h-0 min-w-0 overflow-hidden">{center}</main>
        {inspector && <aside className="hidden min-h-0 overflow-y-auto border-l border-border bg-muted xl:block">{inspector}</aside>}
      </div>


      {inspector && (
        <Dialog open={inspectorOpen} onOpenChange={(next) => { if (!next) closeInspector(); }}>
          <DialogContent
            showCloseButton={false}
            aria-label="Tool settings"
            className="max-h-[calc(100dvh-2rem)] max-w-md overflow-y-auto bg-muted p-4"
            onCloseAutoFocus={(event) => { event.preventDefault(); inspectorTriggerRef.current?.focus(); }}
          >
            <DialogTitle className="sr-only">Tool settings</DialogTitle>
            <div className="relative p-4">
              <Button variant="outline" size="icon" className="absolute right-3 top-3 z-10" onClick={closeInspector} aria-label="Close tool settings"><X className="size-5" /></Button>
              {inspector}
            </div>
          </DialogContent>
        </Dialog>
      )}

      <nav aria-label="Primary" className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-card/95 backdrop-blur xl:hidden">
        <ul className="grid grid-cols-3">
          {[
            { href: "/projects", label: "Playground", icon: Images },
            { href: "/style", label: "Styles", icon: SwatchBook },
            { href: "/settings", label: "Settings", icon: Settings2 },
          ].map((entry) => {
            const active = pathname === entry.href || pathname.startsWith(`${entry.href}/`);
            return (
              <li key={entry.href}>
                <Link
                  href={entry.href}
                  aria-current={active ? "page" : undefined}
                  className={cn("flex min-h-14 flex-col items-center justify-center gap-1 text-[11px] font-medium", active ? "text-primary" : "text-muted-foreground")}
                >
                  <entry.icon className="size-5" aria-hidden />
                  {entry.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <span className="sr-only" aria-live="polite">{activeProject ? `${activeProject.name} workspace` : "Image Playground"}</span>
    </div>
  );
}
