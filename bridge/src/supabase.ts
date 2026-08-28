import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import sharp from "sharp";
import type { BridgeConfig } from "./config.js";

export type BrowserJob = {
  id: string; workspace_id: string; project_id: string; thread_id: string;
  operation: "chat" | "generate" | "edit"; prompt: string; parent_version_id: string | null;
  status: string; provider_conversation_url: string | null;
};

export class BridgeStore {
  readonly client: SupabaseClient;
  constructor(private readonly config: BridgeConfig) {
    this.client = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
  }
  async heartbeat(status: "online" | "needs_login" | "degraded" | "offline", activeJobId: string | null, errorCode: string | null = null, errorMessage: string | null = null) {
    const { error } = await this.client.from("browser_bridge_workers").upsert({
      worker_id: this.config.BRIDGE_WORKER_ID, status, last_seen_at: new Date().toISOString(), active_job_id: activeJobId,
      browser_url: this.config.BRIDGE_BROWSER_URL ?? null, error_code: errorCode, error_message: errorMessage,
    });
    if (error) throw error;
  }
  async claim(): Promise<BrowserJob | null> {
    const { data, error } = await this.client.rpc("claim_browser_job", { p_worker_id: this.config.BRIDGE_WORKER_ID, p_lease_seconds: 90 });
    if (error) throw error;
    return (Array.isArray(data) ? data[0] : data) ?? null;
  }
  async renew(jobId: string) {
    const { data, error } = await this.client.rpc("renew_browser_job_lease", { p_job_id: jobId, p_worker_id: this.config.BRIDGE_WORKER_ID, p_lease_seconds: 90 });
    if (error || data !== true) throw error ?? new Error("LEASE_NOT_OWNED");
  }
  async state(jobId: string, status: string, conversationUrl?: string) {
    const { error } = await this.client.rpc("set_browser_job_state", { p_job_id: jobId, p_worker_id: this.config.BRIDGE_WORKER_ID, p_status: status, p_provider_conversation_url: conversationUrl ?? null });
    if (error) throw error;
  }
  async completeChat(jobId: string, text: string, conversationUrl: string) {
    const { error } = await this.client.rpc("complete_browser_chat_job", { p_job_id: jobId, p_worker_id: this.config.BRIDGE_WORKER_ID, p_assistant_text: text, p_provider_conversation_url: conversationUrl });
    if (error) throw error;
  }
  async downloadParent(parentVersionId: string): Promise<{ bytes: Buffer; filename: string; mimeType: string }> {
    const { data: version, error } = await this.client.from("asset_versions").select("storage_path,mime_type").eq("id", parentVersionId).single();
    if (error) throw error;
    const { data, error: downloadError } = await this.client.storage.from("assets").download(version.storage_path);
    if (downloadError) throw downloadError;
    const extension = version.mime_type === "image/jpeg" ? "jpg" : version.mime_type.split("/")[1];
    return { bytes: Buffer.from(await data.arrayBuffer()), filename: `source.${extension}`, mimeType: version.mime_type };
  }
  async completeImage(job: BrowserJob, bytes: Buffer, assistantText: string, conversationUrl: string, metadata: Record<string, unknown>) {
    const image = sharp(bytes, { failOn: "error" });
    const info = await image.metadata();
    const mimeType = info.format === "png" ? "image/png" : info.format === "jpeg" ? "image/jpeg" : info.format === "webp" ? "image/webp" : null;
    if (!mimeType || !info.width || !info.height || info.width < 256 || info.height < 256) throw new Error("UNSUPPORTED_IMAGE");
    const assetId = crypto.randomUUID(); const versionId = crypto.randomUUID();
    const ext = info.format === "jpeg" ? "jpg" : info.format;
    const storagePath = `${job.workspace_id}/${job.project_id}/${assetId}/${versionId}/source.${ext}`;
    const { error: uploadError } = await this.client.storage.from("assets").upload(storagePath, bytes, { contentType: mimeType, upsert: false });
    if (uploadError) throw uploadError;
    const { error } = await this.client.rpc("complete_browser_image_job", {
      p_job_id: job.id, p_worker_id: this.config.BRIDGE_WORKER_ID, p_asset_id: assetId, p_version_id: versionId,
      p_storage_path: storagePath, p_mime_type: mimeType, p_width: info.width, p_height: info.height,
      p_byte_size: bytes.byteLength, p_assistant_text: assistantText, p_provider_conversation_url: conversationUrl, p_metadata: metadata,
    });
    if (error) { await this.client.storage.from("assets").remove([storagePath]); throw error; }
  }
  async fail(jobId: string, status: "failed" | "needs_login" | "needs_review", code: string, message: string) {
    const { error } = await this.client.rpc("fail_browser_job", { p_job_id: jobId, p_worker_id: this.config.BRIDGE_WORKER_ID, p_status: status, p_error_code: code, p_error_message: message });
    if (error) throw error;
  }
}
