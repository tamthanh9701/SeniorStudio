# SeniorStudio Architecture

## Runtime boundary

SeniorStudio is one Next.js 16 application deployed on Vercel. Route handlers are the authenticated API boundary. There is no browser-automation worker, browser container, Redis queue, secondary API server, or custom WebSocket service.

## Durable image jobs

Supabase PostgreSQL stores `ai_jobs`. Web clients create jobs only through `enqueue_ai_job`; authenticated row-level security is select-only. Service-role RPCs claim jobs with `FOR UPDATE SKIP LOCKED`, lease them, record provider request IDs, transition status, and complete or fail jobs. Supabase Realtime publishes `ai_jobs` updates. The UI falls back to authenticated two-second polling when Realtime is unavailable.

Persisted states are `queued`, `submitting`, `processing`, `persisting`, `succeeded`, `failed`, and `canceled`. The selected provider and model are immutable job fields. No provider fallback occurs.

## Worker scheduling

A scheduled Supabase Edge Function invokes `POST /api/internal/ai-worker` once per minute with `AI_WORKER_SECRET`. The Edge Function contains no provider or service-role logic. PostgreSQL `pg_cron` and `pg_net` configure the schedule when available; deployments that cannot enable those extensions configure the same schedule in the Supabase Dashboard.

Each Vercel worker invocation claims at most three jobs with a 120-second lease and processes them concurrently. OpenAI and Google AI Studio image calls complete synchronously within one worker invocation.

## Model catalog and providers

The static catalog exposes exactly three model IDs:

- `openai/gpt-image-2`: text-to-image and masked inpaint.
- `google/gemini-3.1-flash-image`: text-to-image through Google Nano Banana 2.

The frontend sends the exact model ID. `src/lib/ai/providers/index.ts` performs exhaustive provider/model dispatch.

The OpenAI adapter calls `images.generate` and `images.edit`, decodes `b64_json` directly, and normalizes inpaint masks to RGBA PNG. The Google adapter uses the official `@google/genai` Interactions API with `store: false`, requests Nano Banana 2 output at the selected aspect ratio, and decodes `output_image.data` immediately.

## Atomic asset persistence

Provider results converge on `ingestImageBytes` in `src/lib/assets/service.ts`. It validates decoded image bytes, uploads to private Supabase Storage, and calls the existing `commit_asset_version` RPC with explicit asset and version IDs. If the transaction fails, the uploaded object is removed.

Text-to-image creates one immutable asset per returned image. `output.results` records every asset/version pair. Inpaint reuses the existing asset ID and commits a child version with the exact submitted `parent_version_id`; the original storage object remains unchanged. `assets.current_version_id` advances only through `commit_asset_version`.

## Mask inputs

Canonical masks are exact-size RGBA PNG files. Transparent pixels identify edit regions for OpenAI. Temporary masks live in private storage and `ai_job_inputs`, expire after one hour, bind to one job, and are removed after terminal success, failure, or cancellation.

## Web experience

Project pages contain an asynchronous generation panel with model, prompt, compatible size, compatible quality, and count controls. Job cards show the full lifecycle, provider/model, stable errors, cancellation when permitted, and all generated results.

The asset edit page keeps the mask and prompt visible while inpaint runs. It navigates to the asset only after the new child version succeeds. Version history displays provider, model, and operation metadata; comparison uses the child version's exact parent.

## Optional MCP channel

`/api/mcp`, Auth0 discovery, MCP project/asset tools, `save_generated_image`, `save_edited_image`, and the Apps SDK image saver remain available. MCP saves externally supplied image bytes through the same `ingestImage`/`ingestImageBytes` boundary. MCP does not enqueue provider jobs and does not automate ChatGPT Web.

## Deferred systems

Local ComfyUI integration is deferred until the target host GPU, VRAM, drivers, model licenses, and workflow JSON are known. Billing tiers, prompt caching, layer decomposition, background removal, relighting, multi-view generation, OCR editing, mood boards, and template systems are outside this release. Provider pricing remains external operational data rather than an architectural invariant.
