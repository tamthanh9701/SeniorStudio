"use client";

import { useState } from "react";
import StudioCanvas from "./StudioCanvas";

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
      <div className="w-64 border-r p-4">
        <h3 className="font-semibold mb-4">Layers</h3>
        
        <div className="space-y-2 mb-4">
          <button
            onClick={() => addLayer("text", { text: "New Text", fontSize: 24, fontFamily: "Arial", fill: "#000000", align: "left" })}
            className="w-full px-3 py-2 bg-gray-100 rounded hover:bg-gray-200 text-sm"
          >
            Add Text
          </button>
          <button
            onClick={() => addLayer("shape", { shapeType: "rectangle", width: 100, height: 100, fill: "#3b82f6", stroke: "#1d4ed8", strokeWidth: 2 })}
            className="w-full px-3 py-2 bg-gray-100 rounded hover:bg-gray-200 text-sm"
          >
            Add Rectangle
          </button>
          <button
            onClick={() => addLayer("shape", { shapeType: "ellipse", radiusX: 50, radiusY: 50, fill: "#10b981", stroke: "#059669", strokeWidth: 2 })}
            className="w-full px-3 py-2 bg-gray-100 rounded hover:bg-gray-200 text-sm"
          >
            Add Ellipse
          </button>
        </div>

        <div className="space-y-1">
          {[...layers]
            .sort((a, b) => b.zIndex - a.zIndex)
            .map((layer) => (
              <div
                key={layer.id}
                className={`p-2 rounded cursor-pointer flex items-center gap-2 ${
                  selectedLayerId === layer.id
                    ? "bg-blue-100 border border-blue-300"
                    : "bg-gray-50 hover:bg-gray-100"
                }`}
                onClick={() => setSelectedLayerId(layer.id)}
              >
                <span className="flex-1 text-sm truncate">{layer.name}</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    updateLayer(layer.id, { visible: !layer.visible });
                  }}
                  className="text-xs text-gray-500 hover:text-gray-700"
                >
                  {layer.visible ? "👁" : "🚫"}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteLayer(layer.id);
                  }}
                  className="text-xs text-red-500 hover:text-red-700"
                >
                  ✕
                </button>
              </div>
            ))}
        </div>
      </div>

      <div className="flex-1 p-4 overflow-auto">
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
