import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient, getServiceClient } from "@/supabase/server";

export type AiRouteGroup = "brain" | "image";

const GROUP_LIMIT_ENV: Record<AiRouteGroup, string> = {
  brain: "AI_DAILY_LIMIT_BRAIN",
  image: "AI_DAILY_LIMIT_IMAGE",
};

export const DEFAULT_LIMITS: Record<AiRouteGroup, number> = {
  brain: 200,
  image: 100,
};

export function getAiQuotaLimit(group: AiRouteGroup): number {
  const raw = process.env[GROUP_LIMIT_ENV[group]];
  if (raw === undefined || raw.trim() === "") return DEFAULT_LIMITS[group];
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : DEFAULT_LIMITS[group];
}

type QuotaClient = Pick<SupabaseClient, "from">;

export async function checkAndIncrementUsage(
  client: QuotaClient,
  userId: string,
  group: AiRouteGroup,
  limit: number,
  day: string,
): Promise<boolean> {
  if (!client || typeof client.from !== "function") return true;
  if (limit <= 0) return true;

  const { data } = await client
    .from("ai_usage_quota")
    .select("count")
    .match({ user_id: userId, day, route_group: group })
    .maybeSingle();
  const used = typeof data?.count === "number" ? data.count : 0;
  if (used >= limit) return false;

  const { error } = await client.from("ai_usage_quota").upsert(
    { user_id: userId, day, route_group: group, count: used + 1 },
    { onConflict: "user_id,day,route_group" },
  );
  if (error) {
    console.error("[quota] failed to increment usage:", JSON.stringify(error).slice(0, 200));
  }
  return true;
}

export type QuotaGate =
  | { ok: true }
  | { ok: false; response: Response };

export async function enforceAiQuota(_request: Request, group: AiRouteGroup): Promise<QuotaGate> {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return {
      ok: false,
      response: Response.json(
        { error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
        { status: 401 },
      ),
    };
  }

  const limit = getAiQuotaLimit(group);
  if (limit <= 0) return { ok: true };

  // Resolve workspace from membership
  const { data: member, error: memberError } = await getServiceClient()
    .from("workspace_members")
    .select("workspace_id")
    .eq("supabase_user_id", user.id)
    .maybeSingle();

  if (memberError || !member) {
    return {
      ok: false,
      response: Response.json(
        { error: { code: "QUOTA_UNAVAILABLE", message: "Unable to check quota status" } },
        { status: 503 },
      ),
    };
  }

  // Query workspace-level quota status via RPC
  const { data: status, error: statusError } = await getServiceClient().rpc("get_ai_quota_status", {
    p_workspace_id: member.workspace_id,
  });

  if (statusError) {
    return {
      ok: false,
      response: Response.json(
        { error: { code: "QUOTA_UNAVAILABLE", message: "Unable to verify quota status" } },
        { status: 503 },
      ),
    };
  }

  const groupStatus = status?.[group];
  if (!groupStatus) {
    return {
      ok: false,
      response: Response.json(
        { error: { code: "QUOTA_UNAVAILABLE", message: "Invalid quota group" } },
        { status: 503 },
      ),
    };
  }

  const { limit: groupLimit, held, charged } = groupStatus;
  const effectiveLimit = typeof groupLimit === "number" ? groupLimit : limit;
  const totalUsed = (typeof held === "number" ? held : 0) + (typeof charged === "number" ? charged : 0);

  if (totalUsed >= effectiveLimit) {
    return {
      ok: false,
      response: Response.json(
        {
          error: {
            code: "quota_exceeded",
            group,
            limit: effectiveLimit,
            message: `Daily ${group} request limit (${effectiveLimit}) reached. Try again tomorrow.`,
          },
        },
        { status: 429 },
      ),
    };
  }

  return { ok: true };
}
