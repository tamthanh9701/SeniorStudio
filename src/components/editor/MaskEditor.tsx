"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eraser, Hand, LoaderCircle, Maximize, Paintbrush, Redo2, RefreshCw, RotateCcw, Trash2, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import { Stage, Layer, Circle, Image as KonvaImage, Line } from "react-konva";
import type Konva from "konva";

type MaskStroke = { points: number[]; tool: "brush" | "eraser"; width: number };
type Tool = "brush" | "eraser" | "pan";
type Point = { x: number; y: number };
type Drag = { mode: "stroke" | "pan"; start: Point; origin: Point };

const ZOOM_STEP = 1.25;
const FALLBACK_ACCENT = "rgba(255, 255, 255, 1)";

function accentFromTheme(): string {
  if (typeof window === "undefined") return FALLBACK_ACCENT;
  const value = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim();
  return value.length > 0 ? value : FALLBACK_ACCENT;
}

/**
 * Paints the submitted mask: alpha 0 marks pixels the provider may edit and
 * alpha 255 protects them. Every export and every preview goes through this
 * function so the overlay can never disagree with the uploaded PNG.
 */
function paintMask(canvas: HTMLCanvasElement, strokes: readonly MaskStroke[], inverted: boolean, width: number, height: number): boolean {
  const context = canvas.getContext("2d");
  if (!context) return false;
  context.globalCompositeOperation = "source-over";
  context.clearRect(0, 0, width, height);
  context.fillStyle = inverted ? "rgba(255, 255, 255, 0)" : "rgba(255, 255, 255, 255)";
  context.fillRect(0, 0, width, height);
  context.strokeStyle = "rgba(255, 255, 255, 255)";
  context.fillStyle = "rgba(255, 255, 255, 255)";
  context.lineCap = "round";
  context.lineJoin = "round";
  for (const stroke of strokes) {
    context.globalCompositeOperation = (stroke.tool === "brush" ? !inverted : inverted) ? "destination-out" : "source-over";
    context.lineWidth = stroke.width;
    if (stroke.points.length <= 2) {
      // A tap carries no path length, so it is painted as one round dab.
      context.beginPath();
      context.arc(stroke.points[0], stroke.points[1], stroke.width / 2, 0, Math.PI * 2);
      context.fill();
      continue;
    }
    context.beginPath();
    context.moveTo(stroke.points[0], stroke.points[1]);
    for (let index = 2; index < stroke.points.length; index += 2) context.lineTo(stroke.points[index], stroke.points[index + 1]);
    context.stroke();
  }
  context.globalCompositeOperation = "source-over";
  return true;
}

/** True while at least one pixel is still editable, i.e. the mask is worth submitting. */
function hasEditablePixels(canvas: HTMLCanvasElement): boolean {
  const context = canvas.getContext("2d");
  if (!context) return false;
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
  for (let index = 3; index < data.length; index += 4) if (data[index] < 255) return true;
  return false;
}

/** Tints the editable region by punching the submitted mask out of a solid fill. */
function paintOverlay(canvas: HTMLCanvasElement, mask: HTMLCanvasElement, accent: string): boolean {
  const context = canvas.getContext("2d");
  if (!context) return false;
  context.globalCompositeOperation = "source-over";
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = accent;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.globalCompositeOperation = "destination-out";
  context.drawImage(mask, 0, 0);
  context.globalCompositeOperation = "source-over";
  return true;
}

export default function MaskEditor({
  imageUrl,
  width,
  height,
  onMaskChange,
  onDirty,
  minZoom = 0.25,
  maxZoom = 4,
}: {
  imageUrl: string;
  width: number;
  height: number;
  onMaskChange: (maskPng: string | null) => void;
  onDirty?: () => void;
  minZoom?: number;
  maxZoom?: number;
}) {
  const lowestZoom = Math.max(0.01, minZoom);
  const highestZoom = Math.max(lowestZoom, maxZoom);
  const stageAreaRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<Drag | null>(null);
  const draftRef = useRef<MaskStroke | null>(null);
  const onMaskChangeRef = useRef(onMaskChange);
  useEffect(() => { onMaskChangeRef.current = onMaskChange; });

  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [imageFailed, setImageFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [accent, setAccent] = useState(FALLBACK_ACCENT);
  const [brushSize, setBrushSize] = useState(40);
  const [tool, setTool] = useState<Tool>("brush");
  const [strokes, setStrokes] = useState<MaskStroke[]>([]);
  const [redoStrokes, setRedoStrokes] = useState<MaskStroke[]>([]);
  const [draft, setDraft] = useState<MaskStroke | null>(null);
  const [inverted, setInverted] = useState(false);
  const [overlay, setOverlay] = useState<HTMLCanvasElement | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [viewport, setViewport] = useState({ width: Math.min(width, 760), height: Math.min(height, 760) });
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });

  useEffect(() => { setAccent(accentFromTheme()); }, []);

  useEffect(() => {
    setImage(null);
    setImageFailed(false);
    const loaded = new window.Image();
    loaded.crossOrigin = "anonymous";
    loaded.onload = () => { setImage(loaded); setImageFailed(false); };
    loaded.onerror = () => { setImage(null); setImageFailed(true); };
    loaded.src = imageUrl;
    return () => { loaded.onload = null; loaded.onerror = null; };
  }, [attempt, imageUrl]);

  useEffect(() => {
    const element = stageAreaRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const scale = Math.min(1, entry.contentRect.width / width, entry.contentRect.height / height);
      setViewport({ width: Math.max(1, width * scale), height: Math.max(1, height * scale) });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [height, width]);

  // Automatic export: one submission-ready mask per completed action, never
  // during pointer movement. Zoom and pan are not part of this dependency set.
  useEffect(() => {
    const mask = document.createElement("canvas");
    mask.width = width;
    mask.height = height;
    if (!paintMask(mask, strokes, inverted, width, height)) return;
    const editable = hasEditablePixels(mask);
    const tint = document.createElement("canvas");
    tint.width = width;
    tint.height = height;
    setOverlay(editable && paintOverlay(tint, mask, accent) ? tint : null);
    onMaskChangeRef.current(editable ? mask.toDataURL("image/png") : null);
  }, [accent, height, inverted, strokes, width]);

  const fitScale = Math.max(0.0001, viewport.width / width);
  const stageScale = fitScale * view.zoom;
  const zoomPercent = Math.round(stageScale * 100);
  const hundredZoom = 1 / fitScale;
  const maskReady = overlay !== null;

  const offset = useMemo(() => {
    const scaledWidth = width * stageScale;
    const scaledHeight = height * stageScale;
    const spanX = scaledWidth - viewport.width;
    const spanY = scaledHeight - viewport.height;
    return {
      x: spanX <= 0 ? (viewport.width - scaledWidth) / 2 : Math.min(0, Math.max(-spanX, view.x)),
      y: spanY <= 0 ? (viewport.height - scaledHeight) / 2 : Math.min(0, Math.max(-spanY, view.y)),
    };
  }, [height, stageScale, view.x, view.y, viewport.height, viewport.width, width]);

  const zoomTo = useCallback((nextZoom: number) => {
    const zoom = Math.min(highestZoom, Math.max(lowestZoom, nextZoom));
    setView((current) => {
      const currentScale = Math.max(0.0001, fitScale * current.zoom);
      const nextScale = fitScale * zoom;
      const centerX = viewport.width / 2;
      const centerY = viewport.height / 2;
      const imageX = (centerX - offset.x) / currentScale;
      const imageY = (centerY - offset.y) / currentScale;
      return { zoom, x: centerX - imageX * nextScale, y: centerY - imageY * nextScale };
    });
  }, [fitScale, highestZoom, lowestZoom, offset.x, offset.y, viewport.height, viewport.width]);

  const begin = useCallback((event: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    const stage = event.target?.getStage?.() ?? null;
    const position = stage?.getPointerPosition();
    if (!position) return;
    if (tool === "pan") {
      dragRef.current = { mode: "pan", start: { x: position.x, y: position.y }, origin: { x: offset.x, y: offset.y } };
      return;
    }
    if (!image) return;
    const point = { x: (position.x - offset.x) / stageScale, y: (position.y - offset.y) / stageScale };
    dragRef.current = { mode: "stroke", start: point, origin: point };
    setRedoStrokes([]);
    const stroke: MaskStroke = { points: [point.x, point.y], tool: tool === "eraser" ? "eraser" : "brush", width: brushSize };
    draftRef.current = stroke;
    setDraft(stroke);
  }, [brushSize, image, offset.x, offset.y, stageScale, tool]);

  const move = useCallback((event: Konva.KonvaEventObject<MouseEvent | TouchEvent>) => {
    const stage = event.target?.getStage?.() ?? null;
    const position = stage?.getPointerPosition();
    if (!position) return;
    const drag = dragRef.current;
    if (drag?.mode === "pan") {
      setView((current) => ({ ...current, x: drag.origin.x + (position.x - drag.start.x), y: drag.origin.y + (position.y - drag.start.y) }));
      return;
    }
    const point = { x: (position.x - offset.x) / stageScale, y: (position.y - offset.y) / stageScale };
    setCursor(point);
    if (drag?.mode !== "stroke") return;
    const stroke = draftRef.current;
    if (!stroke) return;
    const next: MaskStroke = { ...stroke, points: [...stroke.points, point.x, point.y] };
    draftRef.current = next;
    setDraft(next);
  }, [offset.x, offset.y, stageScale]);

  const end = useCallback(() => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.mode !== "stroke") return;
    const finished = draftRef.current;
    draftRef.current = null;
    setDraft(null);
    if (!finished) return;
    setStrokes((current) => [...current, finished]);
    onDirty?.();
  }, [onDirty]);

  const undo = () => {
    const last = strokes.at(-1);
    if (!last) return;
    setStrokes(strokes.slice(0, -1));
    setRedoStrokes([...redoStrokes, last]);
    onDirty?.();
  };

  const redo = () => {
    const last = redoStrokes.at(-1);
    if (!last) return;
    setStrokes([...strokes, last]);
    setRedoStrokes(redoStrokes.slice(0, -1));
    onDirty?.();
  };

  const clear = () => {
    draftRef.current = null;
    setDraft(null);
    setStrokes([]);
    setRedoStrokes([]);
    setInverted(false);
    onDirty?.();
  };

  const toggleInverted = () => { setInverted((value) => !value); onDirty?.(); };

  return <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--canvas)]">
    <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-[var(--border)] bg-[var(--panel)] p-3">
      <div className="flex shrink-0 rounded-xl bg-[var(--surface-hover)] p-1" role="group" aria-label="Mask tool">
        <button type="button" aria-pressed={tool === "brush"} aria-label="Brush tool" onClick={() => setTool("brush")} className={`flex min-h-11 items-center gap-2 rounded-lg px-3 text-xs ${tool === "brush" ? "bg-[var(--accent)] text-white" : "text-[var(--muted)]"}`}><Paintbrush className="size-4" /><span className="hidden sm:inline">Brush</span></button>
        <button type="button" aria-pressed={tool === "eraser"} aria-label="Restore tool" onClick={() => setTool("eraser")} className={`flex min-h-11 items-center gap-2 rounded-lg px-3 text-xs ${tool === "eraser" ? "bg-[var(--accent)] text-white" : "text-[var(--muted)]"}`}><Eraser className="size-4" /><span className="hidden sm:inline">Restore</span></button>
        <button type="button" aria-pressed={tool === "pan"} aria-label="Pan tool" onClick={() => setTool("pan")} className={`flex min-h-11 items-center gap-2 rounded-lg px-3 text-xs ${tool === "pan" ? "bg-[var(--accent)] text-white" : "text-[var(--muted)]"}`}><Hand className="size-4" /><span className="hidden sm:inline">Pan</span></button>
      </div>
      <label className="flex shrink-0 items-center gap-2 text-xs text-[var(--muted)]" htmlFor="mask-brush-size">Brush <input id="mask-brush-size" className="min-h-11" aria-valuetext={`${brushSize} pixels`} type="range" min="5" max="200" value={brushSize} onChange={(event) => setBrushSize(Number(event.target.value))} /><span className="w-10 text-right">{brushSize}px</span></label>
      <div className="ml-auto flex shrink-0 items-center gap-1" role="group" aria-label="Stroke history">
        <button type="button" className="studio-icon-button" disabled={!strokes.length} onClick={undo} aria-label="Undo stroke"><Undo2 className="size-4" /></button>
        <button type="button" className="studio-icon-button" disabled={!redoStrokes.length} onClick={redo} aria-label="Redo stroke"><Redo2 className="size-4" /></button>
        <button type="button" className="studio-icon-button" disabled={!strokes.length && !inverted} onClick={clear} aria-label="Clear mask"><Trash2 className="size-4" /></button>
        <button type="button" onClick={toggleInverted} aria-pressed={inverted} className="studio-button-secondary px-3 text-xs" aria-label="Invert editable area"><RotateCcw className="size-4" />{inverted ? "Normal" : "Invert"}</button>
      </div>
      <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Zoom controls">
        <button type="button" onClick={() => setView({ zoom: 1, x: 0, y: 0 })} aria-pressed={view.zoom === 1} aria-label="Fit image to view" className="studio-icon-button"><Maximize className="size-4" /></button>
        <button type="button" onClick={() => zoomTo(hundredZoom)} aria-pressed={Math.abs(stageScale - 1) < 0.001} aria-label={hundredZoom > highestZoom ? `Zoom to 100 percent unavailable, this image exceeds the ${highestZoom}× zoom limit` : "Zoom to 100 percent"} disabled={hundredZoom > highestZoom} title={hundredZoom > highestZoom ? `This image needs ${Math.round(hundredZoom * 10) / 10}× fit scale to show every pixel, beyond the ${highestZoom}× limit` : "View at 100%"} className="studio-icon-button text-[11px] font-semibold"><span>100%</span></button>
        <button type="button" onClick={() => zoomTo(view.zoom / ZOOM_STEP)} disabled={view.zoom <= lowestZoom} aria-label="Zoom out" className="studio-icon-button"><ZoomOut className="size-4" /></button>
        <button type="button" onClick={() => zoomTo(view.zoom * ZOOM_STEP)} disabled={view.zoom >= highestZoom} aria-label="Zoom in" className="studio-icon-button"><ZoomIn className="size-4" /></button>
        <span className="w-12 text-right text-xs text-[var(--muted)]">{zoomPercent}%</span>
      </div>
    </div>
    <div ref={stageAreaRef} className="checker-stage relative flex min-h-0 flex-1 touch-none items-center justify-center overflow-hidden p-3">
      {imageFailed ? (
        <div role="alert" className="studio-card flex max-w-sm flex-col items-center gap-3 p-6 text-center">
          <p className="text-sm text-[var(--text)]">The image could not be loaded, so the edit area cannot be painted.</p>
          <button type="button" onClick={() => setAttempt((value) => value + 1)} className="studio-button-secondary"><RefreshCw className="size-4" />Retry</button>
        </div>
      ) : !image ? (
        <p role="status" className="flex items-center gap-2 text-sm text-[var(--muted)]"><LoaderCircle className="size-4 animate-spin" />Loading image…</p>
      ) : (
        <Stage
          width={viewport.width}
          height={viewport.height}
          style={{ cursor: tool === "pan" ? "grab" : "crosshair" }}
          onMouseDown={begin}
          onMouseMove={move}
          onMouseUp={end}
          onMouseLeave={() => { end(); setCursor(null); }}
          onTouchStart={begin}
          onTouchMove={move}
          onTouchEnd={end}
        >
          <Layer x={offset.x} y={offset.y} scaleX={stageScale} scaleY={stageScale}>
            <KonvaImage image={image} width={width} height={height} listening={false} />
            {overlay && <KonvaImage image={overlay} width={width} height={height} opacity={0.45} listening={false} />}
            {draft && (draft.points.length <= 2
              ? <Circle x={draft.points[0]} y={draft.points[1]} radius={draft.width / 2} stroke={accent} strokeWidth={2 / stageScale} dash={[6 / stageScale, 6 / stageScale]} opacity={0.9} listening={false} />
              : <Line points={draft.points} stroke={accent} strokeWidth={draft.width} lineCap="round" lineJoin="round" opacity={0.45} listening={false} />)}
            {cursor && tool !== "pan" && <Circle x={cursor.x} y={cursor.y} radius={brushSize / 2} stroke="white" strokeWidth={2 / stageScale} listening={false} />}
          </Layer>
        </Stage>
      )}
    </div>
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--border)] bg-[var(--panel)] p-3">
      <span role="status" className={`text-xs ${maskReady ? "text-[var(--success)]" : "text-[var(--muted)]"}`}>{maskReady ? `Mask ready · ${strokes.length} stroke${strokes.length === 1 ? "" : "s"} · exported automatically` : "Paint at least one edit region"}</span>
      <span className="text-xs text-[var(--muted)]">{inverted ? "Inverted · the untouched area is edited" : "Painted area is edited"}</span>
    </div>
  </div>;
}
