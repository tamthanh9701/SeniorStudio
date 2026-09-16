"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Activity, LogOut, Mail } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import ProviderSettings from "@/components/studio/ProviderSettings";
import { createClient } from "@/supabase/client";
import ProjectSidebar from "@/components/studio/ProjectSidebar";
import StudioShell from "@/components/studio/StudioShell";
import ThemeSelect from "@/components/theme/ThemeSelect";
import { cn } from "@/lib/utils";
import { formatDateTime } from "@/lib/format/datetime";

const STALE_THRESHOLD_MS = 5 * 60_000;

export default function SettingsSurface({ projects, userEmail, heartbeat: initialHeartbeat }: { projects: Array<{ id: string; name: string }>; userEmail: string; heartbeat: string | null }) {
  const [heartbeat, setHeartbeat] = useState<string | null>(initialHeartbeat);
  const [now, setNow] = useState(() => Date.now());
  const [fetchError, setFetchError] = useState<string | null>(null);
  const router = useRouter();
  const busyRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => { if (mountedRef.current) setNow(Date.now()); }, 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const signOut = async () => { await createClient().auth.signOut(); router.replace("/login"); router.refresh(); };

  const refresh = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setFetchError(null);
    try {
      const response = await fetch("/api/settings/heartbeat", { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      if (!mountedRef.current) return;
      if (typeof body.lastSeenAt === "string" && !Number.isNaN(Date.parse(body.lastSeenAt))) {
        setHeartbeat(body.lastSeenAt);
      } else if (body.lastSeenAt === null) {
        setHeartbeat(null);
      }
    } catch {
      if (!mountedRef.current) return;
      setFetchError("Unable to load worker status");
    } finally {
      busyRef.current = false;
    }
  }, []);

  // Deferred one tick, so the first poll does not set state during the first paint.
  useEffect(() => {
    const timer = window.setTimeout(() => { void refresh(); }, 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);
  useEffect(() => { const timer = window.setInterval(() => { void refresh(); }, 30_000); return () => window.clearInterval(timer); }, [refresh]);

  const heartbeatAge = heartbeat ? now - Date.parse(heartbeat) : null;
  const heartbeatState = heartbeatAge === null || !Number.isFinite(heartbeatAge) ? "unknown" : heartbeatAge <= STALE_THRESHOLD_MS ? "healthy" : "stale";
  const heartbeatLabel = heartbeatState === "healthy" ? "Worker healthy" : heartbeatState === "stale" ? "Worker stale" : "No worker heartbeat yet";
  const heartbeatTone = heartbeatState === "healthy" ? "bg-success/10 text-success" : heartbeatState === "stale" ? "bg-warning/10 text-warning" : "text-muted-foreground";
  // A failed poll is a different problem from a worker that has never run, and
  // the operator needs to be able to tell them apart.
  const heartbeatDetail = fetchError
    ? `${fetchError}. The worker may still be running; the status could not be read.`
    : heartbeatState === "unknown"
      ? "No heartbeat has been recorded. Check that the scheduled worker invocation is enabled."
      : heartbeatState === "healthy"
        ? "The scheduled worker is running and claiming jobs."
        : "No heartbeat in the last 5 minutes. New jobs will stay queued until the worker runs again.";
  const sidebar = <ProjectSidebar activeModule="playground" userEmail={userEmail} />;
  const center = <div className="h-full overflow-y-auto pb-24 xl:pb-0">
    <div className="mx-auto max-w-6xl space-y-6 px-5 py-8 sm:px-8 sm:py-10">
      <div><p className="text-sm font-medium text-primary">Account</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Settings</h1><p className="mt-2 text-sm text-muted-foreground">Manage appearance, providers and your active session.</p></div>
      <ThemeSelect />
      <Card className="gap-0 py-0"><ProviderSettings /></Card>
      <Card className="gap-0 divide-y divide-border py-0">
        <div className="flex items-center gap-4 p-5">
          <span className={cn("flex size-10 shrink-0 items-center justify-center rounded-xl", heartbeatTone)}><Activity className="size-5" /></span>
          <div className="min-w-0">
            <Badge variant="secondary" className={heartbeatTone}>{heartbeatLabel}</Badge>
            <p className="mt-1 text-xs text-muted-foreground">{heartbeatDetail}</p>
            <p className="mt-1 text-xs text-muted-foreground">{heartbeat ? `Last seen ${formatDateTime(heartbeat)}` : "No heartbeat recorded yet"}{fetchError && <span className="ml-2 text-destructive">{fetchError} <Button variant="link" size="sm" className="h-auto p-0 text-xs underline" onClick={() => void refresh()}>Retry</Button></span>}</p>
          </div>
        </div>
        <div className="flex items-center gap-4 p-5">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-secondary text-muted-foreground"><Mail className="size-5" /></span>
          <div className="min-w-0"><p className="font-medium">Signed in as</p><p className="mt-1 text-sm text-muted-foreground">{userEmail}</p></div><Button variant="outline" onClick={signOut}><LogOut className="size-4" aria-hidden /> Sign out</Button>
        </div>

      </Card>
    </div>
  </div>;
  return <StudioShell projects={projects} userEmail={userEmail} leftSidebar={sidebar} center={center} />;
}
