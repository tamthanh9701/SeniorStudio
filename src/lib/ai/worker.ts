import { createHash } from "node:crypto";
import { PostgrestError } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { AiJobSchema, type AiJob } from "@/db/ai-jobs";
import { prepareImageBytes } from "@/lib/assets/service";
import { compositeInpaintResult } from "@/lib/assets/inpaint-composite";
import { formatDateTime } from "@/lib/format/datetime";
import { providerForJob } from "@/lib/ai/providers";
import { getProviderApiKey } from "@/lib/ai/credentials";
import type { ProviderImage, ProviderSubmission } from "@/lib/ai/providers/types";
import { ProviderError } from "@/lib/ai/providers/types";
import { STORAGE_BUCKET } from "@/db/schema";
import { getOwnedAssetVersion, getOwnedJobMask, getOwnedStyleReference, downloadOwnedBytes, removeOwnedObjects, ownedStorageObjectFromPath } from "@/lib/assets/ownership";
/** Lease duration; the provider budget below must stay under it. */
export const LEASE_SECONDS = 180;
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_PIXELS = 100_000_000;
const DOWNLOAD_TIMEOUT_MS = 30_000;
/** Provider budget: shorter than the lease so a hung call fails visibly. */
const PROVIDER_TIMEOUT_MS = 150_000;

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
  const { error } = await client.rpc("renew_ai_job_lease", { p_job_id: job.id, p_worker_id: workerId, p_lease_seconds: LEASE_SECONDS });
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
  // Only a proven loss of the lease is fatal.  A transient renewal failure must
  // not stop later renewals: latching it guaranteed the lease would expire while
  // the provider call was still running, which the cleanup sweep then reported
  // as an unknown provider outcome.
  let leaseLost: unknown = null;
  let lastRenewalError: unknown = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;
  const attemptRenewal = async () => {
    try {
      await renew(client, job, workerId);
      lastRenewalError = null;
    } catch (error) {
      // Supabase errors are message-like objects, not always Error instances.
      const message = normalizeErrorMessage(error);
      lastRenewalError = error;
      if (message.includes("LEASE_NOT_OWNED")) leaseLost ??= error;
      console.error(`ai_job_lease_renewal_failed job=${job.id} worker=${workerId} fatal=${message.includes("LEASE_NOT_OWNED")} error=${message}`);
    }
  };
  const heartbeat = () => {
    if (inFlight) return;
    inFlight = attemptRenewal().finally(() => { inFlight = null; });
  };
  const timer = setInterval(() => { if (!stopped) heartbeat(); }, 30_000);
  const stopAndSettle = async () => {
    stopped = true;
    clearInterval(timer);
    if (inFlight) await inFlight.catch(() => undefined);
  };

  try {
    const result = await task();
    await stopAndSettle();
    if (leaseLost) throw leaseLost;
    // Verify the lease is still ours before the caller persists anything; a
    // transient failure above is tolerable if a fresh renewal succeeds.
    if (lastRenewalError) await renew(client, job, workerId);
    return result;
  } catch (error) {
    await stopAndSettle();
    if (leaseLost) throw leaseLost;
    throw error;
  }
}


/**
 * Display name for a produced image.
 *
 * Prompts make unusable names (long, repeated, sometimes in another language),
 * so a name states what the image is and where it came from.  The prompt stays
 * on the version row, which is where it is actually meaningful.
 */
function assetNameFor(job: AiJob, ownerName: string | null, at: string | Date): string {
  // An edit is stored as a version of an existing image, so naming it "Image"
  // would misdescribe it in the version history.
  const label = job.operation === "inpaint" ? "Edit" : "Image";
  const moment = formatDateTime(at) ?? "";
  return [label, ownerName, moment].filter((part): part is string => Boolean(part && part.trim())).join(" · ");
}

async function ownerNameFor(client: SupabaseClient, job: AiJob): Promise<string | null> {
  if (job.module === "style" && job.style_id) {
    const { data } = await client.from("styles").select("name").eq("id", job.style_id).maybeSingle();
    return data?.name ?? null;
  }
  if (job.project_id) {
    const { data } = await client.from("projects").select("name").eq("id", job.project_id).maybeSingle();
    return data?.name ?? null;
  }
  return null;
}

async function persistJobImages(
  client: SupabaseClient,
  job: AiJob,
  workerId: string,
  submission: CompletedSubmission,
  providerStatus: string,
  prepared: PreparedInputs,
) {
  const ownerName = await ownerNameFor(client, job);
  const { error: stateError } = await client.rpc("set_ai_job_persisting", { p_job_id: job.id, p_worker_id: workerId });
  if (stateError) throw stateError;
  const results: Array<Record<string, unknown>> = [];
  const uploadedPaths: string[] = [];
  const images = submission.images.slice(0, job.input.count);
  if (images.length !== job.input.count) throw new ProviderError("MALFORMED_PROVIDER_OUTPUT", "Provider returned an unexpected number of images");
  // A style edit lands as a candidate child version of its source asset; the
  // current version moves only when the user keeps the edit.
  const isCandidateEdit = job.module === "style" && job.operation === "inpaint";
  if (isCandidateEdit && (!prepared.sourceBytes || !prepared.maskBytes)) {
    throw new ProviderError("INVALID_REQUEST", "Edit job is missing its source image or mask");
  }
  try {
    for (const image of images) {
      const providerOutput = await providerBytes(image);
      // An edit must not alter anything outside the painted region.  Providers
      // honour masks to varying degrees, so the invariant is enforced here.
      const bytes = isCandidateEdit
        ? await compositeInpaintResult(prepared.sourceBytes!, providerOutput, prepared.maskBytes!)
        : providerOutput;
      const decoded = await prepareImageBytes(bytes);
      if (decoded.bytes.byteLength > MAX_BYTES || decoded.width * decoded.height > MAX_PIXELS) throw new ProviderError("FILE_TOO_LARGE", "Provider result exceeds image limits");
      const isStyleJob = job.module === "style";
      const assetId = isCandidateEdit ? job.asset_id : crypto.randomUUID();
      const versionId = crypto.randomUUID();
      if (!assetId) throw new ProviderError("MALFORMED_PROVIDER_OUTPUT", "Inpaint job has no asset");
      if (isStyleJob && !job.style_id) throw new ProviderError("INVALID_REQUEST", "Style job has no style_id");
      const styleId = job.style_id ?? job.input.style_id;
      const storagePath = isStyleJob ? `${job.workspace_id}/styles/${styleId}/outputs/${assetId}/${versionId}/source.${decoded.extension}` : `${job.workspace_id}/${job.project_id ?? ""}/${assetId}/${versionId}/source.${decoded.extension}`;
      const { error: uploadError } = await client.storage.from(STORAGE_BUCKET).upload(storagePath, decoded.bytes, { contentType: decoded.mimeType, upsert: false });
      if (uploadError) throw uploadError;
      uploadedPaths.push(storagePath);
      results.push({ asset_id: assetId, version_id: versionId, storage_path: storagePath, mime_type: decoded.mimeType, width: decoded.width, height: decoded.height, byte_size: decoded.bytes.byteLength, name: assetNameFor(job, ownerName, new Date()), prompt: job.input.prompt, provider_response_id: submission.requestId, metadata: { provider: job.provider, model: job.model, operation: job.operation, ...submission.metadata } });
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

type PreparedInputs = {
  inputImages: InputImage[];
  maskBytes?: Uint8Array;
  /** Decoded source bytes for the recorded source version, reused for compositing. */
  sourceBytes?: Uint8Array;
};

/**
 * The references a job must submit.
 *
 * A persisted job records its snapshot in the generation packet; the caller's
 * `reference_ids` must describe that same set.  Bytes are verified against the
 * recorded hash so a replaced object cannot silently change what a confirmed
 * definition means.
 */
function expectedReferenceHashes(job: AiJob): Map<string, string> | null {
  const snapshot = (job.style_generation as { reference_snapshot?: unknown } | null | undefined)?.reference_snapshot;
  if (!Array.isArray(snapshot)) return null;
  const hashes = new Map<string, string>();
  for (const entry of snapshot) {
    if (!entry || typeof entry !== "object") return null;
    const record = entry as Record<string, unknown>;
    if (typeof record.id !== "string") return null;
    hashes.set(record.id, typeof record.content_hash === "string" ? record.content_hash.toLowerCase() : "");
  }
  return hashes;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function prepareInputImages(client: SupabaseClient, job: AiJob): Promise<PreparedInputs> {
  const inputImages: InputImage[] = [];
  let maskBytes: Uint8Array | undefined;
  let sourceBytes: Uint8Array | undefined;
  if (job.operation === "image_to_image" || job.operation === "inpaint") {
    const sourceVersionId = job.operation === "inpaint" ? job.parent_version_id : job.source_version_id;
    if (!sourceVersionId) throw new ProviderError("INVALID_REQUEST", `${job.operation} requires a source version`);
    const { data: source, error } = await client.from("asset_versions").select("asset_id").eq("id", sourceVersionId).single();
    if (error || !source) throw new ProviderError("NOT_FOUND", "Source version not found");
    const owned = await getOwnedAssetVersion(client, job.workspace_id, source.asset_id, sourceVersionId);
    const downloaded = await downloadOwnedBytes(client, owned.owned);
    sourceBytes = downloaded.bytes;
    inputImages.push({ role: "source", id: sourceVersionId, ...downloaded });
  }
  const referenceIds = job.input.reference_ids ?? [];
  const expectedHashes = referenceIds.length > 0 ? expectedReferenceHashes(job) : null;
  if (referenceIds.length > 0 && (!expectedHashes || expectedHashes.size !== referenceIds.length)) {
    throw new ProviderError("INVALID_REQUEST", "Job references do not match its recorded style snapshot");
  }
  for (const referenceId of referenceIds) {
    if (!job.style_id) throw new ProviderError("INVALID_REQUEST", "Style reference requires style job");
    const owned = await getOwnedStyleReference(client, job.workspace_id, job.style_id, referenceId);
    const downloaded = await downloadOwnedBytes(client, owned.owned);
    const expected = expectedHashes!.get(referenceId) ?? "";
    if (expected && sha256Hex(downloaded.bytes) !== expected) {
      throw new ProviderError("REFERENCE_CONTENT_CHANGED", "A reference image no longer matches the style definition");
    }
    inputImages.push({ role: "reference", id: referenceId, ...downloaded });
  }
  if (job.operation === "inpaint" && (job.input.mask_id || job.input.mask_storage_path)) {
    const owned = await getOwnedJobMask(client, job.workspace_id, job.id);
    maskBytes = (await downloadOwnedBytes(client, owned.owned)).bytes;
  }
  return { inputImages, maskBytes, sourceBytes };
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
    const prepared = await prepareInputImages(client, job);
    const { inputImages, maskBytes } = prepared;
    const context = { client, job, apiKey, inputImages, maskBytes, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) };
    if (job.status === "processing" && job.provider === "google" && job.provider_request_id) {
      const result = await withLeaseHeartbeat(client, job, workerId, () => provider.poll(context));
      if (result.state === "processing") {
        const { error } = await client.rpc("set_ai_job_processing", { p_job_id: job.id, p_worker_id: workerId, p_provider_request_id: job.provider_request_id, p_provider_status: result.providerStatus, p_metadata: result.metadata });
        if (error) throw error;
        return "processing";
      }
      await withLeaseHeartbeat(client, job, workerId, () => persistJobImages(client, job, workerId, { state: "completed", images: result.images, requestId: job.provider_request_id, metadata: result.metadata }, result.providerStatus, prepared));
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
    await withLeaseHeartbeat(client, job, workerId, () => persistJobImages(client, job, workerId, submission, "COMPLETED", prepared));
    if (job.module !== "style") await cleanMask(client, job);
    return "succeeded";
  } catch (error) {
    const message = normalizeErrorMessage(error);
    if (message.includes("LEASE_NOT_OWNED") || message.includes("lease")) return "lease_lost";
    // ProviderError carries a `code`, so it must be classified before the
    // database-error guard below; otherwise a rejected reference or a failed
    // input download would crash the worker instead of failing the job.
    if (error instanceof ProviderError) return failJob(client, job, workerId, error.code, message);
    if (error instanceof PostgrestError || (typeof error === "object" && error !== null && "code" in error)) throw error;
    return failJob(client, job, workerId, "PROVIDER_ERROR", message);
  }
}
