import type { SupabaseClient } from "@supabase/supabase-js";
import { AiJobSchema, type AiJob } from "@/db/ai-jobs";
import { ingestImageBytes } from "@/lib/assets/service";
import { providerForJob } from "@/lib/ai/providers";
import { getProviderApiKey } from "@/lib/ai/credentials";
import type { ProviderImage, ProviderSubmission } from "@/lib/ai/providers/types";
import { ProviderError } from "@/lib/ai/providers/types";
import { STORAGE_BUCKET } from "@/db/schema";

const MAX_BYTES = 50 * 1024 * 1024;

async function providerBytes(image: ProviderImage) {
  if (image.kind === "bytes") return image.bytes;
  const response = await fetch(image.url);
  if (!response.ok) throw new ProviderError("FILE_UNAVAILABLE", "Provider result download failed");
  const type = response.headers.get("content-type") ?? image.contentType ?? "";
  if (!type.startsWith("image/")) throw new ProviderError("UNSUPPORTED_IMAGE", "Provider result was not an image");
  const length = Number(response.headers.get("content-length"));
  if (length > MAX_BYTES) throw new ProviderError("FILE_TOO_LARGE", "Provider result exceeds 50 MiB");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) throw new ProviderError("FILE_TOO_LARGE", "Provider result exceeds 50 MiB");
  return bytes;
}

async function cleanMask(client: SupabaseClient, job: AiJob) {
  const path = job.input.mask_storage_path;
  if (!path) return;
  await client.storage.from(STORAGE_BUCKET).remove([path]);
  await client.from("ai_job_inputs").delete().eq("storage_path", path);
}

async function renew(client: SupabaseClient, job: AiJob, workerId: string) {
  const { error } = await client.rpc("renew_ai_job_lease", { p_job_id: job.id, p_worker_id: workerId, p_lease_seconds: 120 });
  if (error) throw error;
}

async function persist(client: SupabaseClient, job: AiJob, workerId: string, submission: Extract<ProviderSubmission, { state: "completed" }>, providerStatus: string) {
  await renew(client, job, workerId);
  const { error: stateError } = await client.rpc("set_ai_job_persisting", { p_job_id: job.id, p_worker_id: workerId });
  if (stateError) throw stateError;
  const results = [];
  for (const image of submission.images) {
    const bytes = await providerBytes(image);
    const sourcePrompt = (job.input.original_prompt ?? job.input.prompt).trim().slice(0, 80);
    const ingested = await ingestImageBytes({
      name: sourcePrompt || undefined,
      client, workspaceId: job.workspace_id, projectId: job.project_id,
      assetId: job.operation === "inpaint" ? job.asset_id ?? undefined : undefined,
      parentVersionId: job.operation === "inpaint" ? job.parent_version_id ?? undefined : undefined,
      bytes, source: "web_openai", prompt: job.input.prompt, providerResponseId: submission.requestId ?? undefined,
      metadata: { provider: job.provider, model: job.model, provider_request_id: submission.requestId, operation: job.operation, ...submission.metadata },
    });
    results.push({ asset_id: ingested.asset.id, version_id: ingested.version.id });
  }
  const first = results[0];
  if (!first) throw new ProviderError("MALFORMED_PROVIDER_OUTPUT", "Provider completed without images");
  const { error } = await client.rpc("complete_ai_job", {
    p_job_id: job.id, p_worker_id: workerId, p_asset_id: first.asset_id, p_version_id: first.version_id,
    p_provider_request_id: submission.requestId, p_provider_status: providerStatus,
    p_output: { results, provider: job.provider, model: job.model, provider_request_id: submission.requestId, operation: job.operation, ...submission.metadata },
  });
  if (error) throw error;
  await cleanMask(client, job);
}

export type WorkerOutcome = "succeeded" | "processing" | "failed" | "canceled";

export async function processAiJob(client: SupabaseClient, rawJob: unknown, workerId: string): Promise<WorkerOutcome> {
  const job = AiJobSchema.parse(rawJob);
  if (job.status === "succeeded" || job.status === "failed") return job.status;
  if (job.status === "canceled") return "canceled";
  const provider = await providerForJob(job);
  const apiKey = await getProviderApiKey(job.provider, { service: client });
  if (!apiKey) {
    await client.rpc("fail_ai_job", { p_job_id: job.id, p_worker_id: workerId, p_error_code: "PROVIDER_NOT_CONFIGURED", p_error_message: "No API key is configured for this provider", p_provider_status: job.provider_status });
    return "failed";
  }
  try {
    const context = { client, job, apiKey };
    await renew(client, job, workerId);
    if (job.status === "processing" && job.provider === "google" && job.provider_request_id) {
      const result = await provider.poll(context);
      if (result.state === "processing") {
        const { error } = await client.rpc("set_ai_job_processing", { p_job_id: job.id, p_worker_id: workerId, p_provider_request_id: job.provider_request_id, p_provider_status: result.providerStatus, p_metadata: result.metadata });
        if (error) throw error;
        return "processing";
      }
      await persist(client, job, workerId, { state: "completed", images: result.images, requestId: job.provider_request_id, metadata: result.metadata }, result.providerStatus);
      return "succeeded";
    }
    const submission = await provider.submit(context);
    if (submission.state === "processing") {
      const { error } = await client.rpc("set_ai_job_processing", { p_job_id: job.id, p_worker_id: workerId, p_provider_request_id: submission.requestId, p_provider_status: submission.providerStatus, p_metadata: submission.metadata });
      if (error) throw error;
      return "processing";
    }
    await persist(client, job, workerId, submission, "COMPLETED");
    return "succeeded";
  } catch (error) {
    const code = error instanceof ProviderError ? error.code : "PROVIDER_ERROR";
    const message = error instanceof Error ? error.message : "Unknown provider failure";
    await client.rpc("fail_ai_job", { p_job_id: job.id, p_worker_id: workerId, p_error_code: code, p_error_message: message, p_provider_status: job.provider_status });
    await cleanMask(client, job);
    return "failed";
  }
}
