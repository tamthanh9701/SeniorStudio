// Checks a configured provider key against the provider's own metadata endpoint: the same
// call the model catalog makes for Google, and the model list for OpenAI. Read-only on
// the provider side and cheap enough to run on demand.
import { NextResponse } from "next/server";
import { z } from "zod";
import { AiProviderSchema } from "@/db/ai-jobs";
import { createClient, getServiceClient } from "@/supabase/server";
import { getVerifiedUser } from "@/lib/auth/verified-user";
import { resolveUserWorkspaceId } from "@/lib/ai/models";
import { getProviderApiKey } from "@/lib/ai/credentials";

const CheckSchema = z.object({ provider: AiProviderSchema }).strict();
const GOOGLE_MODELS_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";
/** The provider must answer inside this window or the check reports it as unreachable. */
const TIMEOUT_MS = 10_000;

function providerMessage(body: unknown, fallback: string): string {
  const record = body as { error?: { message?: string }; message?: string } | null;
  return record?.error?.message ?? record?.message ?? fallback;
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const user = await getVerifiedUser(supabase);
  if (!user) return NextResponse.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
  const parsed = CheckSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: { code: "INVALID_REQUEST", message: "Unknown provider" } }, { status: 400 });
  const workspaceId = await resolveUserWorkspaceId(supabase, user.id);
  if (!workspaceId) return NextResponse.json({ error: { code: "NOT_FOUND", message: "Workspace not found" } }, { status: 404 });
  const apiKey = await getProviderApiKey(parsed.data.provider, { service: getServiceClient(), workspaceId });
  if (!apiKey) return NextResponse.json({ error: { code: "NOT_CONFIGURED", message: "No API key is configured for this provider" } }, { status: 404 });

  try {
    if (parsed.data.provider === "google") {
      const response = await fetch(`${GOOGLE_MODELS_URL}?key=${encodeURIComponent(apiKey)}&pageSize=100`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      const body = (await response.json().catch(() => null)) as { models?: Array<{ name?: string }> } | null;
      if (!response.ok) return NextResponse.json({ ok: false, code: "PROVIDER_REJECTED", message: providerMessage(body, `The provider answered ${response.status}`) });
      const models = Array.isArray(body?.models) ? body.models : [];
      return NextResponse.json({ ok: true, models: models.length, imageModels: models.filter((model) => /image/i.test(model.name ?? "")).length });
    }
    const response = await fetch(OPENAI_MODELS_URL, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const body = (await response.json().catch(() => null)) as { data?: unknown[] } | null;
    if (!response.ok) return NextResponse.json({ ok: false, code: "PROVIDER_REJECTED", message: providerMessage(body, `The provider answered ${response.status}`) });
    return NextResponse.json({ ok: true, models: Array.isArray(body?.data) ? body.data.length : 0 });
  } catch (error) {
    return NextResponse.json({ ok: false, code: "PROVIDER_UNREACHABLE", message: error instanceof Error ? error.message : "The provider could not be reached" });
  }
}
