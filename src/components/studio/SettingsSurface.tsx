"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, LogOut, Mail } from "lucide-react";
import ProviderSettings from "@/components/studio/ProviderSettings";
import ProjectSidebar from "@/components/studio/ProjectSidebar";
import StudioShell from "@/components/studio/StudioShell";
import ThemeSelect from "@/components/theme/ThemeSelect";
import { createClient } from "@/supabase/client";

const STALE_THRESHOLD_MS = 5 * 60_000;

export default function SettingsSurface({ projects, userEmail, heartbeat: initialHeartbeat }: { projects: Array<{ id: string; name: string }>; userEmail: string; heartbeat: string | null }) {
  const [heartbeat, setHeartbeat] = useState<string | null>(initialHeartbeat);
  const [now, setNow] = useState(() => Date.now());
  const [fetchError, setFetchError] = useState<string | null>(null);
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

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { const timer = window.setInterval(() => { void refresh(); }, 30_000); return () => window.clearInterval(timer); }, [refresh]);

  const heartbeatAge = heartbeat ? now - Date.parse(heartbeat) : null;
  const heartbeatState = heartbeatAge === null || !Number.isFinite(heartbeatAge) ? "unknown" : heartbeatAge <= STALE_THRESHOLD_MS ? "healthy" : "stale";
  const heartbeatLabel = heartbeatState === "healthy" ? "Worker healthy" : heartbeatState === "stale" ? "Worker stale" : "Worker status unknown";
  const signOut = async () => { await createClient().auth.signOut(); window.location.assign("/login"); };
  const sidebar = <ProjectSidebar activeModule="playground" userEmail={userEmail} />;
  const center = <div className="h-full overflow-y-auto pb-24 xl:pb-0"><div className="mx-auto max-w-3xl space-y-6 px-5 py-8 sm:px-8 sm:py-10"><div><p className="text-sm font-medium text-[var(--accent)]">Account</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Settings</h1><p className="mt-2 text-sm text-[var(--muted)]">Manage appearance, providers and your active session.</p></div><ThemeSelect /><div className="studio-card"><ProviderSettings /></div><div className="studio-card divide-y divide-[var(--border)]"><div className="flex items-center gap-4 p-5"><span className={`flex size-10 items-center justify-center rounded-xl ${heartbeatState === "healthy" ? "bg-[color-mix(in_srgb,var(--success)_12%,transparent)] text-[var(--success)]" : heartbeatState === "stale" ? "bg-[color-mix(in_srgb,var(--warning)_12%,transparent)] text-[var(--warning)]" : "bg-[var(--surface-hover)] text-[var(--muted)]"}`}><Activity className="size-5" /></span><div><p className="font-medium">{heartbeatLabel}</p><p className="mt-1 text-xs text-[var(--muted)]">{heartbeat ? `Last seen ${new Date(heartbeat).toLocaleString()}` : "No heartbeat recorded yet"}{fetchError && <span className="ml-2 text-[var(--danger)]">{fetchError} <button type="button" onClick={() => void refresh()} className="underline">Retry</button></span>}</p></div></div><div className="flex items-center gap-4 p-5"><span className="flex size-10 items-center justify-center rounded-xl bg-[var(--surface-hover)] text-[var(--muted)]"><Mail className="size-5" /></span><div><p className="font-medium">Signed in as</p><p className="mt-1 text-sm text-[var(--muted)]">{userEmail}</p></div></div><div className="flex items-center gap-4 p-5"><button onClick={signOut} className="studio-button-secondary"><LogOut className="size-4" /> Sign out</button></div></div></div></div>;
  return <StudioShell projects={projects} userEmail={userEmail} leftSidebar={sidebar} center={center} />;
}
