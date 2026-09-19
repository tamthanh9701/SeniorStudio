"use client";

// Foreground matte painting for exact extraction.  Same painter and the same
// pointer-to-image coordinate math as the inpaint `MaskEditor`, but the meaning of
// the byte is inverted: the inpaint editor marks the pixels a provider MAY edit
// (alpha 0), while an extraction matte marks the pixels to KEEP (alpha 255).  The
// two must not share a component - inverting the meaning of a submitted mask is
// exactly the mistake that silently deletes the subject.

import { Eraser, Hand, Maximize, Paintbrush, Redo2, RotateCcw, Trash2, Undo2, ZoomIn, ZoomOut } from "lucide-react";
import Image from "next/image";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

export type MatteStroke = { points: number[]; tool: "remove" | "keep"; width: number };

type Tool = "remove" | "keep" | "pan";
type Point = { x: number; y: number };

const ZOOM_STEP = 1.25;

/**
 * Paints the submitted matte. White (255) keeps a pixel, black (0) removes it.
 * `inverted` swaps both the base fill and what each tool does, exactly like the
 * inpaint editor's invert: the brush then keeps and the eraser removes.
 */
function rasterizeAlpha(strokes: readonly MatteStroke[], inverted: boolean, width: number, height: number): Uint8Array<ArrayBuffer> {
  const alpha = new Uint8Array(width * height);
  alpha.fill(inverted ? 0 : 255);
  for (const stroke of strokes) {
    const keeps = stroke.tool === "keep" !== inverted;
    const value = keeps ? 255 : 0;
    const radius = Math.max(0.5, stroke.width / 2);
    const points = stroke.points;
    if (points.length <= 2) {
      paintDab(alpha, width, height, points[0], points[1], radius, value);
      continue;
    }
    for (let index = 0; index + 3 < points.length; index += 2) {
      paintSegment(alpha, width, height, points[index], points[index + 1], points[index + 2], points[index + 3], radius, value);
    }
  }
  return alpha;
}

/** Only the pixels inside the dab's own box are touched, so a large crop stays cheap. */
function paintDab(alpha: Uint8Array<ArrayBuffer>, width: number, height: number, centerX: number, centerY: number, radius: number, value: number): void {
  const minX = Math.max(0, Math.floor(centerX - radius));
  const maxX = Math.min(width - 1, Math.ceil(centerX + radius));
  const minY = Math.max(0, Math.floor(centerY - radius));
  const maxY = Math.min(height - 1, Math.ceil(centerY + radius));
  const squared = radius * radius;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const dx = x + 0.5 - centerX;
      const dy = y + 0.5 - centerY;
      if (dx * dx + dy * dy <= squared) alpha[y * width + x] = value;
    }
  }
}

function paintSegment(alpha: Uint8Array<ArrayBuffer>, width: number, height: number, x0: number, y0: number, x1: number, y1: number, radius: number, value: number): void {
  paintDab(alpha, width, height, x0, y0, radius, value);
  paintDab(alpha, width, height, x1, y1, radius, value);
  const steps = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / Math.max(1, radius / 2)));
  for (let step = 1; step < steps; step += 1) {
    const ratio = step / steps;
    paintDab(alpha, width, height, x0 + (x1 - x0) * ratio, y0 + (y1 - y0) * ratio, radius, value);
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let first = 1;
  let second = 0;
  for (let index = 0; index < bytes.length; ) {
    const end = Math.min(index + 5552, bytes.length);
    for (; index < end; index += 1) {
      first += bytes[index];
      second += first;
    }
    first %= 65521;
    second %= 65521;
  }
  return ((second << 16) | first) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array([...type].map((character) => character.charCodeAt(0)));
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  // [length 4][type 4][data][crc 4]: `body` already carries the type, so the
  // buffer is the length field plus the body plus the CRC and nothing more.
  const out = new Uint8Array(4 + body.length + 4);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(body, 4);
  view.setUint32(4 + body.length, crc32(body));
  return out;
}

/**
 * RGBA (colour type 6) PNG written by hand.
 *
 * The extraction pipeline reads the matte's alpha channel and refuses a file
 * without one, so the encoder must always emit colour type 6. A canvas round-trip
 * cannot promise that - the browser is free to encode a fully opaque canvas as RGB,
 * which the pipeline would then reject - and it is unavailable where this component
 * is tested. Deflate blocks are stored uncompressed: a matte is a mask, the server
 * recompresses the result anyway, and a wrong bit here would corrupt every export.
 */
function encodeRgbaPng(alpha: Uint8Array<ArrayBuffer>, width: number, height: number): Uint8Array<ArrayBuffer> {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < width; x += 1) {
      const target = rowStart + 1 + x * 4;
      raw[target] = 255;
      raw[target + 1] = 255;
      raw[target + 2] = 255;
      raw[target + 3] = alpha[y * width + x];
    }
  }

  // The zlib stream is written straight into its final buffer: a matte is four
  // bytes per pixel, so an intermediate copy would double the peak memory of a
  // full-screen element.
  const blockCount = Math.max(1, Math.ceil(raw.length / 65535));
  const stream = new Uint8Array(2 + raw.length + blockCount * 5 + 4);
  stream[0] = 0x78;
  stream[1] = 0x01;
  let cursor = 2;
  for (let block = 0; block < blockCount; block += 1) {
    const start = block * 65535;
    const length = Math.min(65535, raw.length - start);
    const finalBlock = block === blockCount - 1;
    stream[cursor] = finalBlock ? 1 : 0;
    stream[cursor + 1] = length & 0xff;
    stream[cursor + 2] = (length >>> 8) & 0xff;
    stream[cursor + 3] = ~length & 0xff;
    stream[cursor + 4] = (~length >>> 8) & 0xff;
    stream.set(raw.subarray(start, start + length), cursor + 5);
    cursor += 5 + length;
  }
  new DataView(stream.buffer).setUint32(cursor, adler32(raw));

  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8;
  header[9] = 6;
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", stream), chunk("IEND", new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

/** The matte a route will accept: 5 MiB is the module's own ceiling for one mask. */
const MAX_MATTE_BYTES = 5 * 1024 * 1024;

export default function ForegroundMaskEditor({
  imageUrl,
  width,
  height,
  onMatteChange,
  minZoom = 0.25,
  maxZoom = 8,
}: {
  imageUrl: string;
  width: number;
  height: number;
  onMatteChange: (mattePng: Uint8Array<ArrayBuffer> | null) => void;
  minZoom?: number;
  maxZoom?: number;
}) {
  // The generated id can contain characters that a CSS url(#…) reference cannot
  // carry, so only identifier-safe characters reach the SVG mask.
  const maskId = `matte-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const checkerId = `${maskId}-checker`;
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ mode: "stroke" | "pan"; start: Point; origin: Point } | null>(null);
  const draftRef = useRef<MatteStroke | null>(null);
  const onMatteChangeRef = useRef(onMatteChange);
  useEffect(() => {
    onMatteChangeRef.current = onMatteChange;
  }, [onMatteChange]);

  const [tool, setTool] = useState<Tool>("remove");
  const [brushSize, setBrushSize] = useState(40);
  const [strokes, setStrokes] = useState<MatteStroke[]>([]);
  const [redoStrokes, setRedoStrokes] = useState<MatteStroke[]>([]);
  const [draft, setDraft] = useState<MatteStroke | null>(null);
  const [inverted, setInverted] = useState(false);
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const [counts, setCounts] = useState({ kept: width * height, removed: 0 });
  const [tooLarge, setTooLarge] = useState(false);

  // One submission-ready matte per completed action. Zoom and pan stay out of this
  // dependency set: neither changes a pixel of the mask.
  useEffect(() => {
    const alpha = rasterizeAlpha(strokes, inverted, width, height);
    let kept = 0;
    let removed = 0;
    for (let index = 0; index < alpha.length; index += 1) {
      if (alpha[index] > 0) kept += 1;
      if (alpha[index] < 255) removed += 1;
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the counts summarize an allocated buffer, they cannot be derived during render
    setCounts({ kept, removed });
    if (kept === 0) {
      setTooLarge(false);
      onMatteChangeRef.current(null);
      return;
    }
    const png = encodeRgbaPng(alpha, width, height);
    setTooLarge(png.byteLength > MAX_MATTE_BYTES);
    onMatteChangeRef.current(png);
  }, [height, inverted, strokes, width]);

  const pointFor = (event: { clientX: number; clientY: number }): Point | null => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return { x: (event.clientX - rect.left - view.x) / view.zoom, y: (event.clientY - rect.top - view.y) / view.zoom };
  };

  const begin = (event: React.PointerEvent<HTMLDivElement>) => {
    const point = pointFor(event);
    if (!point) return;
    if (tool === "pan") {
      dragRef.current = { mode: "pan", start: { x: event.clientX, y: event.clientY }, origin: { x: view.x, y: view.y } };
      return;
    }
    const target = event.currentTarget;
    if (typeof target.setPointerCapture === "function") {
      try { target.setPointerCapture(event.pointerId); } catch { /* capture is an optimization, not a requirement */ }
    }
    dragRef.current = { mode: "stroke", start: point, origin: point };
    setRedoStrokes([]);
    const stroke: MatteStroke = { points: [point.x, point.y], tool, width: brushSize };
    draftRef.current = stroke;
    setDraft(stroke);
  };

  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    if (drag.mode === "pan") {
      setView((current) => ({ ...current, x: drag.origin.x + (event.clientX - drag.start.x), y: drag.origin.y + (event.clientY - drag.start.y) }));
      return;
    }
    const point = pointFor(event);
    const stroke = draftRef.current;
    if (!point || !stroke) return;
    const next: MatteStroke = { ...stroke, points: [...stroke.points, point.x, point.y] };
    draftRef.current = next;
    setDraft(next);
  };

  const end = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (drag?.mode !== "stroke") return;
    const finished = draftRef.current;
    draftRef.current = null;
    setDraft(null);
    if (finished) setStrokes((current) => [...current, finished]);
  };

  const zoomTo = (nextZoom: number) => {
    setView((current) => ({ ...current, zoom: Math.min(maxZoom, Math.max(minZoom, nextZoom)) }));
  };

  const empty = counts.removed === 0;
  const everything = counts.kept === 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup type="single" value={tool} onValueChange={(value) => { if (value) setTool(value as Tool); }} aria-label="Matte tool" className="flex shrink-0 rounded-xl bg-accent p-1">
          <ToggleGroupItem value="remove" aria-label="Remove brush" className="h-11 gap-2 rounded-lg px-3 text-xs text-muted-foreground data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
            <Paintbrush className="size-4" aria-hidden /> <span className="hidden sm:inline">Remove</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="keep" aria-label="Restore brush" className="h-11 gap-2 rounded-lg px-3 text-xs text-muted-foreground data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
            <Eraser className="size-4" aria-hidden /> <span className="hidden sm:inline">Restore</span>
          </ToggleGroupItem>
          <ToggleGroupItem value="pan" aria-label="Pan tool" className="h-11 gap-2 rounded-lg px-3 text-xs text-muted-foreground data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
            <Hand className="size-4" aria-hidden /> <span className="hidden sm:inline">Pan</span>
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
          <span>Brush</span>
          <Slider id="matte-brush-size" className="h-11 w-24" aria-label="Brush size" aria-valuetext={`${brushSize} pixels`} min={5} max={200} step={1} value={[brushSize]} onValueChange={([value]) => setBrushSize(value)} />
          <span className="w-10 text-right">{brushSize}px</span>
        </div>
        <div className="flex shrink-0 items-center gap-1" role="group" aria-label="Stroke history">
          <Button type="button" variant="outline" size="icon-sm" disabled={strokes.length === 0} aria-label="Undo stroke" onClick={() => { const last = strokes.at(-1); if (!last) return; setStrokes(strokes.slice(0, -1)); setRedoStrokes([...redoStrokes, last]); }}>
            <Undo2 className="size-4" aria-hidden />
          </Button>
          <Button type="button" variant="outline" size="icon-sm" disabled={redoStrokes.length === 0} aria-label="Redo stroke" onClick={() => { const last = redoStrokes.at(-1); if (!last) return; setStrokes([...strokes, last]); setRedoStrokes(redoStrokes.slice(0, -1)); }}>
            <Redo2 className="size-4" aria-hidden />
          </Button>
          <Button type="button" variant="outline" size="icon-sm" disabled={strokes.length === 0 && !inverted} aria-label="Clear mask" onClick={() => { draftRef.current = null; setDraft(null); setStrokes([]); setRedoStrokes([]); setInverted(false); }}>
            <Trash2 className="size-4" aria-hidden />
          </Button>
          <Button type="button" variant="outline" size="sm" aria-pressed={inverted} aria-label="Invert matte" onClick={() => setInverted((value) => !value)}>
            <RotateCcw className="size-4" aria-hidden /> {inverted ? "Normal" : "Invert"}
          </Button>
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1" role="group" aria-label="Zoom controls">
          <Button type="button" variant="outline" size="icon-sm" aria-label="Fit crop to view" onClick={() => setView({ zoom: 1, x: 0, y: 0 })}>
            <Maximize className="size-4" aria-hidden />
          </Button>
          <Button type="button" variant="outline" size="icon-sm" aria-label="Zoom out" disabled={view.zoom <= minZoom} onClick={() => zoomTo(view.zoom / ZOOM_STEP)}>
            <ZoomOut className="size-4" aria-hidden />
          </Button>
          <Button type="button" variant="outline" size="icon-sm" aria-label="Zoom in" disabled={view.zoom >= maxZoom} onClick={() => zoomTo(view.zoom * ZOOM_STEP)}>
            <ZoomIn className="size-4" aria-hidden />
          </Button>
          <span className="w-12 text-right text-xs text-muted-foreground">{Math.round(view.zoom * 100)}%</span>
        </div>
      </div>

      <div
        ref={surfaceRef}
        role="application"
        aria-label="Foreground mask surface"
        className="checker-stage relative h-72 touch-none overflow-hidden rounded-lg border border-border"
        onPointerDown={begin}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
      >
        <div className="absolute left-0 top-0 origin-top-left" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
          <div className="relative" style={{ width, height }}>
            <Image src={imageUrl} alt="Element crop" width={width} height={height} className="absolute left-0 top-0" style={{ width, height }} unoptimized />
            <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} className="pointer-events-none absolute left-0 top-0" aria-hidden>
              <defs>
                <mask id={maskId}>
                  <rect x={0} y={0} width={width} height={height} fill={inverted ? "#ffffff" : "#000000"} />
                  {[...strokes, ...(draft ? [draft] : [])].map((stroke, index) => {
                    // White shows the tint, so a stroke that removes pixels is white
                    // and the base rect follows `inverted` the same way.
                    const fill = (stroke.tool === "remove") !== inverted ? "#ffffff" : "#000000";
                    return stroke.points.length <= 2 ? (
                      <circle key={index} cx={stroke.points[0]} cy={stroke.points[1]} r={stroke.width / 2} fill={fill} />
                    ) : (
                      <polyline
                        key={index}
                        points={Array.from({ length: stroke.points.length / 2 }, (_, point) => `${stroke.points[point * 2]},${stroke.points[point * 2 + 1]}`).join(" ")}
                        fill="none"
                        stroke={fill}
                        strokeWidth={stroke.width}
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    );
                  })}
                </mask>
                {/* Removed pixels are shown as the transparency they will become, so
                    the checkerboard reads as "these pixels are not in the export". */}
                <pattern id={checkerId} width={16} height={16} patternUnits="userSpaceOnUse">
                  <rect width={16} height={16} fill="rgb(17,24,39)" />
                  <rect width={8} height={8} fill="rgb(148,163,184)" />
                  <rect x={8} y={8} width={8} height={8} fill="rgb(148,163,184)" />
                </pattern>
              </defs>
              <rect x={0} y={0} width={width} height={height} fill={`url(#${checkerId})`} mask={`url(#${maskId})`} />
            </svg>
          </div>
        </div>
      </div>

      <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
        {everything
          ? "Everything is removed: there are no pixels left to keep. Paint the parts you want back with Restore."
          : empty
            ? "Nothing is removed yet — the crop keeps its background until you paint over the parts to remove. Painted pixels show as a checkerboard: those are the ones that will be transparent."
            : `Removed ${counts.removed.toLocaleString()} of ${(width * height).toLocaleString()} pixels (${Math.round((counts.removed / (width * height)) * 100)}%). Kept pixels come from the original image unchanged.`}
        {inverted ? " Inverted: the brush now keeps pixels and Restore removes them." : ""}
      </p>
      {tooLarge && (
        <p role="alert" className="text-xs text-warning">
          This matte is larger than the 5 MB limit for one mask. Mask a smaller element, or reduce the element box before extracting.
        </p>
      )}
    </div>
  );
}
