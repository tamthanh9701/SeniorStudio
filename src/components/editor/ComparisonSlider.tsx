"use client";

import { ChevronsLeftRight } from "lucide-react";
import { useRef, useState } from "react";

export default function ComparisonSlider({ beforeUrl, afterUrl, width, height }: { beforeUrl: string; afterUrl: string; width: number; height: number }) {
  const [position, setPosition] = useState(50);
  const containerRef = useRef<HTMLDivElement>(null);
  const update = (clientX: number) => { const rect = containerRef.current?.getBoundingClientRect(); if (!rect) return; setPosition(Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100))); };
  return <div ref={containerRef} className="relative mx-auto w-full max-w-full touch-none overflow-hidden rounded-2xl border border-white/10 bg-black" style={{ aspectRatio: `${width} / ${height}` }} onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); update(event.clientX); }} onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) update(event.clientX); }}>
    <img src={afterUrl} alt="Current version" className="absolute inset-0 h-full w-full object-contain" draggable={false} />
    <img src={beforeUrl} alt="Parent version" className="absolute inset-0 h-full w-full object-contain" style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }} draggable={false} />
    <div className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow" style={{ left: `${position}%` }} />
    <button type="button" role="slider" aria-label="Version comparison position" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(position)} onKeyDown={(event) => { if (event.key === "ArrowLeft") setPosition((value) => Math.max(0, value - 2)); if (event.key === "ArrowRight") setPosition((value) => Math.min(100, value + 2)); if (event.key === "Home") setPosition(0); if (event.key === "End") setPosition(100); }} className="absolute top-1/2 flex size-11 min-h-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/20 bg-[#f5f7fa] text-[#111419] shadow-xl" style={{ left: `${position}%` }}><ChevronsLeftRight className="size-5" /></button>
    <span className="absolute left-3 top-3 rounded-lg bg-black/65 px-2 py-1 text-xs">Parent</span><span className="absolute right-3 top-3 rounded-lg bg-black/65 px-2 py-1 text-xs">Current</span>
  </div>;
}
