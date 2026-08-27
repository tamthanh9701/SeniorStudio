# SeniorStudio

MCP-first AI Image Studio built with Next.js, Supabase, and OpenAI.

## Features

- **MCP Integration**: ChatGPT can generate/edit images and save directly to SeniorStudio
- **Non-destructive Versioning**: Branch-aware version history with parent-child relationships
- **Mask Editor**: Paint masks for precise image editing with react-konva
- **Layer System**: Overlay text, shapes, and images with transform controls
- **Batch Processing**: Process up to 4 images concurrently
- **Ingredients**: Named references for consistent subject identity across edits
- **Presets**: Reusable generation/edit/document templates

## Quick Start

### 1. Clone and Install

```bash
git clone https://github.com/tamthanh9701/SeniorStudio.git
cd SeniorStudio
pnpm install
```

### 2. Environment Setup

Copy `.env.example` to `.env.local` and fill in:

```bash
cp .env.example .env.local
```

Required variables:
- `NEXT_PUBLIC_SUPABASE_URL` - Supabase project URL
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` - Supabase anon key
- `SUPABASE_SERVICE_ROLE_KEY` - Supabase service role key
- `OWNER_EMAIL` - Your email for authentication
- `AUTH0_ISSUER_BASE_URL` - Auth0 tenant URL
- `AUTH0_AUDIENCE` - Auth0 API audience
- `OPENAI_API_KEY` - OpenAI API key
- `CRON_SECRET` - Secret for cron jobs

### 3. Database Setup

Apply migrations to your Supabase project:

```bash
# Using Supabase CLI
supabase db push

# Or manually run SQL files in supabase/migrations/
```

### 4. Run Development Server

```bash
pnpm dev
```

Open http://localhost:3000

## Deployment to Vercel

### 1. Push to GitHub

```bash
git push origin main
```

### 2. Import to Vercel

1. Go to https://vercel.com/new
2. Import `tamthanh9701/SeniorStudio`
3. Configure environment variables
4. Deploy

### 3. Configure Cron Job

Add to `vercel.json`:
```json
{
  "crons": [{
    "path": "/api/cron/supabase-heartbeat",
    "schedule": "0 6 * * *"
  }]
}
```

## Architecture

```
src/
├── app/                    # Next.js App Router
│   ├── api/
│   │   ├── mcp/           # MCP server endpoint
│   │   ├── generate/      # Image generation API
│   │   ├── batch/         # Batch processing API
│   │   └── cron/          # Scheduled jobs
│   ├── projects/          # Project management
│   └── login/             # Authentication
├── components/
│   └── editor/            # Konva-based editor components
├── lib/
│   ├── assets/            # Asset service (ingest, signed URLs)
│   ├── openai/            # OpenAI Responses API integration
│   ├── mcp/               # MCP server and tools
│   └── ingredients/       # Prompt compilation
└── db/
    └── migrations/        # Supabase SQL migrations
```

## MCP Integration

### Endpoints

- **MCP Server**: `POST /api/mcp`
- **OAuth Metadata**: `GET /api/mcp/.well-known/oauth-protected-resource`
- **OpenAPI Spec**: `GET /api/mcp/openapi.json`

### Tools

| Tool | Description | Scope |
|------|-------------|-------|
| `create_project` | Create new project | `projects:write` |
| `list_projects` | List all projects | `assets:read` |
| `save_generated_image` | Save ChatGPT-generated image | `assets:write` |
| `save_edited_image` | Save edited image as new version | `assets:write` |
| `get_asset` | Get asset with signed URL | `assets:read` |
| `get_asset_history` | Get version history | `assets:read` |
| `show_asset` | Render asset card | `assets:read` |

### ChatGPT Usage

1. Generate an image in ChatGPT
2. Ask ChatGPT to "save this to SeniorStudio"
3. ChatGPT calls `save_generated_image` with the file
4. Image appears in your web gallery

## Development

```bash
# Type checking
pnpm typecheck

# Tests
pnpm test

# Build
pnpm build

# E2E tests
pnpm exec playwright test
```

## License

MIT
