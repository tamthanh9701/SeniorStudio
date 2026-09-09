import type { SupabaseClient } from "@supabase/supabase-js";
import type { AiJob } from "@/db/ai-jobs";
import { assertModelSupports } from "@/lib/ai/models";
import { openAiProvider } from "./openai";
import { googleProvider } from "./google";
import type { ImageProvider } from "./types";

export async function providerForJob(job: AiJob, client: SupabaseClient): Promise<ImageProvider> {
  const catalogModel = await assertModelSupports(job.model, job.operation, client, job.workspace_id);
  if (catalogModel.provider !== job.provider) throw new Error("INVALID_MODEL");
  switch (job.provider) {
    case "openai": return openAiProvider;
    case "google": return googleProvider;
    default: {
      const exhaustive: never = job.provider;
      throw new Error(`INVALID_MODEL:${exhaustive}`);
    }
  }
}
