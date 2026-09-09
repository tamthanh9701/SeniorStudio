import type { SupabaseClient } from "@supabase/supabase-js";
import { getServiceClient } from "@/supabase/server";

export type QuotaRouteGroup = "brain" | "image";
export type QuotaReservation = { reservationId: string };

export async function reserveImageQuota(_client: SupabaseClient, workspaceId: string, units: number): Promise<string> {
  const service = getServiceClient();
  const { data, error } = await service.rpc("reserve_ai_quota", { p_workspace_id: workspaceId, p_route_group: "image", p_units: units });
  if (error) {
    if (error.message.includes("quota_exceeded")) throw new Error("quota_exceeded");
    throw new Error(`QUOTA_UNAVAILABLE: ${error.message}`);
  }
  return data as string;
}

export async function beginAiProvider(service: SupabaseClient, jobId: string, workerId: string): Promise<void> {
  const { error } = await service.rpc("begin_ai_job_provider", { p_job_id: jobId, p_worker_id: workerId });
  if (error) {
    if (error.message.includes("PROVIDER_ALREADY_STARTED")) throw new Error("PROVIDER_ALREADY_STARTED");
    throw new Error(`QUOTA_UNAVAILABLE: ${error.message}`);
  }
}

export async function releaseReservation(service: SupabaseClient, reservationId: string): Promise<void> {
  const { error } = await service.rpc("release_ai_reservation", { p_reservation_id: reservationId });
  if (error) throw new Error(`QUOTA_UNAVAILABLE: ${error.message}`);
}

export async function reserveBrainQuota(_client: SupabaseClient, workspaceId: string): Promise<string> {
  const service = getServiceClient();
  const reservationId = crypto.randomUUID();
  const { error } = await service.rpc("reserve_brain_quota", { p_workspace_id: workspaceId, p_reservation_id: reservationId });
  if (error) {
    if (error.message.includes("quota_exceeded")) throw new Error("quota_exceeded");
    throw new Error(`QUOTA_UNAVAILABLE: ${error.message}`);
  }
  return reservationId;
}

export async function beginBrainOperation(service: SupabaseClient, reservationId: string): Promise<void> {
  const { error } = await service.rpc("begin_brain_operation", { p_reservation_id: reservationId });
  if (error) throw new Error(`QUOTA_UNAVAILABLE: ${error.message}`);
}

export async function withBrainQuota<T>(client: SupabaseClient, workspaceId: string, task: () => Promise<T>): Promise<T> {
  const reservationId = await reserveBrainQuota(client, workspaceId);
  await beginBrainOperation(getServiceClient(), reservationId);
  return task();
}
