import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiJob } from "@/db/ai-jobs";
import { getSignedUrl } from "@/lib/assets/service";

function jobVersionIds(job: AiJob): string[] {
  if (job.status !== "succeeded") return [];
  const results = Array.isArray(job.output.results)
    ? (job.output.results as Array<{ version_id?: unknown }>)
    : [];
  return results.map((result) => result.version_id).filter((value): value is string => typeof value === "string");
}

export async function getJobsResultUrls(client: SupabaseClient, jobs: AiJob[]): Promise<Map<string, string[]>> {
  const perJobVersionIds = jobs.map((job) => ({ id: job.id, versionIds: jobVersionIds(job) }));
  const versionIds = [...new Set(perJobVersionIds.flatMap(({ versionIds: ids }) => ids))];
  const pathsById = new Map<string, string>();
  if (versionIds.length > 0) {
    const { data: versions } = await client
      .from("asset_versions")
      .select("id, storage_path")
      .in("id", versionIds);
    for (const version of versions ?? []) pathsById.set(version.id, version.storage_path);
  }
  const signedById = new Map<string, string>();
  await Promise.all(versionIds.map(async (versionId) => {
    const storagePath = pathsById.get(versionId);
    if (storagePath) signedById.set(versionId, await getSignedUrl(client, storagePath));
  }));
  const resultUrls = new Map<string, string[]>();
  for (const { id, versionIds: ids } of perJobVersionIds) {
    resultUrls.set(id, ids.map((versionId) => signedById.get(versionId)).filter((url): url is string => Boolean(url)));
  }
  return resultUrls;
}

export async function getJobResultUrls(client: SupabaseClient, job: AiJob): Promise<string[]> {
  return (await getJobsResultUrls(client, [job])).get(job.id) ?? [];
}
