import { redirect } from "next/navigation";
import { createClient } from "@/supabase/server";
import { getSignedUrl } from "@/lib/assets/service";
import VersionHistory from "@/components/editor/VersionHistory";
import ComparisonSlider from "@/components/editor/ComparisonSlider";
import Link from "next/link";

export default async function AssetDetailPage({
  params,
}: {
  params: { projectId: string; assetId: string };
}) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const { data: asset, error: assetError } = await supabase
    .from("assets")
    .select("*")
    .eq("id", params.assetId)
    .eq("project_id", params.projectId)
    .single();

  if (assetError || !asset) {
    redirect(`/projects/${params.projectId}`);
  }

  const { data: versions } = await supabase
    .from("asset_versions")
    .select("*")
    .eq("asset_id", params.assetId)
    .order("created_at", { ascending: true });

  // Get signed URL for current version
  let signedUrl = null;
  let currentVersion = null;
  if (asset.current_version_id && versions) {
    currentVersion = versions.find((v) => v.id === asset.current_version_id);
    if (currentVersion) {
      signedUrl = await getSignedUrl(supabase, currentVersion.storage_path);
    }
  }

  // Get parent version for comparison
  let parentSignedUrl = null;
  if (currentVersion?.parent_version_id && versions) {
    const parentVersion = versions.find((v) => v.id === currentVersion.parent_version_id);
    if (parentVersion) {
      parentSignedUrl = await getSignedUrl(supabase, parentVersion.storage_path);
    }
  }

  return (
    <div className="min-h-screen p-8">
      <div className="max-w-6xl mx-auto">
        <div className="mb-6">
          <Link
            href={`/projects/${params.projectId}`}
            className="text-blue-600 hover:underline"
          >
            Back to Project
          </Link>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2">
            <h1 className="text-2xl font-bold mb-4">{asset.name}</h1>
            
            {signedUrl && parentSignedUrl ? (
              <ComparisonSlider
                beforeUrl={parentSignedUrl}
                afterUrl={signedUrl}
                width={currentVersion?.width || 800}
                height={currentVersion?.height || 600}
              />
            ) : signedUrl ? (
              <img
                src={signedUrl}
                alt={asset.name}
                className="w-full border rounded-lg"
              />
            ) : (
              <div className="w-full h-64 bg-gray-100 rounded-lg flex items-center justify-center">
                No image available
              </div>
            )}

            <div className="mt-4 flex gap-4">
              <Link
                href={`/projects/${params.projectId}/assets/${params.assetId}/edit`}
                className="bg-blue-600 text-white px-4 py-2 rounded-md hover:bg-blue-700"
              >
                Edit Image
              </Link>
              {signedUrl && (
                <a
                  href={signedUrl}
                  download
                  className="bg-gray-600 text-white px-4 py-2 rounded-md hover:bg-gray-700"
                >
                  Download
                </a>
              )}
            </div>
          </div>

          <div>
            <VersionHistory
              versions={versions || []}
              currentVersionId={asset.current_version_id}
              onSelectVersion={(versionId) => {
                // Navigate to selected version
                window.location.href = `/projects/${params.projectId}/assets/${params.assetId}?version=${versionId}`;
              }}
              onMakeCurrent={async (versionId) => {
                // Make version current
                await fetch(`/api/assets/${params.assetId}/current`, {
                  method: "PUT",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ versionId }),
                });
                window.location.reload();
              }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
