"use client";

import Link from "next/link";
import { AlertTriangle, RotateCcw } from "lucide-react";

export default function RouteError({ reset }: { reset: () => void }) {
  return <main className="flex min-h-dvh items-center justify-center bg-[#0b0d10] p-5"><section className="studio-card max-w-md p-7 text-center"><span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-[#ef6262]/10 text-[#ff9b9b]"><AlertTriangle className="size-6" /></span><h1 className="mt-5 text-xl font-semibold">This workspace could not be loaded</h1><p className="mt-2 text-sm leading-6 text-[#98a2b3]">Retry the request. If it continues, return to projects and choose another workspace.</p><div className="mt-6 flex flex-col gap-2 sm:flex-row"><button onClick={reset} className="studio-button-primary flex-1"><RotateCcw className="size-4" />Retry</button><Link href="/projects" className="studio-button-secondary flex-1">Back to projects</Link></div></section></main>;
}
