import { z } from "zod";

export const WORKSPACE_TABLE = "workspaces";
export const WORKSPACE_MEMBERS_TABLE = "workspace_members";
export const PROJECTS_TABLE = "projects";
export const ASSETS_TABLE = "assets";
export const ASSET_VERSIONS_TABLE = "asset_versions";
export const AI_JOBS_TABLE = "ai_jobs";
export const SERVICE_HEARTBEATS_TABLE = "service_heartbeats";
export const STORAGE_BUCKET = "assets";

export const AssetKindSchema = z.enum(["generated", "uploaded"]);
export type AssetKind = z.infer<typeof AssetKindSchema>;

export const VersionSourceSchema = z.enum(["chatgpt", "web_openai", "upload", "flattened"]);
export type VersionSource = z.infer<typeof VersionSourceSchema>;

export const AiOperationSchema = z.enum(["text_to_image", "inpaint"]);
export type AiOperation = z.infer<typeof AiOperationSchema>;

export const AiJobStatusSchema = z.enum(["queued", "submitting", "processing", "persisting", "succeeded", "failed", "canceled"]);
export type AiJobStatus = z.infer<typeof AiJobStatusSchema>;

export const WorkspaceSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  created_at: z.string().datetime(),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const WorkspaceMemberSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  email: z.string().email(),
  supabase_user_id: z.string().uuid().nullable(),
  auth0_sub: z.string().nullable(),
  created_at: z.string().datetime(),
});
export type WorkspaceMember = z.infer<typeof WorkspaceMemberSchema>;

export const ProjectSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  name: z.string(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const AssetSchema = z.object({
  id: z.string().uuid(),
  project_id: z.string().uuid(),
  name: z.string(),
  kind: AssetKindSchema,
  current_version_id: z.string().uuid().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
});
export type Asset = z.infer<typeof AssetSchema>;

export const AssetVersionSchema = z.object({
  id: z.string().uuid(),
  asset_id: z.string().uuid(),
  parent_version_id: z.string().uuid().nullable(),
  source: VersionSourceSchema,
  storage_path: z.string(),
  mime_type: z.string(),
  width: z.number(),
  height: z.number(),
  byte_size: z.number(),
  prompt: z.string().nullable(),
  provider_response_id: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()).default({}),
  created_at: z.string().datetime(),
});
export type AssetVersion = z.infer<typeof AssetVersionSchema>;

export const AiJobSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  project_id: z.string().uuid(),
  requested_by: z.string().uuid(),
  asset_id: z.string().uuid().nullable(),
  parent_version_id: z.string().uuid().nullable(),
  version_id: z.string().uuid().nullable(),
  operation: AiOperationSchema,
  provider: z.enum(["openai", "google"]),
  model: z.string(),
  status: AiJobStatusSchema,
  input: z.record(z.string(), z.unknown()),
  output: z.record(z.string(), z.unknown()),
  error_code: z.string().nullable(),
  error_message: z.string().nullable(),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  completed_at: z.string().datetime().nullable(),
});
export type AiJob = z.infer<typeof AiJobSchema>;

export const ServiceHeartbeatSchema = z.object({
  service: z.string(),
  last_seen_at: z.string().datetime(),
});
export type ServiceHeartbeat = z.infer<typeof ServiceHeartbeatSchema>;
