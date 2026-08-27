"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import { Stage, Layer, Image as KonvaImage, Rect, Line, Transformer } from "react-konva";
import type Konva from "konva";

interface MaskEditorProps {
  imageUrl: string;
  width: number;
  height: number;
  onMaskChange: (maskPng: string | null) => void;
}

export default function MaskEditor({ imageUrl, width, height, onMaskChange }: MaskEditorProps) {
  const stageRef = useRef<Konva.Stage>(null);
  const layerRef = useRef<Konva.Layer>(null);
  const [image, setImage] = useState<HTMLImageElement | null>(null);
  const [brushSize, setBrushSize] = useState(20);
  const [isDrawing, setIsDrawing] = useState(false);
  const [lines, setLines] = useState<Array<{ points: number[]; tool: string }>>([]);
  const [tool, setTool] = useState<"brush" | "eraser">("brush");

  useEffect(() => {
    const img = new window.Image();
    img.crossOrigin = "anonymous";
    img.onload = () => setImage(img);
    img.src = imageUrl;
  }, [imageUrl]);

  const handleMouseDown = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    if (tool !== "brush" && tool !== "eraser") return;
    setIsDrawing(true);
    const pos = e.target.getStage()?.getPointerPosition();
    if (pos) {
      setLines([...lines, { points: [pos.x, pos.y], tool }]);
    }
  }, [tool, lines]);

  const handleMouseMove = useCallback((e: Konva.KonvaEventObject<MouseEvent>) => {
    if (!isDrawing) return;
    const pos = e.target.getStage()?.getPointerPosition();
    if (pos) {
      const lastLine = lines[lines.length - 1];
      if (lastLine) {
        lastLine.points = lastLine.points.concat([pos.x, pos.y]);
        setLines([...lines]);
      }
    }
  }, [isDrawing, lines]);

  const handleMouseUp = useCallback(() => {
    setIsDrawing(false);
  }, []);

  const clearMask = useCallback(() => {
    setLines([]);
    onMaskChange(null);
  }, [onMaskChange]);

  const invertMask = useCallback(() => {
    // TODO: Implement mask inversion
  }, []);

  const exportMask = useCallback(() => {
    if (!stageRef.current) return;

    // Create a temporary canvas for mask export
    const maskCanvas = document.createElement("canvas");
    maskCanvas.width = width;
    maskCanvas.height = height;
    const ctx = maskCanvas.getContext("2d");
    if (!ctx) return;

    // Draw mask lines
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, width, height);

    lines.forEach((line) => {
      ctx.strokeStyle = line.tool === "eraser" ? "black" : "white";
      ctx.lineWidth = brushSize;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(line.points[0], line.points[1]);
      for (let i = 2; i < line.points.length; i += 2) {
        ctx.lineTo(line.points[i], line.points[i + 1]);
      }
      ctx.stroke();
    });

    // Convert to base64 PNG
    const maskPng = maskCanvas.toDataURL("image/png").split(",")[1];
    onMaskChange(maskPng);
  }, [lines, width, height, brushSize, onMaskChange]);

  return (
    <div className="border rounded-lg overflow-hidden">
      <div className="p-2 bg-gray-100 border-b flex gap-2 items-center">
        <select
          value={tool}
          onChange={(e) => setTool(e.target.value as "brush" | "eraser")}
          className="px-2 py-1 border rounded"
        >
          <option value="brush">Brush</option>
          <option value="eraser">Eraser</option>
        </select>
        
        <input
          type="range"
          min="5"
          max="100"
          value={brushSize}
          onChange={(e) => setBrushSize(Number(e.target.value))}
          className="flex-1"
        />
        <span className="text-sm">{brushSize}px</span>
        
        <button
          onClick={clearMask}
          className="px-2 py-1 bg-red-500 text-white rounded text-sm"
        >
          Clear
        </button>
        
        <button
          onClick={invertMask}
          className="px-2 py-1 bg-gray-500 text-white rounded text-sm"
        >
          Invert
        </button>
        
        <button
          onClick={exportMask}
          className="px-2 py-1 bg-blue-500 text-white rounded text-sm"
        >
          Apply Mask
        </button>
      </div>
      
      <Stage
        ref={stageRef}
        width={width}
        height={height}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
      >
        <Layer ref={layerRef}>
          {image && (
            <KonvaImage image={image} width={width} height={height} />
          )}
          
          {lines.map((line, i) => (
            <Line
              key={i}
              points={line.points}
              stroke={line.tool === "eraser" ? "rgba(255,0,0,0.5)" : "rgba(255,255,255,0.7)"}
              strokeWidth={brushSize}
              tension={0.5}
              lineCap="round"
              lineJoin="round"
              globalCompositeOperation={
                line.tool === "eraser" ? "destination-out" : "source-over"
              }
            />
          ))}
        </Layer>
      </Stage>
    </div>
  );
}
