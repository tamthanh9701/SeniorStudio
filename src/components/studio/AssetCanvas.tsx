"use client";

import Link from "next/link";
import { Download, ExternalLink, Focus, Scan, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { WorkspaceAsset } from "@/components/studio/ToolInspector";

export default function AssetCanvas({ assets, selectedIndex, onSelect, projectId, onEmptyFocus, loadingCount = 0, onDelete }: { assets: WorkspaceAsset[]; selectedIndex: number; onSelect: (index: number) => void; projectId: string; onEmptyFocus: () => void; loadingCount?: number; onDelete?: (assetId: string) => void }) {
  const selected = assets[selectedIndex] ?? null;
  const [actualSize, setActualSize] = useState(false);
  useEffect(() => { const handler = (event: KeyboardEvent) => { if (event.key === "ArrowLeft" && assets.length) onSelect((selectedIndex - 1 + assets.length) % assets.length); if (event.key === "ArrowRight" && assets.length) onSelect((selectedIndex + 1) % assets.length); if (event.key === "Escape") setActualSize(false); }; window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler); }, [assets.length, onSelect, selectedIndex]);
  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="checker-stage relative min-h-0 flex-1 overflow-auto p-4 sm:p-8">
        {!selected && loadingCount > 0 && (
          <div className="flex h-full min-h-[300px] items-center justify-center gap-3" aria-label="Generating images">
            <span className="flex size-16 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04]">
              <Scan className="size-6 animate-pulse text-primary" />
            </span>
            <span className="text-sm text-stage-muted">Generating {loadingCount} image{loadingCount > 1 ? "s" : ""}…</span>
          </div>
        )}
        {selected?.signedUrl ? (
          <div className="flex h-full min-h-[300px] items-center justify-center">
            <img src={selected.signedUrl} alt={selected.name} className={actualSize ? "max-w-none" : "max-h-full max-w-full object-contain"} />
          </div>
        ) : !selected && (
          <button onClick={onEmptyFocus} className="flex h-full min-h-[340px] w-full flex-col items-center justify-center rounded-2xl border border-dashed border-[var(--stage-border)] text-center">
            <span className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Scan className="size-7" />
            </span>
            <h2 className="mt-5 text-xl font-semibold text-stage-text">Start with a prompt</h2>
            <p className="mt-2 max-w-md px-5 text-sm leading-6 text-stage-muted">Describe an image below. Generated results will appear here without leaving the workspace.</p>
          </button>
        )}
        {selected && (
          <div className="absolute left-1/2 top-3 flex -translate-x-1/2 items-center gap-1 rounded-lg border border-border bg-card/95 p-1 text-foreground shadow-xl backdrop-blur">
            <Button variant="outline" size="icon" className={cn(!actualSize && "bg-primary/15 text-primary")} onClick={() => setActualSize(false)} aria-label="Zoom to fit" aria-pressed={!actualSize} title="Zoom to fit">
              <Focus className="size-4" />
            </Button>
            <Button variant="outline" size="icon" className={cn(actualSize && "bg-primary/15 text-primary")} onClick={() => setActualSize(true)} aria-label="View at 100 percent" aria-pressed={actualSize} title="100%">
              <span className="text-[11px] font-semibold">100%</span>
            </Button>
            {selected.signedUrl && (
              <Button asChild variant="outline" size="icon">
                <a href={selected.signedUrl} download aria-label="Download asset" title="Download">
                  <Download className="size-4" />
                </a>
              </Button>
            )}
            <Button asChild variant="outline" size="icon">
              <Link href={`/projects/${projectId}/assets/${selected.id}`} aria-label="Open asset details" title="Details">
                <ExternalLink className="size-4" />
              </Link>
            </Button>
            <Button variant="outline" size="icon" className="text-destructive/70 hover:text-destructive" onClick={() => onDelete?.(selected.id)} aria-label="Delete this asset" title="Delete asset">
              <Trash2 className="size-4" />
            </Button>
          </div>
        )}
      </div>
      {assets.length > 0 && (
        <div className="shrink-0 overflow-x-auto border-t border-white/10 bg-muted p-3">
          <div className="flex min-w-max gap-2">
            {assets.map((asset, index) => (
              <Button key={`${asset.id}-${asset.signedUrl}`} variant="ghost" size="icon" onClick={() => onSelect(index)} aria-label={`Select ${asset.name}`} className={cn("size-16 overflow-hidden rounded-xl border-2 p-0 sm:size-20", index === selectedIndex ? "border-primary" : "border-transparent")}>
                {asset.signedUrl ? <img src={asset.signedUrl} alt="" className="size-16 object-cover sm:size-20" /> : <span className="flex size-16 items-center justify-center bg-accent text-xs text-muted-foreground sm:size-20">Empty</span>}
              </Button>
            ))}
            {Array.from({ length: loadingCount }, (_, index) => <Skeleton key={`loading-${index}`} aria-hidden className="size-16 rounded-xl sm:size-20" />)}
          </div>
        </div>
      )}
    </div>
  );
}
