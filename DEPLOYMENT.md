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
| `OPENAI_ORCHESTRATOR_MODEL` | OpenAI model | `gpt-5.6` |

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
