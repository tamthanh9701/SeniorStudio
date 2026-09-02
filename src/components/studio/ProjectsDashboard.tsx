"use client";

import Link from "next/link";
import { ArrowUpRight, FolderPlus, ImageIcon, Plus, X } from "lucide-react";
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
  useEffect(() => { if (open) inputRef.current?.focus(); const handler = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); }; window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler); }, [open]);
  const createProject = async (event: React.FormEvent) => {
    event.preventDefault(); setSubmitting(true); setError(null);
    const response = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
    const body = await response.json();
    if (response.ok) router.push(`/projects/${body.project.id}`);
    else setError(`${body.error?.code ?? "CREATE_FAILED"}: ${body.error?.message ?? "Unable to create project"}`);
    setSubmitting(false);
  };
  const sidebar = <ProjectSidebar projects={projects} userEmail={userEmail} onNewProject={() => setOpen(true)} />;
  const center = <div className="h-full overflow-y-auto pb-24 xl:pb-0">
    <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8 sm:py-12">
      <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
        <div><p className="text-sm font-medium text-[#7c5cff]">Workspace library</p><h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Your projects</h1><p className="mt-3 max-w-2xl text-sm leading-6 text-[#98a2b3]">Each project keeps its prompts, generated images, and immutable edit history together.</p></div>
        {projects.length > 0 && <button className="studio-button-primary shrink-0" onClick={() => setOpen(true)}><Plus className="size-4" />New project</button>}
      </div>
      {projects.length === 0 ? <div className="studio-card mt-12 flex min-h-96 flex-col items-center justify-center border-dashed p-8 text-center"><span className="flex size-14 items-center justify-center rounded-2xl bg-[#7c5cff]/15 text-[#a995ff]"><FolderPlus className="size-7" /></span><h2 className="mt-5 text-xl font-semibold">Create your first project</h2><p className="mt-2 max-w-md text-sm leading-6 text-[#98a2b3]">Prompts and generated images stay inside the project, giving every idea a focused history.</p><button className="studio-button-primary mt-6" onClick={() => setOpen(true)}><Plus className="size-4" />Create your first project</button></div> : <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">{projects.map((project) => <Link key={project.id} href={`/projects/${project.id}`} className="studio-card group overflow-hidden transition hover:-translate-y-0.5 hover:border-white/20"><div className="checker-stage flex aspect-[4/3] items-center justify-center overflow-hidden">{project.thumbnailUrl ? <img src={project.thumbnailUrl} alt="" className="h-full w-full object-cover transition duration-300 group-hover:scale-[1.02]" /> : <ImageIcon className="size-9 text-[#475467]" />}</div><div className="flex items-start gap-3 p-5"><div className="min-w-0 flex-1"><h2 className="truncate font-semibold">{project.name}</h2><p className="mt-1 text-xs text-[#667085]">Created {new Date(project.created_at).toLocaleDateString()}</p></div><ArrowUpRight className="size-4 text-[#667085] transition group-hover:text-white" /></div></Link>)}</div>}
    </div>
  </div>;
  return <><StudioShell projects={projects} userEmail={userEmail} leftSidebar={sidebar} center={center} />{open && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}><section role="dialog" aria-modal="true" aria-labelledby="create-project-title" className="studio-card relative w-full max-w-md p-6"><button className="studio-icon-button absolute right-3 top-3" onClick={() => setOpen(false)} aria-label="Close create project dialog"><X className="size-4" /></button><h2 id="create-project-title" className="text-xl font-semibold">Create a project</h2><p className="mt-2 text-sm text-[#98a2b3]">Give this creative workspace a clear name.</p><form className="mt-6" onSubmit={createProject}><label className="studio-label" htmlFor="project-name">Project name</label><input ref={inputRef} id="project-name" className="studio-control" value={name} onChange={(event) => setName(event.target.value)} maxLength={100} required /><button className="studio-button-primary mt-4 w-full" disabled={submitting || !name.trim()}>{submitting ? "Creating…" : "Create project"}</button>{error && <p role="alert" className="mt-3 text-sm text-[#ff9b9b]">{error}</p>}</form></section></div>}</>;
}
