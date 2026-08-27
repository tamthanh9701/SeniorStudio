"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

interface GeneratePanelProps {
  projectId: string;
}

export default function GeneratePanel({ projectId }: GeneratePanelProps) {
  const router = useRouter();
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState<"1024x1024" | "1792x1024" | "1024x1792">("1024x1024");
  const [quality, setQuality] = useState<"standard" | "hd">("standard");
  const [count, setCount] = useState(1);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<Array<{ status: string; assetId?: string }>>([]);

  const handleGenerate = async () => {
    if (!prompt) return;

    setLoading(true);
    setResults([]);

    try {
      const response = await fetch("/api/generate/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          prompt,
          size,
          quality,
          count,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        setResults(data.results);
        router.refresh();
      }
    } catch (error) {
      console.error("Generation failed:", error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="border rounded-lg p-4">
      <h3 className="text-lg font-semibold mb-4">Generate Image</h3>
      
      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-2">Prompt</label>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="w-full h-24 p-3 border rounded-lg"
            placeholder="Describe the image you want to generate..."
          />
        </div>

        <div className="grid grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium mb-2">Size</label>
            <select
              value={size}
              onChange={(e) => setSize(e.target.value as any)}
              className="w-full p-2 border rounded"
            >
              <option value="1024x1024">1024×1024</option>
              <option value="1792x1024">1792×1024</option>
              <option value="1024x1792">1024×1792</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Quality</label>
            <select
              value={quality}
              onChange={(e) => setQuality(e.target.value as any)}
              className="w-full p-2 border rounded"
            >
              <option value="standard">Standard</option>
              <option value="hd">HD</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Count</label>
            <select
              value={count}
              onChange={(e) => setCount(Number(e.target.value))}
              className="w-full p-2 border rounded"
            >
              {[1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          </div>
        </div>

        <button
          onClick={handleGenerate}
          disabled={!prompt || loading}
          className="w-full bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? "Generating..." : "Generate"}
        </button>

        {results.length > 0 && (
          <div className="mt-4">
            <h4 className="font-medium mb-2">Results</h4>
            <div className="space-y-2">
              {results.map((result, i) => (
                <div
                  key={i}
                  className={`p-3 rounded-lg ${
                    result.status === "succeeded"
                      ? "bg-green-50 border border-green-200"
                      : result.status === "failed"
                      ? "bg-red-50 border border-red-200"
                      : "bg-yellow-50 border border-yellow-200"
                  }`}
                >
                  {result.status === "succeeded" && result.assetId ? (
                    <a
                      href={`/projects/${projectId}/assets/${result.assetId}`}
                      className="text-blue-600 hover:underline"
                    >
                      View Asset
                    </a>
                  ) : (
                    <span>{result.status}</span>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
