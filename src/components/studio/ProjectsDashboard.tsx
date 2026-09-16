"use client";

import Image from "next/image";
import Link from "next/link";
import { FolderPlus, Plus, Search, Trash2, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import ProjectSidebar from "@/components/studio/ProjectSidebar";
import StudioShell from "@/components/studio/StudioShell";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatDate } from "@/lib/format/datetime";

type DashboardProject = { id: string; name: string; created_at: string; updated_at?: string | null; thumbnailUrl: string | null };

export default function ProjectsDashboard({ projects, userEmail }: { projects: DashboardProject[]; userEmail: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [deleteTarget, setDeleteTarget] = useState<DashboardProject | null>(null);
  const [deletingProject, setDeletingProject] = useState(false);
  const query = searchParams.get("q") ?? "";
  const sort = searchParams.get("sort") === "name" ? "name" : "updated";
  const setQuery = (next: string) => { const params = new URLSearchParams(searchParams.toString()); if (next) params.set("q", next); else params.delete("q"); router.replace(`?${params.toString()}`, { scroll: false }); };
  const setSort = (next: "updated" | "name") => { const params = new URLSearchParams(searchParams.toString()); if (next !== "updated") params.set("sort", next); else params.delete("sort"); router.replace(`?${params.toString()}`, { scroll: false }); };
  const visibleProjects = useMemo(() => projects.filter((project) => project.name.toLowerCase().includes(query.trim().toLowerCase())).sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : Date.parse(b.updated_at ?? b.created_at) - Date.parse(a.updated_at ?? a.created_at)), [projects, query, sort]);

  const createProject = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim() || submitting) return;
    setSubmitting(true); setError(null);
    try {
      const response = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.trim() }) });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`${body.error?.code ?? "CREATE_FAILED"}: ${body.error?.message ?? "Unable to create project"}`);
      router.push(`/projects/${body.project.id}`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to create project"); }
    finally { setSubmitting(false); }
  };

  const confirmDeleteProject = async () => {
    if (!deleteTarget || deletingProject) return;
    setDeletingProject(true);
    try {
      const response = await fetch(`/api/projects/${deleteTarget.id}`, { method: "DELETE" });
      if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error?.message ?? "Unable to delete project"); }
      router.refresh(); setDeleteTarget(null);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "Unable to delete project"); }
    finally { setDeletingProject(false); }
  };

  const sidebar = <ProjectSidebar activeModule="playground" userEmail={userEmail} />;
  const center = <div className="h-full overflow-y-auto pb-24 xl:pb-0"><div className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-10">
    <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-sm font-medium text-primary">Image Playground</p><h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Create with focus</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-muted-foreground">Each project keeps prompts, generated images and immutable edit history together.</p></div><div className="flex shrink-0"><Button onClick={() => setOpen(true)}><Plus className="size-4" />New project</Button></div></div>
    {projects.length > 0 && <div className="mt-8 flex flex-col gap-3 sm:flex-row"><label className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" /><span className="sr-only">Search projects</span><Input className="pl-10" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects" /></label><div className="sm:w-44"><Select value={sort} onValueChange={(next) => setSort(next as "updated" | "name")}><SelectTrigger className="w-full" aria-label="Sort projects"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="updated">Recently updated</SelectItem><SelectItem value="name">Name</SelectItem></SelectContent></Select></div></div>}
    {projects.length === 0 ? <Card className="mt-12 flex min-h-96 flex-col items-center justify-center gap-0 border-dashed p-8 text-center"><span className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary"><FolderPlus className="size-7" /></span><h2 className="mt-5 text-xl font-semibold">Create your first project</h2><p className="mt-2 max-w-md text-sm leading-6 text-muted-foreground">Prompts and generated images stay inside the project, giving every idea a focused history.</p><Button className="mt-6" onClick={() => setOpen(true)}><Plus className="size-4" />Create your first project</Button></Card> : visibleProjects.length === 0 ? <Card className="mt-8 gap-0 p-8 text-center"><h2 className="text-lg font-semibold">No matching projects</h2><p className="mt-2 text-sm text-muted-foreground">Try a different search term.</p></Card> : <ul className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{visibleProjects.map((project) => <li key={project.id} className="group relative"><Link href={`/projects/${project.id}`} className="block h-full"><Card className="h-full gap-0 overflow-hidden p-0 transition-colors group-hover:border-primary/50">{project.thumbnailUrl ? <Image src={project.thumbnailUrl} alt={project.name} width={480} height={360} sizes="(min-width:1280px) 24vw, (min-width:640px) 45vw, 92vw" className="h-40 w-full object-cover" /> : <div aria-hidden className="flex h-40 w-full items-center justify-center bg-accent"><FolderPlus className="size-6 text-muted-foreground" /></div>}<div className="flex flex-col gap-1 p-4"><p className="truncate font-medium">{project.name}</p><p className="text-xs text-muted-foreground">Updated {formatDate(project.updated_at ?? project.created_at)}</p></div></Card></Link><Button type="button" variant="outline" size="icon" className="absolute right-3 top-3 opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100" aria-label={`Delete ${project.name}`} onClick={() => setDeleteTarget(project)}><Trash2 className="size-4 text-destructive" /></Button></li>)}</ul>}
    </div></div>;

  return <>
    <StudioShell projects={projects} userEmail={userEmail} leftSidebar={sidebar} center={center} />

    <Dialog open={open} onOpenChange={(next) => { if (!next) setOpen(false); }}>
      <DialogContent
        showCloseButton={false}
        className="max-w-md"
        onOpenAutoFocus={(event) => { event.preventDefault(); inputRef.current?.focus(); }}
        onEscapeKeyDown={(event) => { if (submitting) event.preventDefault(); }}
        onInteractOutside={(event) => { if (submitting) event.preventDefault(); }}
      >
        <Button variant="outline" size="icon" className="absolute right-3 top-3" onClick={() => setOpen(false)} aria-label="Close create project dialog" disabled={submitting}><X className="size-4" /></Button>
        <DialogHeader className="pr-10 text-left">
          <DialogTitle className="text-xl font-semibold">Create a project</DialogTitle>
          <DialogDescription>Give this creative workspace a name.</DialogDescription>
        </DialogHeader>
        <form onSubmit={createProject} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="project-name" className="text-xs font-semibold tracking-wide">Project name</Label>
            <Input
              id="project-name"
              ref={inputRef}
              placeholder="e.g. Wedding album, Product renders"
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={200}
            />
          </div>
          {error && <Alert variant="destructive" role="alert" className="px-3 py-2"><AlertDescription className="text-xs">{error}</AlertDescription></Alert>}
          <DialogFooter className="gap-2"><Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={submitting}>Cancel</Button><Button type="submit" disabled={!name.trim() || submitting}>{submitting ? "Creating…" : "Create project"}</Button></DialogFooter>
        </form>
      </DialogContent>
    </Dialog>

    <Dialog open={Boolean(deleteTarget)} onOpenChange={(next) => { if (!next && !deletingProject) setDeleteTarget(null); }}>
      <DialogContent
        showCloseButton={false}
        className="max-w-md"
        onEscapeKeyDown={(event) => { if (deletingProject) event.preventDefault(); }}
        onInteractOutside={(event) => { if (deletingProject) event.preventDefault(); }}
      >
        <Button variant="outline" size="icon" className="absolute right-3 top-3" onClick={() => setDeleteTarget(null)} aria-label="Close delete dialog" disabled={deletingProject}><X className="size-4" /></Button>
        <DialogHeader className="pr-10 text-left">
          <DialogTitle className="text-xl font-semibold">Delete project</DialogTitle>
          <DialogDescription>This will permanently remove <span className="font-medium text-foreground">{deleteTarget?.name}</span> and all of its images. This cannot be undone.</DialogDescription>
        </DialogHeader>
        {error && <Alert variant="destructive" role="alert" className="px-3 py-2"><AlertDescription className="text-xs">{error}</AlertDescription></Alert>}
        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => setDeleteTarget(null)} disabled={deletingProject}>Cancel</Button>
          <Button type="button" variant="destructive" onClick={() => void confirmDeleteProject()} disabled={deletingProject}>{deletingProject ? "Deleting…" : "Delete project"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>;
}
