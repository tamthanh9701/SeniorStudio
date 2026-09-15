import Link from "next/link";

/**
 * Branded 404.
 *
 * A stale link used to end on the framework's bare default page with no way
 * back, which strands the user; every dead end now offers the two module
 * entry points.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-[var(--canvas)] px-6 text-center text-[var(--text)]">
      <p className="text-sm font-medium text-[var(--accent)]">Not found</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">This page does not exist</h1>
      <p className="mt-3 max-w-md text-sm leading-6 text-[var(--muted)]">
        The link may be outdated, or the project, style or image it pointed to has been deleted.
      </p>
      <div className="mt-6 flex w-full max-w-sm flex-col gap-2 sm:flex-row sm:justify-center">
        <Link href="/projects" className="studio-button-primary">Image Playground</Link>
        <Link href="/style" className="studio-button-secondary">Style</Link>
      </div>
    </main>
  );
}
