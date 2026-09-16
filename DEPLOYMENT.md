# SeniorStudio Deployment Guide

## Quick Deploy to Vercel

### Option 1: Deploy via Vercel CLI

1. **Login to Vercel**
   ```bash
   vercel login
   ```

2. **Set Environment Variables**
   
   Create a `.env.local` file with your actual values:
   ```bash
   cp .env.production.example .env.local
   # Edit .env.local with your actual values
   ```

3. **Deploy**
   ```bash
   vercel --prod
   ```

### Option 2: Deploy via GitHub Integration

1. Push code to GitHub (already done)
2. Go to [vercel.com/new](https://vercel.com/new)
3. Import `tamthanh9701/SeniorStudio`
4. Configure environment variables in Vercel Dashboard
5. Deploy

## Environment Variables

Set these in Vercel Dashboard → Settings → Environment Variables:

### Required Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | `https://xxx.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key (publishable key) | `eyJhbG...` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key | `eyJhbG...` |
| `OWNER_EMAIL` | Your email for auth | `you@example.com` |
| `CRON_SECRET` | Secret for cron jobs | `random-secret-string` |

### Optional Variables (Only for web-based generation)

| Variable | Description | Example |
|----------|-------------|---------|
| `OPENAI_API_KEY` | OpenAI API key | `sk-...` |
| `OPENAI_IMAGE_MODEL` | OpenAI image model | `gpt-image-2` |
| `GOOGLE_IMAGE_MODEL` | Default Google image model | `gemini-3.1-flash-image` |
| `GEMINI_API_KEY` | Google AI Studio key (enables Google models) | `AIza...` |
| `AI_WORKER_SECRET` | Bearer secret for the worker entry point | `random-secret-string` |
| `AI_DAILY_LIMIT_BRAIN` | Per-user daily limit for vision calls (default 200) | `200` |
| `AI_DAILY_LIMIT_IMAGE` | Per-user daily limit for image jobs (default 100) | `100` |
| `STYLE_PROFILES_ENABLED` | Style module on/off | `true` |
| `STYLE_ANALYSIS_PROVIDER` / `STYLE_ANALYSIS_MODEL` | Override the vision model used for style analysis | `google` / `gemini-3.1-flash-image` |
| `MCP_IMAGE_DOWNLOAD_HOSTS` | Extra hosts MCP may download images from (comma separated) | `cdn.example.com` |
| `NEXT_PUBLIC_APP_URL` | Absolute app URL where links are generated | `https://your-deployment.example` |

**Note:** If you're only using MCP handoff (ChatGPT generates images and saves to SeniorStudio), you don't need `OPENAI_API_KEY`.

## Post-Deployment Steps

1. **Update Supabase Redirect URLs**
   - Go to Supabase Dashboard → Authentication → URL Configuration
   - Add `https://senior-studio.vercel.app/auth/callback` to Redirect URLs

2. **Test the Application**
   - Visit your deployed URL
   - Login with your configured email
   - Create a project
   - Test MCP integration with ChatGPT

## Troubleshooting

### Build Fails with Environment Errors

The build requires environment variables. If deploying via CLI:

```bash
# Option 1: Use Vercel Env CLI
vercel env add NEXT_PUBLIC_SUPABASE_URL production
# Enter value when prompted

# Option 2: Set via Dashboard
# Go to vercel.com → your project → Settings → Environment Variables
```

### MCP Integration Not Working

1. Check that your email matches `OWNER_EMAIL`
2. Verify MCP endpoint: `https://your-domain.vercel.app/api/mcp`

## How the worker is driven

`pg_cron` + `pg_net` post to the `ai-worker` Edge Function every five seconds; that function
reads `get_ai_worker_config()` (worker URL + secret) and forwards to
`/api/internal/ai-worker`. The Vercel cron entry in `vercel.json` only records a heartbeat.
The route claims up to three jobs per invocation and also sweeps expired inpaint masks and
reconciles uploads kept after an unreadable persistence outcome, so those cleanups run on
the same five-second cadence.

## Storage orphan audit

`pnpm exec tsx scripts/audit-storage-orphans.ts <workspace-id> [--limit <depth>]` walks the
`assets` bucket under that workspace prefix and prints every object that no row references in
`style_references.storage_path`, `asset_versions.storage_path` or `ai_job_inputs.storage_path`,
one path per line, ending with a `orphans=<n>` summary. It is read-only — it audits and deletes
nothing, so removing anything it reports stays a manual, deliberate step.

## Quota scopes

Two limits gate AI usage and they are configured in different places:

- Per user per day, read from the environment by `src/lib/ai/quota.ts`
  (`AI_DAILY_LIMIT_BRAIN`, `AI_DAILY_LIMIT_IMAGE`, defaults 200/100). These gate the
  synchronous vision routes (style analysis, tuning, validation, synthesis, fidelity).
- Per workspace per day, stored in the `workspace_ai_limits` table (defaults 100 images,
  200 brain operations). These gate every enqueued job through the reservation RPCs.

Changing one does not change the other.

## Staging verification (optional)

`scripts/apply-staging-migrations.ts` and `scripts/verify-staging-target.ts` only run in a
protected environment, and refuse to touch anything unless these are set (run them through
`pnpm db:staging:apply` and `pnpm db:staging:verify`):

`STAGING_SUPABASE_PROJECT_REF`, `STAGING_DB_HOST`, `STAGING_DB_PORT`, `STAGING_DB_USER`,
`STAGING_DB_CA`, `TEST_DATABASE_URL`, `ALLOW_STAGING_MIGRATIONS=1`, `STAGING_APPLY_MUTATION`.

The database and online suites are skipped by default; they need `RUN_DB_INTEGRATION=1`
(with `TEST_DATABASE_URL`; `STAGING_DB_CA` is optional and only switches the connection
to verify the server certificate) and `RUN_ONLINE_E2E=1` with an HTTPS
`STAGING_APP_URL`.

## Auth: the per-request round trip (infrastructure item, not a code change)

Every request handler starts with `supabase.auth.getUser()`, which asks the Supabase auth
server over the network. Measured against production that call costs ~0.8 s per handler,
and a request that runs several of them pays it every time. It cannot be removed in
application code while the project signs its JWTs symmetrically: the header of
`NEXT_PUBLIC_SUPABASE_ANON_KEY` decodes to `{"alg":"HS256","typ":"JWT"}`, and a shared
secret cannot be shipped to the client, so a token can only be verified with a round trip.

The switch, in this order:

1. Rotate the project to an asymmetric signing key: Supabase dashboard → Project Settings →
   API → JWT signing keys (`unverified — confirm first`: the menu has moved between
   releases). Publish the new key and keep the legacy secret until every client has moved.
2. Replace `auth.getUser()` with `auth.getClaims()` in the call sites — today 63
   (`grep -rn "auth.getUser()" src/`), 50 of them in route handlers. `getClaims()` verifies
   the token locally against the project's JWKS, so the round trip disappears; the claims it
   returns (`sub`, `role`, expiry) are the ones the handlers already read.

Ship the code and the rotation together. With a symmetric key `getClaims()` falls back to
the same network call (`unverified — confirm first` against the supabase-js documentation
for the version in `package.json`), so deploying one half on its own buys nothing.

Expected effect: one auth round trip per handler becomes zero.
