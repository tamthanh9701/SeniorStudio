"use client";

import Link from "next/link";
import { Menu, Settings2, Sparkles, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";
import type { ProjectJobFeedItem } from "@/db/ai-jobs";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

export type StudioShellProps = {
  projects: Array<{ id: string; name: string }>;
  activeProjectId?: string;
  userEmail: string;
  recentJobs?: ProjectJobFeedItem[];
  leftSidebar: ReactNode | ((options: { closeNavigation: () => void }) => ReactNode);
  center: ReactNode;
  inspector?: ReactNode;
};

/** Radix Select rejects empty item values, so the playground scope uses a sentinel. */
const PLAYGROUND = "__playground__";

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

      <div className={`grid h-[calc(100dvh-3.5rem)] grid-cols-1 xl:h-dvh ${inspector ? "xl:grid-cols-[248px_minmax(0,1fr)_360px]" : "xl:grid-cols-[248px_minmax(0,1fr)]"}`}>
        <aside className="hidden min-h-0 border-r border-border bg-muted xl:block">{sidebarNode}</aside>
        <main className="min-h-0 min-w-0 overflow-hidden">{center}</main>
        {inspector && <aside className="hidden min-h-0 overflow-y-auto border-l border-border bg-muted xl:block">{inspector}</aside>}
      </div>

      <Button ref={mobileNavTriggerRef} className="fixed bottom-3 left-3 z-40 shadow-lg xl:hidden" onClick={() => setMobileNavOpen(true)} aria-label="Open navigation"><Menu className="size-4" />Menu</Button>

      <Sheet open={mobileNavOpen} onOpenChange={(next) => { if (!next) closeMobileNav(); }}>
        <SheetContent
          side="left"
          showCloseButton={false}
          aria-label="Navigation"
          className="w-80 max-w-[calc(100%-2rem)] bg-muted p-3"
          onCloseAutoFocus={(event) => { event.preventDefault(); mobileNavTriggerRef.current?.focus(); }}
        >
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <div className="flex min-h-full flex-col overflow-y-auto">
            <Button variant="outline" size="icon" className="ml-auto" onClick={closeMobileNav} aria-label="Close navigation"><X className="size-5" /></Button>
            {sidebarNode}
            <div className="mt-auto border-t border-border pt-3">
              <Button asChild variant="ghost" className="h-auto min-h-11 w-full justify-start font-normal text-muted-foreground hover:text-foreground" onClick={closeMobileNav}>
                <Link href="/settings">Settings</Link>
              </Button>
            </div>
          </div>
        </SheetContent>
      </Sheet>

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

      <span className="sr-only" aria-live="polite">{activeProject ? `${activeProject.name} workspace` : "Image Playground"}</span>
    </div>
  );
}
