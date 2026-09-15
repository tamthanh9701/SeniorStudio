"use client";

import { useState } from "react";
import StudioCanvas from "./StudioCanvas";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface Layer {
  id: string;
  name: string;
  type: "image" | "text" | "shape" | "draw";
  visible: boolean;
  locked: boolean;
  opacity: number;
  transform: {
    x: number;
    y: number;
    scaleX: number;
    scaleY: number;
    rotation: number;
  };
  zIndex: number;
  payload: Record<string, unknown>;
}

interface EditorWorkspaceProps {
  width: number;
  height: number;
  initialLayers?: Layer[];
  onLayersChange?: (layers: Layer[]) => void;
}

export default function EditorWorkspace({
  width,
  height,
  initialLayers = [],
  onLayersChange,
}: EditorWorkspaceProps) {
  const [layers, setLayers] = useState<Layer[]>(initialLayers);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);

  const handleLayersChange = (newLayers: Layer[]) => {
    setLayers(newLayers);
    onLayersChange?.(newLayers);
  };

  const addLayer = (type: Layer["type"], payload: Record<string, unknown>) => {
    const newLayer: Layer = {
      id: crypto.randomUUID(),
      name: `${type} ${layers.length + 1}`,
      type,
      visible: true,
      locked: false,
      opacity: 1,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      zIndex: layers.length,
      payload,
    };

    handleLayersChange([...layers, newLayer]);
  };

  const updateLayer = (layerId: string, updates: Partial<Layer>) => {
    const updatedLayers = layers.map((layer) =>
      layer.id === layerId ? { ...layer, ...updates } : layer
    );
    handleLayersChange(updatedLayers);
  };

  const deleteLayer = (layerId: string) => {
    const updatedLayers = layers.filter((layer) => layer.id !== layerId);
    handleLayersChange(updatedLayers);
    if (selectedLayerId === layerId) {
      setSelectedLayerId(null);
    }
  };

  const moveLayer = (layerId: string, direction: "up" | "down") => {
    const layerIndex = layers.findIndex((l) => l.id === layerId);
    if (layerIndex === -1) return;

    const newLayers = [...layers];
    const targetIndex = direction === "up" ? layerIndex + 1 : layerIndex - 1;

    if (targetIndex < 0 || targetIndex >= newLayers.length) return;

    // Swap zIndex values
    const tempZIndex = newLayers[layerIndex].zIndex;
    newLayers[layerIndex].zIndex = newLayers[targetIndex].zIndex;
    newLayers[targetIndex].zIndex = tempZIndex;

    handleLayersChange(newLayers);
  };

  return (
    <div className="flex">
      <Card className="w-64 gap-4 rounded-none border-0 border-r bg-card p-4 shadow-none">
        <h3 className="font-semibold">Layers</h3>

        <div className="space-y-2">
          <Button
            type="button"
            variant="outline"
            className="w-full justify-start"
            onClick={() => addLayer("text", { text: "New Text", fontSize: 24, fontFamily: "Arial", fill: "#000000", align: "left" })}
          >
            Add Text
          </Button>
          <Button
            type="button"
            variant="outline"
            className="w-full justify-start"
            onClick={() => addLayer("shape", { shapeType: "rectangle", width: 100, height: 100, fill: "#3b82f6", stroke: "#1d4ed8", strokeWidth: 2 })}
          >
            Add Rectangle
          </Button>
          <Button
            type="button"
            variant="outline"
            className="w-full justify-start"
            onClick={() => addLayer("shape", { shapeType: "ellipse", radiusX: 50, radiusY: 50, fill: "#10b981", stroke: "#059669", strokeWidth: 2 })}
          >
            Add Ellipse
          </Button>
        </div>

        <div className="space-y-1">
          {[...layers]
            .sort((a, b) => b.zIndex - a.zIndex)
            .map((layer) => (
              <div
                key={layer.id}
                className={cn(
                  "flex cursor-pointer items-center gap-2 rounded-lg border p-2",
                  selectedLayerId === layer.id
                    ? "border-primary bg-primary/10"
                    : "border-transparent bg-muted hover:bg-accent"
                )}
                onClick={() => setSelectedLayerId(layer.id)}
              >
                <span className="min-w-0 flex-1 truncate text-sm">{layer.name}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="text-xs text-muted-foreground"
                  onClick={(e) => {
                    e.stopPropagation();
                    updateLayer(layer.id, { visible: !layer.visible });
                  }}
                >
                  {layer.visible ? "👁" : "🚫"}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="text-xs text-destructive"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteLayer(layer.id);
                  }}
                >
                  ✕
                </Button>
              </div>
            ))}
        </div>
      </Card>

      <div className="flex-1 overflow-auto bg-stage p-4">
        <StudioCanvas
          width={width}
          height={height}
          layers={layers}
          onLayersChange={handleLayersChange}
          selectedLayerId={selectedLayerId}
          onSelectLayer={setSelectedLayerId}
        />
      </div>
    </div>
  );
}
