"use client";

import Link from "next/link";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export default function RouteError({ reset }: { reset: () => void }) {
  return <main className="flex min-h-dvh items-center justify-center bg-background p-5"><Alert variant="destructive" role="alert" className="flex w-full max-w-md flex-col items-center p-7 text-center"><span className="flex size-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive"><AlertTriangle className="size-6" /></span><h1 className="mt-5 text-xl font-semibold">This workspace could not be loaded</h1><AlertDescription className="mt-2 text-sm leading-6">Retry the request. If it continues, return to Image Playground and choose another workspace.</AlertDescription><Button onClick={reset} className="mt-6">Try again</Button></Alert></main>;
}
