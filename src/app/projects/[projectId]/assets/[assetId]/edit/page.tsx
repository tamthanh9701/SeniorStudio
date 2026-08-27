"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import MaskEditor from "@/components/editor/MaskEditor";
import { getSignedUrl } from "@/lib/assets/service";

export default function EditAssetPage() {
  const params = useParams();
  const router = useRouter();
  const [asset, setAsset] = useState<any>(null);
  const [version, setVersion] = useState<any>(null);
  const [signedUrl, setSignedUrl] = useState<string | null>(null);
  const [maskPng, setMaskPng] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    async function loadAsset() {
      try {
        const response = await fetch(`/api/assets/${params.assetId}`);
        const data = await response.json();
        setAsset(data.asset);
        setVersion(data.version);
        setSignedUrl(data.signed_url);
      } catch (error) {
        console.error("Failed to load asset:", error);
      } finally {
        setLoading(false);
      }
    }

    loadAsset();
  }, [params.assetId]);

  const handleSubmit = async () => {
    if (!maskPng || !prompt || !version) return;

    setSubmitting(true);
    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          assetId: params.assetId,
          parentVersionId: version.id,
          prompt,
          maskPng,
        }),
      });

      if (response.ok) {
        router.push(`/projects/${params.projectId}/assets/${params.assetId}`);
      }
    } catch (error) {
      console.error("Failed to edit image:", error);
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="p-8">Loading...</div>;
  }

  if (!asset || !version || !signedUrl) {
    return <div className="p-8">Asset not found</div>;
  }

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-6xl mx-auto">
        <div className="mb-6">
          <button
            onClick={() => router.back()}
            className="text-blue-600 hover:underline"
          >
            Back to Asset
          </button>
        </div>

        <h1 className="text-2xl font-bold mb-6">Edit Image</h1>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div>
            <h2 className="text-lg font-semibold mb-4">Mask Editor</h2>
            <MaskEditor
              imageUrl={signedUrl}
              width={version.width}
              height={version.height}
              onMaskChange={setMaskPng}
            />
          </div>

          <div>
            <h2 className="text-lg font-semibold mb-4">Edit Prompt</h2>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="w-full h-32 p-3 border rounded-lg mb-4"
              placeholder="Describe the edit you want to make..."
            />

            <button
              onClick={handleSubmit}
              disabled={!maskPng || !prompt || submitting}
              className="w-full bg-blue-600 text-white py-3 rounded-lg hover:bg-blue-700 disabled:opacity-50"
            >
              {submitting ? "Generating..." : "Apply Edit"}
            </button>

            {!maskPng && (
              <p className="text-sm text-gray-500 mt-2">
                Paint a mask on the image to indicate the edit area
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
