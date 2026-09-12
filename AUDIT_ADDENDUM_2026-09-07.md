# AUDIT_ADDENDUM_2026-09-07.md

## 10. Thêm phát hiện generation workflow

Bản thân audit report không thêm section riêng vì các phát hiện này đã phản ánh bằng nhãn P1/P2 trong báo cáo chính. Thêmicional slice từ reviewer generation đáng chú ý:

### G10-1 — RPC enqueue_image không enforce image quota

**Ưu tiên P1 · Source-traced.**

**Vị trí:** `supabase/migrations/0023_style_module_jobs.sql:21-92`; `src/app/api/projects/[projectId]/ai-jobs/route.ts:35-36`; `src/app/api/style/ai-jobs/route.ts:45-46`.

RPC `enqueue_ai_job` kiểm tra auth/workspace/shape nhưng không đọc/increment `ai_usage_quota`. Route HTTP có `enforceAiQuota` trước khi gọi RPC; nhưng RPC được execute trực tiếp bởi authenticated users thì bypass image quota. RPC cũng chấp nhận `p_count` 1-4 cho `text_to_image`, không bookkeeping mỗi ảnh riêng.

**Hệ quả:** user có thể enqueue nhiều hơn 100 ảnh/ngày bằng RPC trực tiếp. soft quota chỉ là reference count, không phải hard cap cho image requests.

**Sửa:** atomic RPC-level quota hoặc audit enforcement trên RPC itself; nếu giữ HTTP-only quota, ghi rõ RPC là privileged path và khóa privilege này.

### G10-2 — Cost mode UI tồn tại nhưng không enforce trong worker

**Ưu tiên P1/P2 · Source-traced.**

**Vị trí:** `src/db/ai-jobs.ts:29-33,58-60`; `src/app/api/projects/[projectId]/ai-jobs/route.ts:54-56`; `src/app/api/style/ai-jobs/route.ts:61-62`; `src/lib/ai/worker.ts:67-103`.

`compileStyledPrompt` áp dụng budget ở enqueue-time nhưng worker chỉ dùng `job.input.prompt` text. RPC signature không có `p_cost_mode`. Job input schema chấp nhận `cost_mode` nhưng worker không đọc.

**Hệ quả:** cost mode UI không thay đổi worker behavior; reference limit, temperature và preserveRequestedModel không enforce. Tabs expense mỗi request đều như nhau bất kể mode. Contractor dùng capsule text khác nhau nhưng worker không biết mode nào đã chọn.

**Sửa:** hoặc persists cost_mode vào job input và worker enforce (ít nhất temperature và reference limit), hoặc remove UI để tránh nhầm lẫn người dùng. Không quảng bá cost modes như expense control nếu chúng chỉ thay đổi capsule length.

### G10-3 — Generation Audit xác nhận fingerprint wiring đã thường trực

**Ưu tiên P1 · Source-traced + reproduced.**

**Vị trí:** `src/lib/style/service.ts:183-186`; `src/lib/style/fingerprint.ts:145-199,203-214`.

`compileStyledPrompt` chọn `style.fingerprint` bất cứ khi nào nó tồn tại, bypassing schema-led prompt builder. Fingerprint hardcodes illustrative defaults (outline, pastel fills, hatching, three hue families, holiday/cinema content ignores).

**Hệ quả:** mọi style có fingerprint — bao gồm photography/photorealistic, painting, monochrome — đều nhận quy tắc vector illustration. Đây là regression so với plan ban đầu dự kiến fingerprint chỉ áp dụng khi có bằng chứng.

**Sửa:** fingerprint phải detect style family từ fingerprint data; nếu detection là unknown hoặc photographic, không thêm illustrative constraints; hoặc revert fingerprint selection thành conditional based on evidence.

### G10-4 — Project route error normalizer không map NOT_FOUND thành 503

**Ưu tiên P2 · Source-traced.**

**Vị trí:** `src/app/api/projects/[projectId]/ai-jobs/route.ts:29-31`; `src/app/api/style/ai-jobs/route.ts:84-85`.

Route normalizer map `NOT_FOUND` → HTTP 404; `PROVIDER_NOT_CONFIGURED` → HTTP 503. Workspace membership errors raise `NOT_FOUND` trong RPC (0023:34-39) nên trả 404. Không có mapping nào gửi 503 cho auth issues.

**Hệ quả:** 503 chỉ xuất hiện khi provider key missing, không phải auth failures. Không có regression về ẩn auth errors; nhưng nếu có RPC state nào raise 503 unexpected, nó không được normalizer xử lý.

**Sửa:** giữ nguyên current behavior; audit claim trước đây đã sai. Nếu muốn distinguish workspace membership errors, dùng separate RPC error code và map riêng.
