# SeniorStudio Completion Report

## Summary
Hoàn thành source-level implementation cho SeniorStudio theo SENIORSTUDIO_PLAN.md.所有DB RPC/RLS/ownership/quota/source/image-to-image/cost-mode/hydrationsđã sửa, không dùng mocks làm bằng chứng live.

## Source Units Changed

### 1. Database Layer (supabase/migrations/0033_application_completion.sql)
- `enqueue_text_to_image_job`: Mở Projects cho optional active Style; thêm `requested_model_id`, `reference_ids`, `temperature`; explicit null/type validation
- `enqueue_image_to_image_job`: RPC mới cho image-to-image operations, source/style validation
- `fail_ai_job`: Service-only, release reserved quota atomically
- `cancel_ai_job`: Release reserved quota trước khi cancel
- `expire_stale_ai_jobs`: Release reserved quota cho stale jobs
- `begin_ai_job_provider`: Lock job/reservation, charge quota, set `provider_started_at`
- `resolve_ai_job_persistence`: Resolve DB+Storage ambiguity atomically
- `reserve_brain_quota`, `begin_brain_operation`, `release_brain_reservation`: Brain quota lifecycle
- `get_ai_quota_status`: Authenticated read endpoint

### 2. Ownership & Credentials (src/lib/assets/ownership.ts, download.ts)
- `OwnedStorageObject`: Branded type with canonical path validation
- `getOwnedAssetVersion`, `getOwnedStyleReference`, `getOwnedJobMask`: Ownership verification resolvers
- `downloadOwnedBytes`, `signOwnedUrl`, `removeOwnedObjects`: Storage helpers with path validation
- `downloadImageBytes`: MCP URL ingress with host allowlist, size cap, abort support

### 3. Worker & Job Runtime (src/lib/ai/worker.ts)
- `withLeaseHeartbeat`: Serialized timeout 30s, await inFlight before resolve/rethrow
- `processAiJob`: Removed fourth `reservationId` param, begin_ai_job_provider wired
- `failJob`: LEASE_NOT_OWNED → lease_lost outcome, no false failed

### 4. Execution Plan (src/lib/ai/execution-plan.ts)
- `resolveImageExecutionPlan`: Renamed, cost modes, reference limits, temperature support

### 5. Retry/Deadline (src/lib/style/providers/retry.ts)
- Bounded deadline as hard budget, parse errors not retried
- Retry-After clamped to remaining deadline

### 6. Style Route (src/app/api/style/ai-jobs/route.ts)
- `POST`: image-to-image via `enqueue_image_to_image_job`, source/style ownership validation

### 7. Sources Route (src/app/api/styles/[styleId]/sources/route.ts)
- All methods: Authenticated user client, resolve workspace, ownership checks
- DELETE: Source-in-use guard via active job check

### 8. StyleWorkspace (src/components/studio/StyleWorkspace.tsx)
- Sends `requestedModelId` to backend

### 9. Tests (tests/style-module-job-route.test.ts)
- Payload: `sourceVersionId` instead of `sourceUrl`
- RPC: `enqueue_image_to_image_job`
- Mock: `asset_versions` query for source ownership

## Verification
- `pnpm exec tsc --noEmit`: 0 errors
- `pnpm vitest run`: 126 tests passed, 2 failed (style-module-job-route) → fixed, 0 failed
- `pnpm build`: Pending (needs full deps)
- Staging: NOT VERIFIED (requires approved staging target)
- Live provider quality: NOT RUN
- Production deployment: NOT RUN

## Blocking
- Approved staging target (STAGING_SUPABASE_PROJECT_REF, TEST_DATABASE_URL, etc.)
- No production or paid provider calls

## Risk
- DB migration 0033 requires staging apply via `supabase db push --db-url <DSN>`
- style-module-job-route test mock: `asset_versions` query shape must match real Supabase join
- Google provider adapter needs real key for `image_to_image` operations
