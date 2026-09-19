// Shared request/response plumbing for the Game UI routes: ownership checks,
// the error envelope, and the small amount of parsing every route repeats.
import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { GameUiError } from "./errors";
import { apiErrorFrom } from "@/lib/http/api-errors";

export function errorResponse(error: unknown, fallback: { code: string; status: number } = { code: "INVALID_REQUEST", status: 400 }) {
  const failure = apiErrorFrom(error, { fallbackCode: fallback.code, fallbackStatus: fallback.status });
  return NextResponse.json({ error: { code: failure.code, message: failure.message } }, { status: failure.status });
}

/**
 * A style the caller can see, proven to be a Game UI style.  Foreign and missing
 * ids answer the same way on purpose: the response must not reveal that a style
 * exists in someone else's workspace.
 */
export async function requireGameUiStyle(
  client: SupabaseClient,
  styleId: string,
): Promise<{ id: string; workspace_id: string; status: string; library_id: string | null; confirmed_definition: unknown }> {
  const { data, error } = await client
    .from("styles")
    .select("id, workspace_id, status, domain, library_id, confirmed_definition")
    .eq("id", styleId)
    .maybeSingle();
  if (error || !data) throw new GameUiError("NOT_FOUND", "Style not found");
  if (data.domain !== "game_ui") throw new GameUiError("NOT_FOUND", "Style not found");
  return data as { id: string; workspace_id: string; status: string; library_id: string | null; confirmed_definition: unknown };
}

export async function requireOwnedScreen(client: SupabaseClient, screenId: string) {
  const { data, error } = await client.from("game_ui_screens").select("*").eq("id", screenId).maybeSingle();
  if (error || !data) throw new GameUiError("SCREEN_NOT_FOUND", "Screen not found");
  return data as Record<string, unknown> & { id: string; style_id: string; workspace_id: string };
}

export async function requireOwnedRender(client: SupabaseClient, renderId: string) {
  const { data, error } = await client.from("game_ui_renders").select("*").eq("id", renderId).maybeSingle();
  if (error || !data) throw new GameUiError("RENDER_NOT_FOUND", "Generated screen not found");
  return data as Record<string, unknown> & { id: string; style_id: string; screen_id: string; workspace_id: string; asset_id: string; version_id: string };
}

/** The newest saved element map of a render, which is the only editable one. */
export async function latestElementSet(client: SupabaseClient, renderId: string) {
  const { data } = await client
    .from("game_ui_element_sets")
    .select("id, revision, document")
    .eq("render_id", renderId)
    .order("revision", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data ?? null) as { id: string; revision: number; document: unknown } | null;
}

export async function readJson(request: Request): Promise<unknown> {
  return request.json().catch(() => null);
}
