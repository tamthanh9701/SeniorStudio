import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// Scheduled trigger for the application worker. JWT verification is off because the
// caller is pg_cron through pg_net, so the function authenticates the request itself:
// only the scheduled job knows the worker secret, and it arrives in x-worker-secret.
// Without that check this endpoint was an open trigger for service-role worker runs
// (2026-09-17 review).
Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    return new Response("Supabase runtime credentials are unavailable", { status: 500 });
  }

  const client = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: config, error } = await client.rpc("get_ai_worker_config");
  if (error || !config?.url || !config?.secret) {
    return new Response("Worker configuration is unavailable", { status: 500 });
  }

  if (req.headers.get("x-worker-secret") !== config.secret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.secret}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });

  return new Response(await response.text(), {
    status: response.status,
    headers: {
      "Content-Type": response.headers.get("content-type") ?? "application/json",
    },
  });
});
