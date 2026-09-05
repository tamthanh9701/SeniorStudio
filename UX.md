# SeniorStudio — Báo cáo UX Audit

**Ngày audit:** 2026-09-05
**Môi trường:** Vercel preview `senior-studio-kivddbv47` (`senior-studio-kivddbv47-jultees-projects.vercel.app`)
**Viewport:** desktop 1440×1000 · mobile 375×812
**Session:** `julirai.tamthanh@gmail.com`
**Phạm vi:** walkthrough toàn bộ luồng trên browser thật (đã đăng nhập) + đối chiếu source cho phần gating/trạng thái. Không sửa code — findings là đề xuất.

## Tổng quan

Nền tảng có UX nền tốt: dark theme nhất quán, empty state đầy đủ, icon button hầu hết có `aria-label`, skeleton loading route-level, gating logic chặt. Audit ghi nhận **13 findings: 2 High, 6 Medium, 5 Low** — không có lỗi chặn luồng chính, nhưng 2 lỗi High ảnh hưởng trực tiếp đến độ tin cậy của nội dung hiển thị (asset name chứa raw prompt) và thông báo lỗi cho end user (raw provider error).

## Bản đồ luồng

| # | Luồng | Route |
|---|---|---|
| 1 | Login (magic link) | `/login` |
| 2 | Projects Dashboard | `/projects` |
| 3 | Project Workspace — tabs Generate / Inpaint / Style | `/projects/[projectId]` |
| 4 | Asset Detail | `/projects/[projectId]/assets/[assetId]` |
| 5 | Mask Editor (từ Asset Detail) | `/projects/[projectId]/assets/[assetId]/edit` |
| 6 | Settings (AI providers, account) | `/settings` |

## Findings

### HIGH-1 — Asset name hiển thị raw compiled prompt

- **Mức độ:** High
- **Vị trí:** `/projects/{id}` — AssetCanvas + asset detail page
- **Bằng chứng:** Sidebar/canvas item hiện nguyên văn: `Select Style capsule: Smoke Test Style. Use these as visual rules only; do not copy the original subject, o…` — cột `name` của asset đang lưu full compiled prompt (capsule + subject) thay vì dòng subject của user; vùng h1 trên asset page cũng hiện cùng blob.
- **Đề xuất:** Khi tạo asset từ job, dùng `original_prompt` (đã có trong `job.input`) làm `name`, truncate ~80 ký tự; asset name nên là subject ngắn.

### HIGH-2 — Lỗi provider hiển thị raw kỹ thuật cho end user

- **Mức độ:** High
- **Vị trí:** `JobTimeline.tsx` — failed job card
- **Bằng chứng:** Text alert quan sát được: `PROVIDER_ERROR400 Unknown parameter: 'response_format'.` — raw error code dính liền HTTP status không có khoảng cách, không có lời giải thích hay action ngoài `Try again` (retry cùng lỗi sẽ lặp lại).
- **Đề xuất:** Map error code → human message (ví dụ `PROVIDER_ERROR` → "Nhà cung cấp ảnh từ chối yêu cầu. Thử đổi model hoặc liên hệ hỗ trợ."); tách code ra `title` attribute/secondary line; `Try again` nên hiện xác nhận nếu lỗi là deterministic.

### MEDIUM-1 — StylePanel thiếu trạng thái loading đầu panel

- **Mức độ:** Medium
- **Vị trí:** `/projects/{id}` tab Style — `StylePanel.tsx`
- **Bằng chứng:** Mở tab Style lần đầu trước khi `loadStyles()` trả về, panel chỉ hiện empty-state text `No styles yet. Upload reference images to capture a reusable visual style.` — trong audit danh sách trống ~1s rồi mới render 3 style; người dùng lần đầu sẽ tưởng chưa có style.
- **Đề xuất:** Thêm `loading` state (skeleton 2-3 row giống `RouteSkeleton`) phân biệt "đang tải" với "chưa có style".

### MEDIUM-2 — Nút create style không có accessible name

- **Mức độ:** Medium
- **Vị trí:** `StylePanel.tsx` dòng 156 — nút `+` kế input "New style name"
- **Bằng chứng:** Nút chỉ chứa icon `<Plus>`, không có `aria-label`; accessibility tree quan sát: `{role: "button", name: "", states: ["disabled"]}`.
- **Đề xuất:** Thêm `aria-label="Create style"`.

### MEDIUM-3 — Palette swatch row hiển thị `Palette: ` rỗng khi màu không phải HEX

- **Mức độ:** Medium
- **Vị trí:** `StylePanel.tsx` dòng 191 — `hexList()`
- **Bằng chứng:** `hexList()` lọc chỉ nhận `#XXXXXX`, schema có thể trả tên màu (`"red, orange"`) → dòng text trống có label nhưng không có swatch. Quan sát: `detected: ["Palette: "]` với swatchCount=2 (chỉ hiện khi có HEX).
- **Đề xuất:** Fallback hiện text màu khi không có HEX (dùng `dominant_colors` raw), hoặc ẩn cả dòng khi trống.

### MEDIUM-4 — Job progress bar 7 bước hiển thị cả trạng thái future kể cả khi failed/canceled

- **Mức độ:** Medium
- **Vị trí:** `JobTimeline.tsx` dòng 26 — progress strip
- **Bằng chứng:** Progress strip luôn render 7 segment `In queue/Starting/Generating/Saving/Complete/Failed/Canceled` như một chuỗi; job succeeded tô tối đa `Complete` nhưng user thấy `Failed`/`Canceled` như bước tiếp theo trong chuỗi. Text job card: `…Complete Failed Canceled` nối tiếp nhau.
- **Đề xuất:** Khi succeeded chỉ hiện 5 bước đầu; khi failed hiện 4 bước + Failed ở cuối — tức dynamic segment list theo trạng thái terminal.

### MEDIUM-5 — Countdown/đợi không có feedback giữa các poll 2s

- **Mức độ:** Medium
- **Vị trí:** `use-project-jobs.ts` + AssetCanvas
- **Bằng chứng:** Job đang chạy chỉ có spinner + label; canvas không có skeleton placeholder cho kết quả sắp tới; job card chỉ có chấm tròn `animate-pulse`, không có khối ảnh placeholder.
- **Đề xuất:** Thêm placeholder ô ảnh nhấp nháy trong AssetCanvas khi có job active.

### MEDIUM-6 — Retry của job có style dùng lại style đó nhưng không hiện indication

- **Mức độ:** Medium
- **Vị trí:** `ProjectWorkspace.tsx` dòng 45 — `retry()`
- **Bằng chứng:** `retry()` set `styleId` từ `job.input.style_id` và prompt gốc; user bấm `Try again` trên job lỗi không thấy style nào được chọn lại (dropdown update ngầm). Code: `job.input.original_prompt ?? job.input.prompt` + `setStyleId(job.input.style_id ?? null)`.
- **Đề xuất:** Sau retry, highlight style dropdown (ví dụ ring màu tím) hoặc toast "Retrying with style: X".

### LOW-1 — Mix Việt/Anh trong user content hiển thị nguyên bản prompt

- **Mức độ:** Low
- **Vị trí:** `/projects` — sidebar recent prompts
- **Bằng chứng:** `Thêm đôi cánh màu trắng vào áo hoodie khủng long Complete` — prompt tiếng Việt của user, label trạng thái tiếng Anh. Đây là data user-generated, chấp nhận được.
- **Đề xuất:** Nếu target user Việt, localize `JOB_STATUS_LABELS` (`Complete` → `Hoàn thành`) để nhất quán ngôn ngữ giao diện.

### LOW-2 — Nút remove reference ẩn sau hover trên desktop

- **Mức độ:** Low
- **Vị trí:** `StylePanel.tsx` dòng 177 — nút remove reference
- **Bằng chứng:** Class trong source: `opacity-0 sm:group-hover:opacity-100` — keyboard user không hover không thấy nút; mobile thì luôn hiện (`opacity-100`).
- **Đề xuất:** Thêm `focus-visible:opacity-100` hoặc luôn hiển thị ở opacity thấp.

### LOW-3 — `Settings` không có section cho Style Profiles

- **Mức độ:** Low
- **Vị trí:** `/settings`
- **Bằng chứng:** Trang chỉ có 2 provider cards (AI providers + account), không có quản lý style chung.
- **Đề xuất:** Khi tính năng style mature: thêm section quản lý style (nếu cần), hoặc bỏ qua — style đang nằm đúng ngữ cảnh trong workspace.

### LOW-4 — `Zoom to fit` / `View at 100 percent` là hai nút riêng thay vì toggle

- **Mức độ:** Low
- **Vị trí:** `AssetCanvas.tsx` dòng 15
- **Bằng chứng:** Hai icon button cạnh nhau, không có trạng thái active.
- **Đề xuất:** Gộp thành toggle một nút, active state có background.

### LOW-5 — Composer character limit 8000 không hiển thị

- **Mức độ:** Low
- **Vị trí:** `GenerationComposer.tsx` dòng 27
- **Bằng chứng:** `maxLength={8000}` trong source, không có counter — user dán prompt dài sẽ bị cắt im lặng.
- **Đề xuất:** Hiện counter `n/8000` khi > 7000 ký tự.

## Điểm mạnh

- Dark theme nhất quán, contrast tốt, không có layout break ở 375px (không horizontal overflow, bottom nav `Studio navigation` hiện đúng).
- Empty state tốt: dashboard (`Create your first project`), canvas (nút focus composer), style panel.
- Icon-only buttons hầu hết có `aria-label` (chỉ 1 exception — Finding MEDIUM-2); slider có đầy đủ `aria-valuemin/max/now` + keyboard arrows.
- Loading skeletons route-level (`RouteSkeleton`) cho mọi trang chính; error boundary (`RouteError`) có `reset` + link về projects.
- Gating logic chặt: Generate disable khi prompt rỗng/đang submit; Analyze disable khi 0 refs; Activate disable khi chưa analyzed; mask editor disabled khi chưa chọn asset.
- Magic-link login: copy rõ ràng (`Magic link sent. Check your email to continue.`), error state có màu phân biệt, disable đúng khi đang gửi.

## Khuyến nghị ưu tiên

| Ưu tiên | Finding | Effort |
|---|---|---|
| P1 | HIGH-1 — Asset name raw prompt | S |
| P1 | HIGH-2 — Raw provider error | S |
| P2 | MEDIUM-1 — StylePanel loading state | S |
| P2 | MEDIUM-2 — aria-label create style | S |
| P2 | MEDIUM-3 — Palette rỗng non-HEX | S |
| P2 | MEDIUM-6 — Retry style indication | S |
| P3 | MEDIUM-4 — Dynamic progress segments | M |
| P3 | MEDIUM-5 — Canvas placeholder khi job active | M |
| P3 | LOW-1 — Localize job status labels | S |
| P3 | LOW-2 — Focus-visible remove reference | S |
| P3 | LOW-4 — Zoom toggle | S |
| P3 | LOW-5 — Composer char counter | S |
| — | LOW-3 — Settings style section | Không cần làm ngay |
