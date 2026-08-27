import OpenAI from "openai";
import { getEnv } from "@/env";
import { getServiceClient } from "@/supabase/server";
import { ingestImage } from "@/lib/assets/service";
import {
  GENERATION_RUNS_TABLE,
  ASSETS_TABLE,
  ASSET_VERSIONS_TABLE,
} from "@/db/schema";

let openaiClient: OpenAI | null = null;

function getOpenAIClient() {
  if (!openaiClient) {
    const env = getEnv();
    openaiClient = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return openaiClient;
}

export interface GenerateImageParams {
  projectId: string;
  workspaceId: string;
  prompt: string;
  referenceVersionIds?: string[];
  size?: "1024x1024" | "1792x1024" | "1024x1792";
  quality?: "standard" | "hd";
}

export interface EditImageParams {
  assetId: string;
  parentVersionId: string;
  workspaceId: string;
  prompt: string;
  maskPng?: string;
  referenceVersionIds?: string[];
}

export async function generateImage(params: GenerateImageParams) {
  const env = getEnv();
  const serviceClient = getServiceClient();
  
  // Create generation run
  const { data: run, error: runError } = await serviceClient
    .from(GENERATION_RUNS_TABLE)
    .insert({
      workspace_id: params.workspaceId,
      project_id: params.projectId,
      origin: "web",
      operation: "generate",
      status: "pending",
      request: {
        prompt: params.prompt,
        size: params.size,
        quality: params.quality,
        referenceVersionIds: params.referenceVersionIds,
      },
    })
    .select()
    .single();

  if (runError) throw runError;

  try {
    const openai = getOpenAIClient();
    
    // Build input with references
    const input: string = params.prompt;

    // Call OpenAI Responses API
    const response = await openai.responses.create({
      model: env.OPENAI_ORCHESTRATOR_MODEL,
      input,
      tools: [{ type: "image_generation" }],
    });

    // Process image generation results
    const imageCalls = response.output.filter(
      (item) => item.type === "image_generation_call"
    );

    if (imageCalls.length === 0) {
      throw new Error("No images generated");
    }

    // Create assets for each generated image
    const results = [];
    for (const imageCall of imageCalls) {
      if (imageCall.type !== "image_generation_call") continue;
      
      const result = await ingestImage({
        client: serviceClient,
        workspaceId: params.workspaceId,
        projectId: params.projectId,
        fileUrl: imageCall.result!,
        source: "web_openai",
        prompt: params.prompt,
        providerResponseId: response.id,
        metadata: { size: params.size, quality: params.quality },
      });

      results.push(result);
    }

    // Update run as succeeded
    await serviceClient
      .from(GENERATION_RUNS_TABLE)
      .update({
        status: "succeeded",
        completed_at: new Date().toISOString(),
        openai_response_id: response.id,
      })
      .eq("id", run.id);

    return { run, results };
  } catch (error) {
    // Mark run as failed
    await serviceClient
      .from(GENERATION_RUNS_TABLE)
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        error_code: error instanceof Error ? error.message : "UNKNOWN_ERROR",
      })
      .eq("id", run.id);

    throw error;
  }
}

export async function editImage(params: EditImageParams) {
  const env = getEnv();
  const serviceClient = getServiceClient();

  // Verify parent version exists
  const { data: parentVersion } = await serviceClient
    .from(ASSET_VERSIONS_TABLE)
    .select("*")
    .eq("id", params.parentVersionId)
    .eq("asset_id", params.assetId)
    .single();

  if (!parentVersion) {
    throw new Error("VERSION_CONFLICT");
  }

  // Create generation run
  const { data: run, error: runError } = await serviceClient
    .from(GENERATION_RUNS_TABLE)
    .insert({
      workspace_id: params.workspaceId,
      project_id: "", // Will be derived from asset
      asset_id: params.assetId,
      parent_version_id: params.parentVersionId,
      origin: "web",
      operation: "edit",
      status: "pending",
      request: {
        prompt: params.prompt,
        maskPng: params.maskPng ? "[MASK]" : undefined,
        referenceVersionIds: params.referenceVersionIds,
      },
    })
    .select()
    .single();

  if (runError) throw runError;

  try {
    const openai = getOpenAIClient();
    
    // Get signed URL for parent version
    const { data: parentSignedUrl } = await serviceClient.storage
      .from("assets")
      .createSignedUrl(parentVersion.storage_path, 600);

    if (!parentSignedUrl?.signedUrl) {
      throw new Error("Failed to get parent version URL");
    }

    // Build input
    const input: string = params.prompt;

    // Call OpenAI Responses API with edit action
    const response = await openai.responses.create({
      model: env.OPENAI_ORCHESTRATOR_MODEL,
      input,
      tools: [{ type: "image_generation" }],
      previous_response_id: parentVersion.provider_response_id || undefined,
    });

    // Process image generation results
    const imageCalls = response.output.filter(
      (item) => item.type === "image_generation_call"
    );

    if (imageCalls.length === 0) {
      throw new Error("No images generated");
    }

    // Ingest first result as new version
    const imageCall = imageCalls[0];
    if (imageCall.type !== "image_generation_call") {
      throw new Error("Invalid image call type");
    }

    const result = await ingestImage({
      client: serviceClient,
      workspaceId: params.workspaceId,
      projectId: "", // Will be derived from asset
      assetId: params.assetId,
      parentVersionId: params.parentVersionId,
      fileUrl: imageCall.result!,
      source: "web_openai",
      prompt: params.prompt,
      providerResponseId: response.id,
    });

    // Update run as succeeded
    await serviceClient
      .from(GENERATION_RUNS_TABLE)
      .update({
        status: "succeeded",
        completed_at: new Date().toISOString(),
        openai_response_id: response.id,
      })
      .eq("id", run.id);

    return { run, result };
  } catch (error) {
    // Mark run as failed
    await serviceClient
      .from(GENERATION_RUNS_TABLE)
      .update({
        status: "failed",
        completed_at: new Date().toISOString(),
        error_code: error instanceof Error ? error.message : "UNKNOWN_ERROR",
      })
      .eq("id", run.id);

    throw error;
  }
}
