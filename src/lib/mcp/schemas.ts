import { z } from "zod";

export const CreateProjectInputSchema = z.object({
  name: z.string().min(1).max(100),
});

export const ListProjectsInputSchema = z.object({});

export const ListAssetsInputSchema = z.object({
  project_id: z.string().uuid(),
  cursor: z.string().optional(),
  limit: z.number().min(1).max(50).default(20),
});

export const GetAssetInputSchema = z.object({
  asset_id: z.string().uuid(),
});

export const GetAssetHistoryInputSchema = z.object({
  asset_id: z.string().uuid(),
});

export const GetEditContextInputSchema = z.object({
  asset_id: z.string().uuid(),
  version_id: z.string().uuid().optional(),
});

export const SaveGeneratedImageInputSchema = z.object({
  project_id: z.string().uuid(),
  image: z.object({
    download_url: z.string().url(),
    file_id: z.string(),
    mime_type: z.string().optional(),
    file_name: z.string().optional(),
  }),
  name: z.string().optional(),
  prompt: z.string().optional(),
  notes: z.string().optional(),
});

export const SaveEditedImageInputSchema = z.object({
  asset_id: z.string().uuid(),
  parent_version_id: z.string().uuid(),
  image: z.object({
    download_url: z.string().url(),
    file_id: z.string(),
    mime_type: z.string().optional(),
    file_name: z.string().optional(),
  }),
  prompt: z.string().optional(),
  notes: z.string().optional(),
});

export const ExportAssetInputSchema = z.object({
  version_id: z.string().uuid(),
  format: z.literal("original").optional(),
});

export const ShowAssetInputSchema = z.object({
  asset_id: z.string().uuid(),
  version_id: z.string().uuid().optional(),
});
