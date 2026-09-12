import { PostgrestError } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AiJobSchema, type AiJob } from "@/db/ai-jobs";
import { prepareImageBytes } from "@/lib/assets/service";
import { providerForJob } from "@/lib/ai/providers";
import { getProviderApiKey } from "@/lib/ai/credentials";
import type { ProviderImage, ProviderSubmission } from "@/lib/ai/providers/types";
import { ProviderError } from "@/lib/ai/providers/types";
import { STORAGE_BUCKET } from "@/db/schema";
import { getOwnedAssetVersion, getOwnedJobMask, getOwnedStyleReference, downloadOwnedBytes, removeOwnedObjects, ownedStorageObjectFromPath } from "@/lib/assets/ownership";
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_PIXELS = 100_000_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;

type CompletedSubmission = Extract<ProviderSubmission, { state: "completed" }>;

async function boundedResponseBytes(response: Response, label: string): Promise<Uint8Array> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_BYTES) throw new ProviderError("FILE_TOO_LARGE", `${label} exceeds 50 MiB`);
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_BYTES) throw new ProviderError("FILE_TOO_LARGE", `${label} exceeds 50 MiB`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_BYTES) throw new ProviderError("FILE_TOO_LARGE", `${label} exceeds 50 MiB`);
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function providerBytes(image: ProviderImage) {
  if (image.kind === "bytes") {
    if (image.bytes.byteLength > MAX_BYTES) throw new ProviderError("FILE_TOO_LARGE", "Provider result exceeds 50 MiB");
    return image.bytes;
  }
  const response = await fetch(image.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) throw new ProviderError("FILE_UNAVAILABLE", "Provider result download failed");
  const type = (response.headers.get("content-type") ?? image.contentType ?? "").split(";", 1)[0].toLowerCase();
  if (!type.startsWith("image/")) throw new ProviderError("UNSUPPORTED_IMAGE", "Provider result was not an image");
  return boundedResponseBytes(response, "Provider result");
}
async function cleanMask(client: SupabaseClient, job: AiJob) {
  if (!job.input.mask_id && !job.input.mask_storage_path) return;
  if (job.module === "style" && job.status === "succeeded") return;
  const owned = await getOwnedJobMask(client, job.workspace_id, job.id);
  await removeOwnedObjects(client, [owned.owned]);
  const { error } = await client.from("ai_job_inputs").delete().eq("id", owned.mask.id);
  if (error) throw error;
}
async function renew(client: SupabaseClient, job: AiJob, workerId: string) {
  const { error } = await client.rpc("renew_ai_job_lease", { p_job_id: job.id, p_worker_id: workerId, p_lease_seconds: 120 });
  if (error) throw error;
}

export async function withLeaseHeartbeat<T>(
  client: SupabaseClient,
  job: AiJob,
  workerId: string,
  task: () => Promise<T>,
): Promise<T> {
  // Renew immediately at entry so the lease is fresh before work starts.
  await renew(client, job, workerId);
  let firstError: unknown = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  const heartbeat = () => {
    if (inFlight || firstError) return;
    inFlight = renew(client, job, workerId)
      .then(() => undefined)
      .catch((error) => { firstError ??= error; })
      .finally(() => { inFlight = null; });
  };
  const timer = setInterval(() => { if (!stopped) heartbeat(); }, 30_000);
  try {
    const result = await task();
    // Stop scheduling, then wait for any in-flight renewal so a racing
    // lease loss still surfaces before the caller starts persistence.
    stopped = true;
    clearInterval(timer);
    if (inFlight) await inFlight;
    if (firstError) throw firstError;
    return result;
  } catch (error) {
    stopped = true;
    clearInterval(timer);
    // Same guarantee on failure paths: a renewal error beats task errors.
    try {
      if (inFlight) await inFlight;
    } catch { /* renewal error already recorded */ }
    if (firstError) throw firstError;
    throw error;
  }
}

async function persistJobImages(
  client: SupabaseClient,
  job: AiJob,
  workerId: string,
  submission: CompletedSubmission,
  providerStatus: string,
) {
  const { error: stateError } = await client.rpc("set_ai_job_persisting", { p_job_id: job.id, p_worker_id: workerId });
  if (stateError) throw stateError;
  const results: Array<Record<string, unknown>> = [];
  const uploadedPaths: string[] = [];
  const images = submission.images.slice(0, job.input.count);
  if (images.length !== job.input.count) throw new ProviderError("MALFORMED_PROVIDER_OUTPUT", "Provider returned an unexpected number of images");
  try {
    for (const image of images) {
      const bytes = await providerBytes(image);
      const decoded = await prepareImageBytes(bytes);
      if (decoded.bytes.byteLength > MAX_BYTES || decoded.width * decoded.height > MAX_PIXELS) throw new ProviderError("FILE_TOO_LARGE", "Provider result exceeds image limits");
      const isStyleJob = job.module === "style";
      const assetId = isStyleJob || job.operation !== "inpaint" ? crypto.randomUUID() : job.asset_id;
      const versionId = crypto.randomUUID();
      if (!assetId) throw new ProviderError("MALFORMED_PROVIDER_OUTPUT", "Inpaint job has no asset");
      if (isStyleJob && !job.style_id) throw new ProviderError("INVALID_REQUEST", "Style job has no style_id");
      const styleId = job.style_id ?? job.input.style_id;
      const storagePath = isStyleJob ? `${job.workspace_id}/styles/${styleId}/outputs/${assetId}/${versionId}/source.${decoded.extension}` : `${job.workspace_id}/${job.project_id ?? ""}/${assetId}/${versionId}/source.${decoded.extension}`;
      const { error: uploadError } = await client.storage.from(STORAGE_BUCKET).upload(storagePath, decoded.bytes, { contentType: decoded.mimeType, upsert: false });
      if (uploadError) throw uploadError;
      uploadedPaths.push(storagePath);
      results.push({ asset_id: assetId, version_id: versionId, storage_path: storagePath, mime_type: decoded.mimeType, width: decoded.width, height: decoded.height, byte_size: decoded.bytes.byteLength, name: (job.input.original_prompt ?? job.input.prompt).trim().slice(0, 80) || "Untitled", prompt: job.input.prompt, provider_response_id: submission.requestId, metadata: { provider: job.provider, model: job.model, operation: job.operation, ...submission.metadata } });
    }
    const { error } = await client.rpc("complete_ai_job_with_results", { p_job_id: job.id, p_worker_id: workerId, p_provider_request_id: submission.requestId, p_provider_status: providerStatus, p_results: results, p_output: { provider: job.provider, model: job.model, provider_request_id: submission.requestId, operation: job.operation, results, ...submission.metadata } });
    if (error) {
      const resolver = await client.rpc("resolve_ai_job_persistence", { p_job_id: job.id, p_worker_id: workerId, p_version_ids: results.map((result) => result.version_id) });
      if (resolver.error) {
        throw Object.assign(new Error(`PERSISTENCE_OUTCOME_UNKNOWN: ${resolver.error.message}`), { preserveUploaded: true });
      }
      const state = resolver.data?.state as string | undefined;
      if (state === "committed") return results;
      if (state === "aborted") {
        if (uploadedPaths.length) {
          const { error: removeError } = await client.storage.from(STORAGE_BUCKET).remove(uploadedPaths);
          if (removeError) console.error(`persistence abort cleanup failed: ${removeError.message}`);
          uploadedPaths.length = 0;
        }
        throw new ProviderError("PERSISTENCE_FAILED", "Job persistence was aborted");
      }
      throw Object.assign(new Error("PERSISTENCE_OUTCOME_UNKNOWN"), { preserveUploaded: true });
    }
    return results;
  } catch (error) {
    const preserveUploaded = typeof error === "object" && error !== null && "preserveUploaded" in error;
    if (!preserveUploaded && uploadedPaths.length) {
      const { error: removeError } = await client.storage.from(STORAGE_BUCKET).remove(uploadedPaths);
      if (removeError) console.error(`persistence error cleanup failed: ${removeError.message}`);
    }
    throw error;
  }
}

type InputImage = { role: "source" | "reference"; id: string; bytes: Uint8Array; mimeType: string };

async function downloadStorageBytes(client: SupabaseClient, storagePath: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const owned = ownedStorageObjectFromPath(storagePath);
  const result = await downloadOwnedBytes(client, owned);
  const decoded = await prepareImageBytes(result.bytes);
  if (decoded.width * decoded.height > MAX_PIXELS) throw new ProviderError("FILE_TOO_LARGE", "Input exceeds pixel limit");
  return { bytes: result.bytes, mimeType: decoded.mimeType };
}

async function prepareInputImages(client: SupabaseClient, job: AiJob): Promise<{ inputImages: InputImage[]; maskBytes?: Uint8Array }> {
  const inputImages: InputImage[] = [];
  let maskBytes: Uint8Array | undefined;
  if (job.operation === "image_to_image" || job.operation === "inpaint") {
    const sourceVersionId = job.operation === "inpaint" ? job.parent_version_id : job.source_version_id;
    if (!sourceVersionId) throw new ProviderError("INVALID_REQUEST", `${job.operation} requires a source version`);
    const { data: source, error } = await client.from("asset_versions").select("asset_id").eq("id", sourceVersionId).single();
    if (error || !source) throw new ProviderError("NOT_FOUND", "Source version not found");
    const owned = await getOwnedAssetVersion(client, job.workspace_id, source.asset_id, sourceVersionId);
    inputImages.push({ role: "source", id: sourceVersionId, ...(await downloadOwnedBytes(client, owned.owned)) });
  }
  const referenceIds = job.input.reference_ids ?? [];
  for (const referenceId of referenceIds) {
    if (!job.style_id) throw new ProviderError("INVALID_REQUEST", "Style reference requires style job");
    const owned = await getOwnedStyleReference(client, job.workspace_id, job.style_id, referenceId);
    inputImages.push({ role: "reference", id: referenceId, ...(await downloadOwnedBytes(client, owned.owned)) });
  }
  if (job.operation === "inpaint" && (job.input.mask_id || job.input.mask_storage_path)) {
    const owned = await getOwnedJobMask(client, job.workspace_id, job.id);
    maskBytes = (await downloadOwnedBytes(client, owned.owned)).bytes;
  }
  return { inputImages, maskBytes };
}

function normalizeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || "Unknown provider failure";
  if (typeof error === "object" && error !== null && "message" in error) {
    const msg = (error as { message?: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  return String(error ?? "Unknown provider failure");
}

async function failJob(
  client: SupabaseClient,
  job: AiJob,
  workerId: string,
  code: string,
  message: string,
): Promise<WorkerOutcome> {
  const { error: failError } = await client.rpc("fail_ai_job", { p_job_id: job.id, p_worker_id: workerId, p_error_code: code, p_error_message: message });
  const failMessage = normalizeErrorMessage(failError);
  if (failMessage.includes("LEASE_NOT_OWNED")) return "lease_lost";
  if (failError) throw new Error(`FAIL_JOB_RPC_ERROR: ${failMessage}`);
  await cleanMask(client, job);
  return "failed";
}

export type WorkerOutcome = "succeeded" | "processing" | "failed" | "canceled" | "lease_lost";

export async function processAiJob(client: SupabaseClient, rawJob: unknown, workerId: string): Promise<WorkerOutcome> {
  const job = AiJobSchema.parse(rawJob);
  if (job.status === "succeeded" || job.status === "failed") return job.status;
  if (job.status === "canceled") return "canceled";
  const provider = await providerForJob(job, client);
  const apiKey = await getProviderApiKey(job.provider, { service: client, workspaceId: job.workspace_id });
  if (!apiKey) {
    return failJob(client, job, workerId, "PROVIDER_NOT_CONFIGURED", "No API key is configured for this provider");
  }
  try {
    const { inputImages, maskBytes } = await prepareInputImages(client, job);
    const context = { client, job, apiKey, inputImages, maskBytes, signal: AbortSignal.timeout(150_000) };
    if (job.status === "processing" && job.provider === "google" && job.provider_request_id) {
      const result = await withLeaseHeartbeat(client, job, workerId, () => provider.poll(context));
      if (result.state === "processing") {
        const { error } = await client.rpc("set_ai_job_processing", { p_job_id: job.id, p_worker_id: workerId, p_provider_request_id: job.provider_request_id, p_provider_status: result.providerStatus, p_metadata: result.metadata });
        if (error) throw error;
        return "processing";
      }
      await withLeaseHeartbeat(client, job, workerId, () => persistJobImages(client, job, workerId, { state: "completed", images: result.images, requestId: job.provider_request_id, metadata: result.metadata }, result.providerStatus));
      if (job.module !== "style") await cleanMask(client, job);
      return "succeeded";
    }
    const { error: beginError } = await client.rpc("begin_ai_job_provider", { p_job_id: job.id, p_worker_id: workerId });
    if (beginError) {
      const message = normalizeErrorMessage(beginError);
      if (message.includes("LEASE_NOT_OWNED")) return "lease_lost";
      throw beginError;
    }
    const submission = await withLeaseHeartbeat(client, job, workerId, () => provider.submit(context));
    if (submission.state === "processing") {
      const { error } = await client.rpc("set_ai_job_processing", { p_job_id: job.id, p_worker_id: workerId, p_provider_request_id: submission.requestId, p_provider_status: submission.providerStatus, p_metadata: submission.metadata });
      if (error) throw error;
      return "processing";
    }
    await withLeaseHeartbeat(client, job, workerId, () => persistJobImages(client, job, workerId, submission, "COMPLETED"));
    if (job.module !== "style") await cleanMask(client, job);
    return "succeeded";
  } catch (error) {
    const message = normalizeErrorMessage(error);
    if (message.includes("LEASE_NOT_OWNED") || message.includes("lease")) return "lease_lost";
    if (error instanceof PostgrestError || (typeof error === "object" && error !== null && "code" in error)) throw error;
    const code = error instanceof ProviderError ? error.code : "PROVIDER_ERROR";
    return failJob(client, job, workerId, code, message);
  }
}
