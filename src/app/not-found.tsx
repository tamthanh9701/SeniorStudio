import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Branded 404.
 *
 * A stale link used to end on the framework's bare default page with no way
 * back, which strands the user; every dead end now offers the two module
 * entry points.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-foreground">
      <Card className="w-full max-w-md text-center">
        <CardHeader className="items-center">
          <p className="text-sm font-medium text-primary">Not found</p>
          <CardTitle className="text-2xl">This page does not exist</CardTitle>
          <CardDescription>
            The link may be outdated, or the project, style or image it pointed to has been deleted.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 sm:flex-row sm:justify-center">
          <Button asChild>
            <Link href="/projects">Image Playground</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/style">Style</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
