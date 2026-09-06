"use client";

import Link from "next/link";
import { ArrowUpRight, FolderPlus, ImageIcon, Plus, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import ProjectSidebar from "@/components/studio/ProjectSidebar";
import StudioShell from "@/components/studio/StudioShell";

type DashboardProject = { id: string; name: string; created_at: string; thumbnailUrl: string | null };

export default function ProjectsDashboard({ projects, userEmail }: { projects: DashboardProject[]; userEmail: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null);
  const [deletingProject, setDeletingProject] = useState(false);
  useEffect(() => { if (open) inputRef.current?.focus(); const handler = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); }; window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler); }, [open]);
  const createProject = async (event: React.FormEvent) => {
    event.preventDefault(); setSubmitting(true); setError(null);
    const response = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    const body = await response.json();
    if (response.ok) router.push(`/projects/${body.project.id}`);
    else setError(`${body.error?.code ?? "CREATE_FAILED"}: ${body.error?.message ?? "Unable to create project"}`);
    setSubmitting(false);
  };
  const confirmDeleteProject = async () => {
    if (!deleteTarget) return;
    setDeletingProject(true);
    const response = await fetch(`/api/projects/${deleteTarget.id}`, { method: "DELETE" });
    if (response.ok) router.push("/projects");
    setDeletingProject(false);
    setDeleteTarget(null);
  };
  const sidebar = <ProjectSidebar activeModule="playground" userEmail={userEmail} onNewProject={() => setOpen(true)} />;
  const center = <div className="h-full overflow-y-auto pb-24 xl:pb-0">
    <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-12">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div><p className="text-sm font-medium text-[#7c5cff]">Image Playground</p><h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Image Playground</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-[#98a2b3]">Each project keeps its prompts, generated images, and immutable edit history together.</p></div>
        {projects.length > 0 && <button className="studio-button-primary shrink-0" onClick={() => setOpen(true)}><Plus className="size-4" />New project</button>}
      </div>
      {projects.length === 0 ? <div className="studio-card mt-12 flex min-h-96 flex-col items-center justify-center border-dashed p-8 text-center"><span className="flex size-14 items-center justify-center rounded-2xl bg-[#7c5cff]/15 text-[#a995ff]"><FolderPlus className="size-7" /></span><h2 className="mt-5 text-xl font-semibold">Create your first project</h2><p className="mt-2 max-w-md text-sm leading-6 text-[#98a2b3]">Prompts and generated images stay inside the project, giving every idea a focused history.</p><button className="studio-button-primary mt-6" onClick={() => setOpen(true)}><Plus className="size-4" />Create your first project</button></div> : <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{projects.map((project) => <div key={project.id} className="group/card relative"><Link href={`/projects/${project.id}`} className="studio-card group overflow-hidden transition hover:-translate-y-0.5 hover:border-white/20 block"><div className="checker-stage flex aspect-[4/3] items-center justify-center overflow-hidden">{project.thumbnailUrl ? <img src={project.thumbnailUrl} alt="" className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]" /> : <ImageIcon className="size-9 text-[#475467]" />}</div><div className="flex items-start gap-3 p-5"><div className="min-w-0 flex-1"><h2 className="truncate font-semibold">{project.name}</h2><p className="mt-1 text-xs text-[#667085]">Created {new Date(project.created_at).toLocaleDateString()}</p></div><ArrowUpRight className="size-4 text-[#667085] transition group-hover:text-white" /></div></Link><button onClick={(event) => { event.preventDefault(); setDeleteTarget(project); }} className="absolute right-3 top-3 opacity-0 group-hover/card:opacity-100 studio-icon-button size-9 min-h-9 text-[#ef6262]/70 hover:text-[#ef6262]" aria-label={`Delete project ${project.name}`}><Trash2 className="size-4" /></button></div>)}</div>}
    </div>
  </div>;
  return <><StudioShell projects={projects} userEmail={userEmail} leftSidebar={sidebar} center={center} />{open && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}><section role="dialog" aria-modal="true" aria-labelledby="create-project-title" className="studio-card relative w-full max-w-md p-6"><button className="studio-icon-button absolute right-3 top-3" onClick={() => setOpen(false)} aria-label="Close create project dialog"><X className="size-4" /></button><h2 id="create-project-title" className="text-xl font-semibold">Create a project</h2><p className="mt-2 text-sm text-[#98a2b3]">Give this creative workspace a clear name.</p><form className="mt-6" onSubmit={createProject}><label className="studio-label" htmlFor="project-name">Project name</label><input ref={inputRef} id="project-name" className="studio-control" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required /><button className="studio-button-primary mt-4 w-full" disabled={submitting || !name.trim()}>{submitting ? "Creating…" : "Create project"}</button>{error && <p role="alert" className="mt-3 text-sm text-[#ff9b9b]">{error}</p>}</form></section></div>}{deleteTarget && (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="studio-card max-w-sm p-6">
        <h3 className="text-lg font-semibold">Delete &quot;{deleteTarget.name}&quot;?</h3>
        <p className="mt-2 text-sm text-[#98a2b3]">This will permanently delete this project, all assets, and all versions. This action cannot be undone.</p>
        <div className="mt-4 flex justify-end gap-3">
          <button onClick={() => setDeleteTarget(null)} disabled={deletingProject} className="px-4 py-2 text-sm">Cancel</button>
          <button onClick={confirmDeleteProject} disabled={deletingProject} className="px-4 py-2 text-sm bg-[#ef6262] text-white rounded-lg">{deletingProject ? "Deleting…" : "Delete permanently"}</button>
        </div>
      </div>
    </div>
  )}</>;
}
