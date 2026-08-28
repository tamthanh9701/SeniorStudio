export const dynamic = "force-dynamic";

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getSignedUrl } from "@/lib/assets/service";
import { createClient } from "@/supabase/server";

interface ProjectPageProps {
  params: Promise<{ projectId: string }>;
}

export default async function ProjectPage({ params }: ProjectPageProps) {
  const { projectId } = await params;
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) redirect("/login");

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id, name, created_at")
    .eq("id", projectId)
    .maybeSingle();

  if (projectError) {
    throw new Error(`Unable to load project: ${projectError.message}`);
  }
  if (!project) notFound();

  const { data: assets, error: assetsError } = await supabase
    .from("assets")
    .select("id, name, kind, current_version_id, created_at")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });

  if (assetsError) {
    throw new Error(`Unable to load project assets: ${assetsError.message}`);
  }

  const galleryAssets = await Promise.all(
    (assets ?? []).map(async (asset) => {
      if (!asset.current_version_id) {
        return { ...asset, signedUrl: null };
      }

      const { data: version, error: versionError } = await supabase
        .from("asset_versions")
        .select("storage_path")
        .eq("id", asset.current_version_id)
        .maybeSingle();

      if (versionError) {
        throw new Error(`Unable to load asset version: ${versionError.message}`);
      }

      return {
        ...asset,
        signedUrl: version
          ? await getSignedUrl(supabase, version.storage_path)
          : null,
      };
    })
  );

  return (
    <main className="min-h-screen p-8">
      <div className="mx-auto max-w-6xl">
        <Link href="/projects" className="text-blue-600 hover:underline">
          Back to projects
        </Link>
        <div className="my-8">
          <h1 className="text-3xl font-bold">{project.name}</h1>
          <p className="mt-2 text-gray-500">
            Created {new Date(project.created_at).toLocaleDateString()}
          </p>
        </div>


        {galleryAssets.length === 0 ? (
          <div className="rounded-lg border border-dashed p-12 text-center text-gray-500">
            No images saved yet. Generate or edit an image in ChatGPT, then use the SeniorStudio MCP save tool to store the exact result in this project.
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {galleryAssets.map((asset) => (
              <Link
                key={asset.id}
                href={`/projects/${projectId}/assets/${asset.id}`}
                className="overflow-hidden rounded-lg border transition hover:border-blue-500"
              >
                {asset.signedUrl ? (
                  <img
                    src={asset.signedUrl}
                    alt={asset.name}
                    className="aspect-square w-full object-cover"
                  />
                ) : (
                  <div className="flex aspect-square items-center justify-center bg-gray-100 text-gray-500">
                    No current version
                  </div>
                )}
                <div className="p-4">
                  <h2 className="font-semibold">{asset.name}</h2>
                  <p className="mt-1 text-sm text-gray-500">{asset.kind}</p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
