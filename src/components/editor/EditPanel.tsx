"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface EditPanelProps {
  projectId: string;
  assetId: string;
  versionId: string;
  signedUrl: string;
}

export default function EditPanel({ projectId, assetId, versionId, signedUrl }: EditPanelProps) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [maskPng, setMaskPng] = useState<string | null>(null);

  const handleEdit = async () => {
    if (!prompt || !maskPng) return;

    setLoading(true);
    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetId,
          parentVersionId: versionId,
          prompt,
          maskPng,
        }),
      });

      if (response.ok) {
        router.push(`/projects/${projectId}/assets/${assetId}`);
      }
    } catch (error) {
      console.error("Edit failed:", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="border rounded-lg p-4">
      <h3 className="text-lg font-semibold mb-4">Edit Image</h3>
      
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-2">Edit Prompt</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="w-full h-24 p-3 border rounded-lg"
            placeholder="Describe the edit you want to make..."
          />
        </div>

        <div>
          <label className="block text-sm font-medium mb-2">Mask</label>
          {maskPng ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-green-600">Mask applied</span>
              <button
                onClick={() => setMaskPng(null)}
                className="text-sm text-red-600 hover:underline"
              >
                Remove
              </button>
            </div>
          ) : (
            <p className="text-sm text-gray-500">
              Paint a mask on the image to indicate the edit area
            </p>
          )}
        </div>

        <button
          onClick={handleEdit}
          disabled={!prompt || !maskPng || loading}
          className="w-full bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "Editing..." : "Apply Edit"}
        </button>
      </div>
    </div>
  );
}
