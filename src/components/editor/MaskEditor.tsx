"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Eraser, Paintbrush, Redo2, RotateCcw, Trash2, Undo2 } from "lucide-react";
import { Stage, Layer, Image as KonvaImage, Line, Circle } from "react-konva";
import type Konva from "konva";

type MaskLine = { points: number[]; tool: "brush" | "eraser"; width: number };

export default function MaskEditor({ imageUrl, width, height, onMaskChange }: { imageUrl: string; width: number; height: number; onMaskChange: (maskPng: string | null) => void }) {
  const stageAreaRef = useRef<HTMLDivElement>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [brushSize, setBrushSize] = useState(40);
  const [isDrawing, setIsDrawing] = useState(false);
  const [lines, setLines] = useState<MaskLine[]>([]);
  const [redo, setRedo] = useState<MaskLine[]>([]);
  const [tool, setTool] = useState<"brush" | "eraser">("brush");
  const [inverted, setInverted] = useState(false);
  const [display, setDisplay] = useState({ width: Math.min(width, 760), height: Math.min(height, 760) });
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => { const loaded = new window.Image(); loaded.crossOrigin = "anonymous"; loaded.onload = () => setImage(loaded); loaded.src = imageUrl; }, [imageUrl]);
  useEffect(() => {
    const element = stageAreaRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const scale = Math.min(1, entry.contentRect.width / width, entry.contentRect.height / height);
      setDisplay({ width: Math.max(1, width * scale), height: Math.max(1, height * scale) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [height, width]);

  const scale = display.width / width;
  const begin = useCallback((event: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    const position = event.target.getStage()?.getPointerPosition();
    if (!position) return;
    setIsDrawing(true);
    setRedo([]);
    setLines((current) => [...current, { points: [position.x / scale, position.y / scale], tool, width: brushSize }]);
  }, [brushSize, scale, tool]);
  const draw = useCallback((event: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    const position = event.target.getStage()?.getPointerPosition();
    if (!position) return;
    setCursor({ x: position.x / scale, y: position.y / scale });
    if (!isDrawing) return;
    setLines((current) => current.map((line, index) => index === current.length - 1 ? { ...line, points: [...line.points, position.x / scale, position.y / scale] } : line));
  }, [isDrawing, scale]);
  const clear = () => { setLines([]); setRedo([]); setInverted(false); onMaskChange(null); };
  const exportMask = useCallback(() => {
    if (!lines.length) return;
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.clearRect(0, 0, width, height);
    context.fillStyle = inverted ? "rgba(255,255,255,0)" : "rgba(255,255,255,255)";
    context.fillRect(0, 0, width, height);
    for (const line of lines) {
      context.globalCompositeOperation = (line.tool === "brush" ? !inverted : inverted) ? "destination-out" : "source-over";
      context.strokeStyle = "rgba(255,255,255,255)";
      context.lineWidth = line.width;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.beginPath();
      context.moveTo(line.points[0], line.points[1]);
      for (let index = 2; index < line.points.length; index += 2) context.lineTo(line.points[index], line.points[index + 1]);
      context.stroke();
    }
    context.globalCompositeOperation = "source-over";
    onMaskChange(canvas.toDataURL("image/png"));
  }, [height, inverted, lines, onMaskChange, width]);

  return <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[#0b0d10]">
    <div className="flex flex-wrap items-center gap-2 border-b border-white/10 bg-[#111419] p-3">
      <div className="flex rounded-xl bg-white/[0.045] p-1"><button onClick={() => setTool("brush")} className={`flex min-h-9 items-center gap-2 rounded-lg px-3 text-xs ${tool === "brush" ? "bg-[#7c5cff] text-white" : "text-[#98a2b3]"}`}><Paintbrush className="size-3.5" />Brush</button><button onClick={() => setTool("eraser")} className={`flex min-h-9 items-center gap-2 rounded-lg px-3 text-xs ${tool === "eraser" ? "bg-[#7c5cff] text-white" : "text-[#98a2b3]"}`}><Eraser className="size-3.5" />Restore</button></div>
      <button className="studio-icon-button size-9 min-h-9" disabled={!lines.length} onClick={() => setLines((current) => { const last = current.at(-1); if (last) setRedo((items) => [...items, last]); return current.slice(0, -1); })} aria-label="Undo stroke"><Undo2 className="size-4" /></button>
      <button className="studio-icon-button size-9 min-h-9" disabled={!redo.length} onClick={() => setRedo((current) => { const last = current.at(-1); if (last) setLines((items) => [...items, last]); return current.slice(0, -1); })} aria-label="Redo stroke"><Redo2 className="size-4" /></button>
      <label className="ml-auto flex items-center gap-2 text-xs text-[#98a2b3]">Brush <input type="range" min="5" max="200" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} /><span className="w-10 text-right">{brushSize}px</span></label>
      <button onClick={() => setInverted((value) => !value)} className="studio-button-secondary min-h-9 px-3 py-1 text-xs"><RotateCcw className="size-3.5" />{inverted ? "Normal" : "Invert"}</button>
      <button onClick={clear} disabled={!lines.length} className="studio-icon-button size-9 min-h-9" aria-label="Clear mask"><Trash2 className="size-4" /></button>
    </div>
    <div ref={stageAreaRef} className="checker-stage flex min-h-0 flex-1 items-center justify-center overflow-hidden p-3">
      <Stage width={display.width} height={display.height} scaleX={scale} scaleY={scale} onMouseDown={begin} onMouseMove={draw} onMouseUp={() => setIsDrawing(false)} onMouseLeave={() => { setIsDrawing(false); setCursor(null); }} onTouchStart={begin} onTouchMove={draw} onTouchEnd={() => setIsDrawing(false)}>
        <Layer>{image && <KonvaImage image={image} width={width} height={height} />}{lines.map((line, index) => <Line key={index} points={line.points} stroke={line.tool === "brush" ? "rgba(124,92,255,.7)" : "rgba(239,98,98,.65)"} strokeWidth={line.width} lineCap="round" lineJoin="round" />)}{cursor && <Circle x={cursor.x} y={cursor.y} radius={brushSize / 2} stroke="white" strokeWidth={2 / scale} listening={false} />}</Layer>
      </Stage>
    </div>
    <div className="flex items-center justify-between border-t border-white/10 bg-[#111419] p-3"><span className={`text-xs ${lines.length ? "text-[#f2b84b]" : "text-[#667085]"}`}>{lines.length ? `Unsaved mask · ${lines.length} stroke${lines.length === 1 ? "" : "s"}` : "Paint at least one edit region"}</span><button onClick={exportMask} disabled={!lines.length} className="studio-button-primary">Apply mask</button></div>
  </div>;
}
