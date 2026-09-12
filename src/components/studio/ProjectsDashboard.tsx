"use client";

import Link from "next/link";
import { FolderPlus, Plus, Search, Trash2, X } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import ProjectSidebar from "@/components/studio/ProjectSidebar";
import StudioShell from "@/components/studio/StudioShell";
import { StudioDialog } from "@/components/studio/StudioDialog";

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

  const sidebar = ({ closeNavigation }: { closeNavigation: () => void }) => <ProjectSidebar activeModule="playground" userEmail={userEmail} onNewProject={() => { closeNavigation(); setOpen(true); }} />;
  const center = <div className="h-full overflow-y-auto pb-24 xl:pb-0"><div className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-10">
    <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between"><div><p className="text-sm font-medium text-[var(--accent)]">Image Playground</p><h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Create with focus</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-[var(--muted)]">Each project keeps prompts, generated images and immutable edit history together.</p></div>{projects.length > 0 && <button className="studio-button-primary shrink-0" onClick={() => setOpen(true)}><Plus className="size-4" />New project</button>}</div>
    {projects.length > 0 && <div className="mt-8 flex flex-col gap-3 sm:flex-row"><label className="relative min-w-0 flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--muted)]" /><span className="sr-only">Search projects</span><input className="studio-control pl-10" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search projects" /></label><label className="sm:w-44"><span className="sr-only">Sort projects</span><select className="studio-control" value={sort} onChange={(event) => setSort(event.target.value as "updated" | "name")}><option value="updated">Recently updated</option><option value="name">Name</option></select></label></div>}
    {projects.length === 0 ? <div className="studio-card mt-12 flex min-h-96 flex-col items-center justify-center border-dashed p-8 text-center"><span className="flex size-14 items-center justify-center rounded-2xl bg-[var(--accent-subtle)] text-[var(--accent)]"><FolderPlus className="size-7" /></span><h2 className="mt-5 text-xl font-semibold">Create your first project</h2><p className="mt-2 max-w-md text-sm leading-6 text-[var(--muted)]">Prompts and generated images stay inside the project, giving every idea a focused history.</p><button className="studio-button-primary mt-6" onClick={() => setOpen(true)}><Plus className="size-4" />Create your first project</button></div> : visibleProjects.length === 0 ? <div className="studio-card mt-8 p-8 text-center"><h2 className="text-lg font-semibold">No matching projects</h2><p className="mt-2 text-sm text-[var(--muted)]">Try a different search term.</p></div> : <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{visibleProjects.map((project) => <div key={project.id} className="studio-card group relative flex items-center gap-4 p-4"><Link href={`/projects/${project.id}`} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl p-2 transition hover:bg-[var(--surface-hover)]"><div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--surface-hover)] text-[var(--muted)]"><FolderPlus className="size-5" /></div><div className="min-w-0"><p className="truncate text-sm font-medium">{project.name}</p><p className="text-xs text-[var(--muted)]">Updated {new Date(project.updated_at ?? project.created_at).toLocaleDateString()}</p></div></Link><button type="button" className="studio-icon-button opacity-0 transition group-hover:opacity-100" aria-label={`Delete ${project.name}`} onClick={() => setDeleteTarget(project)}><Trash2 className="size-4 text-[var(--danger)]" /></button></div>)}</div>}
    </div></div>;

  return <>
    <StudioShell projects={projects} userEmail={userEmail} leftSidebar={sidebar} center={center} />

    <StudioDialog open={open} onClose={() => setOpen(false)} label="Create a project" initialFocusRef={inputRef} dismissible={!submitting} className="studio-card w-full max-w-md p-6" style={{ position: "fixed" } as React.CSSProperties}>
      <button className="studio-icon-button absolute right-3 top-3" onClick={() => setOpen(false)} aria-label="Close create project dialog" disabled={submitting}><X className="size-4" /></button>
      <h2 className="text-xl font-semibold">Create a project</h2>
      <p className="mt-2 text-sm text-[var(--muted)]">Give this creative workspace a name.</p>
      <form onSubmit={createProject} className="mt-4 space-y-4">
        <div>
          <label htmlFor="project-name" className="studio-label">Project name</label>
          <input
            id="project-name"
            ref={inputRef}
            className="studio-control w-full"
            placeholder="e.g. Wedding album, Product renders"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={200}
          />
        </div>
        {error && <p role="alert" className="text-xs text-[var(--danger)]">{error}</p>}
        <div className="flex justify-end gap-2"><button type="button" onClick={() => setOpen(false)} disabled={submitting} className="studio-button-secondary">Cancel</button><button type="submit" disabled={!name.trim() || submitting} className="studio-button-primary">{submitting ? "Creating…" : "Create project"}</button></div>
      </form>
    </StudioDialog>

    <StudioDialog open={Boolean(deleteTarget)} onClose={() => !deletingProject && setDeleteTarget(null)} label="Delete project" dismissible={!deletingProject} className="studio-card w-full max-w-md p-6" style={{ position: "fixed" } as React.CSSProperties}>
      <button className="studio-icon-button absolute right-3 top-3" onClick={() => setDeleteTarget(null)} aria-label="Close delete dialog" disabled={deletingProject}><X className="size-4" /></button>
      <h2 className="text-xl font-semibold">Delete project</h2>
      <p className="mt-2 text-sm text-[var(--muted)]">This will permanently remove <span className="font-medium text-[var(--text)]">{deleteTarget?.name}</span> and all of its images. This cannot be undone.</p>
      {error && <p role="alert" className="mt-2 text-xs text-[var(--danger)]">{error}</p>}
      <div className="mt-6 flex justify-end gap-2">
        <button type="button" onClick={() => setDeleteTarget(null)} disabled={deletingProject} className="studio-button-secondary">Cancel</button>
        <button type="button" onClick={() => void confirmDeleteProject()} disabled={deletingProject} className="rounded-xl bg-[var(--danger)] px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90">{deletingProject ? "Deleting…" : "Delete project"}</button>
      </div>
    </StudioDialog>
  </>;
}
