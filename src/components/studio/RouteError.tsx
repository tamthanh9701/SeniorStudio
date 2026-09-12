"use client";

import Link from "next/link";
import { AlertTriangle, RotateCcw } from "lucide-react";

export default function RouteError({ reset }: { reset: () => void }) {
  return <main className="flex min-h-dvh items-center justify-center bg-[var(--canvas)] p-5"><section className="studio-card max-w-md p-7 text-center"><span className="mx-auto flex size-12 items-center justify-center rounded-2xl bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] text-[var(--danger)]"><AlertTriangle className="size-6" /></span><h1 className="mt-5 text-xl font-semibold">This workspace could not be loaded</h1><p className="mt-2 text-sm leading-6 text-[var(--muted)]">Retry the request. If it continues, return to Image Playground and choose another workspace.</p><button onClick={reset} className="studio-button-primary mt-6">Try again</button></section></main>;
}
