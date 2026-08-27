"use client";

import { useRef, useState, useEffect, useCallback } from "react";
import { Stage, Layer, Image as KonvaImage, Rect, Ellipse, Line, Text, Transformer } from "react-konva";
import type Konva from "konva";

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

interface StudioCanvasProps {
  width: number;
  height: number;
  layers: Layer[];
  onLayersChange: (layers: Layer[]) => void;
  selectedLayerId: string | null;
  onSelectLayer: (layerId: string | null) => void;
}

export default function StudioCanvas({
  width,
  height,
  layers,
  onLayersChange,
  selectedLayerId,
  onSelectLayer,
}: StudioCanvasProps) {
  const stageRef = useRef<Konva.Stage>(null);
  const layerRef = useRef<Konva.Layer>(null);
  const transformerRef = useRef<Konva.Transformer>(null);

  // Sort layers by zIndex
  const sortedLayers = [...layers].sort((a, b) => a.zIndex - b.zIndex);

  // Handle transform end
  const handleTransformEnd = useCallback(
    (layerId: string, e: Konva.KonvaEventObject<Event>) => {
      const node = e.target;
      const scaleX = node.scaleX();
      const scaleY = node.scaleY();

      // Reset scale to 1 and adjust dimensions
      node.scaleX(1);
      node.scaleY(1);

      const updatedLayers = layers.map((layer) => {
        if (layer.id === layerId) {
          return {
            ...layer,
            transform: {
              x: node.x(),
              y: node.y(),
              scaleX,
              scaleY,
              rotation: node.rotation(),
            },
          };
        }
        return layer;
      });

      onLayersChange(updatedLayers);
    },
    [layers, onLayersChange]
  );

  // Handle drag end
  const handleDragEnd = useCallback(
    (layerId: string, e: Konva.KonvaEventObject<DragEvent>) => {
      const updatedLayers = layers.map((layer) => {
        if (layer.id === layerId) {
          return {
            ...layer,
            transform: {
              ...layer.transform,
              x: e.target.x(),
              y: e.target.y(),
            },
          };
        }
        return layer;
      });

      onLayersChange(updatedLayers);
    },
    [layers, onLayersChange]
  );

  // Update transformer when selection changes
  useEffect(() => {
    if (transformerRef.current && stageRef.current) {
      const stage = stageRef.current;
      if (selectedLayerId) {
        const selectedNode = stage.findOne(`#${selectedLayerId}`);
        if (selectedNode) {
          transformerRef.current.nodes([selectedNode]);
          transformerRef.current.getLayer()?.batchDraw();
        }
      } else {
        transformerRef.current.nodes([]);
        transformerRef.current.getLayer()?.batchDraw();
      }
    }
  }, [selectedLayerId]);

  return (
    <Stage
      ref={stageRef}
      width={width}
      height={height}
      onClick={(e) => {
        // Deselect if clicked on empty area
        if (e.target === e.target.getStage()) {
          onSelectLayer(null);
        }
      }}
    >
      <Layer ref={layerRef}>
        {sortedLayers.map((layer) => {
          if (!layer.visible) return null;

          const commonProps = {
            id: layer.id,
            key: layer.id,
            x: layer.transform.x,
            y: layer.transform.y,
            scaleX: layer.transform.scaleX,
            scaleY: layer.transform.scaleY,
            rotation: layer.transform.rotation,
            opacity: layer.opacity,
            draggable: !layer.locked,
            onClick: () => onSelectLayer(layer.id),
            onTap: () => onSelectLayer(layer.id),
            onDragEnd: (e: Konva.KonvaEventObject<DragEvent>) =>
              handleDragEnd(layer.id, e),
            onTransformEnd: (e: Konva.KonvaEventObject<Event>) =>
              handleTransformEnd(layer.id, e),
          };

          switch (layer.type) {
            case "image":
              return (
                <KonvaImage
                  {...commonProps}
                  image={layer.payload.image as HTMLImageElement}
                  width={layer.payload.width as number}
                  height={layer.payload.height as number}
                />
              );
            case "text":
              return (
                <Text
                  {...commonProps}
                  text={layer.payload.text as string}
                  fontSize={layer.payload.fontSize as number}
                  fontFamily={layer.payload.fontFamily as string}
                  fill={layer.payload.fill as string}
                  align={layer.payload.align as "left" | "center" | "right"}
                />
              );
            case "shape":
              if (layer.payload.shapeType === "rectangle") {
                return (
                  <Rect
                    {...commonProps}
                    width={layer.payload.width as number}
                    height={layer.payload.height as number}
                    fill={layer.payload.fill as string}
                    stroke={layer.payload.stroke as string}
                    strokeWidth={layer.payload.strokeWidth as number}
                  />
                );
              } else if (layer.payload.shapeType === "ellipse") {
                return (
                  <Ellipse
                    {...commonProps}
                    radiusX={layer.payload.radiusX as number}
                    radiusY={layer.payload.radiusY as number}
                    fill={layer.payload.fill as string}
                    stroke={layer.payload.stroke as string}
                    strokeWidth={layer.payload.strokeWidth as number}
                  />
                );
              }
              return null;
            case "draw":
              return (
                <Line
                  {...commonProps}
                  points={layer.payload.points as number[]}
                  stroke={layer.payload.stroke as string}
                  strokeWidth={layer.payload.strokeWidth as number}
                  tension={0.5}
                  lineCap="round"
                  lineJoin="round"
                />
              );
            default:
              return null;
          }
        })}

        <Transformer
          ref={transformerRef}
          boundBoxFunc={(oldBox, newBox) => {
            // Limit minimum size
            if (newBox.width < 5 || newBox.height < 5) {
              return oldBox;
            }
            return newBox;
          }}
        />
      </Layer>
    </Stage>
  );
}
