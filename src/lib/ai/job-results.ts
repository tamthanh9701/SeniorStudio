import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiJob } from "@/db/ai-jobs";
import { getSignedUrl } from "@/lib/assets/service";

export async function getJobResultUrls(client: SupabaseClient, job: AiJob): Promise<string[]> {
  if (job.status !== "succeeded") return [];
  const results = Array.isArray(job.output.results)
    ? (job.output.results as Array<{ version_id?: unknown }>)
    : [];
  const versionIds = results
    .map((result) => result.version_id)
    .filter((value): value is string => typeof value === "string");
  if (versionIds.length === 0) return [];

  const { data: versions } = await client
    .from("asset_versions")
    .select("id, storage_path")
    .in("id", versionIds);
  const byId = new Map((versions ?? []).map((version) => [version.id, version.storage_path]));
  const urls: string[] = [];
  for (const versionId of versionIds) {
    const storagePath = byId.get(versionId);
    if (storagePath) urls.push(await getSignedUrl(client, storagePath));
  }
  return urls;
}
