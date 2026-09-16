"use client";

import { ChevronsLeftRight } from "lucide-react";
import Image from "next/image";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export default function ComparisonSlider({ beforeUrl, afterUrl, width, height, beforeLabel = "Parent", afterLabel = "Current" }: { beforeUrl: string; afterUrl: string; width: number; height: number; /** Label for the left (before) image. */ beforeLabel?: string; /** Label for the right (after) image. */ afterLabel?: string }) {
  const [position, setPosition] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);
  const update = (clientX: number) => { const rect = containerRef.current?.getBoundingClientRect(); if (!rect) return; setPosition(Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100))); };
  return <div ref={containerRef} className="relative mx-auto w-full max-w-full touch-none overflow-hidden rounded-2xl border border-white/10 bg-stage" style={{ aspectRatio: `${width} / ${height}` }} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); update(event.clientX); }} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) update(event.clientX); }}>
    <Image src={afterUrl} alt={`${afterLabel} version`} width={width} height={height} sizes="(min-width:1024px) 70vw, 100vw" unoptimized className="absolute inset-0 h-full w-full object-contain" draggable={false} />
    <Image src={beforeUrl} alt={`${beforeLabel} version`} width={width} height={height} sizes="(min-width:1024px) 70vw, 100vw" unoptimized className="absolute inset-0 h-full w-full object-contain" style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }} draggable={false} />
    <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow" style={{ left: `${position}%` }} />
    <Button type="button" role="slider" aria-label="Version comparison position" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(position)} onKeyDown={(event) => { if (event.key === "ArrowLeft") setPosition((value) => Math.max(0, value - 2)); if (event.key === "ArrowRight") setPosition((value) => Math.min(100, value + 2)); if (event.key === "Home") setPosition(0); if (event.key === "End") setPosition(100); }} variant="ghost" size="icon" className={cn("absolute top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#f5f7fa] text-[#111419] shadow-xl hover:bg-[#f5f7fa]/90")} style={{ left: `${position}%` }}><ChevronsLeftRight className="size-5" /></Button>
    <span className="absolute left-3 top-3 rounded-lg bg-black/70 px-2 py-1 text-xs font-medium text-stage-text">{beforeLabel}</span><span className="absolute right-3 top-3 rounded-lg bg-black/70 px-2 py-1 text-xs font-medium text-stage-text">{afterLabel}</span>
  </div>;
}
