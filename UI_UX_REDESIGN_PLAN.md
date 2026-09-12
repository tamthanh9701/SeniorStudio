# SeniorStudio — Minimal Blue UI & UX Redesign Plan

Ngày lập: 2026-09-10. Trạng thái: đề xuất để duyệt, chưa triển khai.

## 1. Mục tiêu và phạm vi

Thiết kế lại toàn bộ bề mặt người dùng theo tinh thần tối giản của ChatGPT: điều hướng nhẹ, không gian nội dung rõ, composer làm trọng tâm khi sáng tạo, công cụ nâng cao chỉ xuất hiện khi cần. Không sao chép logo, thương hiệu hoặc biến mọi màn hình thành chat. Ảnh và gallery vẫn là nội dung chính.

- Xanh dương là màu nhận diện và hành động chính; nền trung tính, không phủ xanh toàn dashboard.
- Bổ sung Light / Dark / System, nhất quán ở login, dashboard, Settings, gallery, composer và editor.
- Cải thiện toàn hành trình: vào ứng dụng → chọn workspace sáng tạo → references/style → tạo ảnh → theo dõi job → xem kết quả → inpaint/tuning → tải ảnh.
- Giữ Playground độc lập với Style Groups. Một styles row vẫn là một Style Group.
- Inpaint trong Style Group tạo asset mới; không ghi đè source, không đánh tráo asset mới thành version ẩn.
- Giữ contract planHash, explicit consent, revision/provenance và không tự chuyển model.
- Không triển khai trong bước lập kế hoạch. Không production migration, deploy, provider call hoặc sửa dữ liệu thật.
- Không thêm team management, billing, realtime collaboration, command palette hay analytics service chỉ để làm dashboard trông nhiều tính năng.

## 2. Cơ sở đánh giá và giới hạn

Đã đọc globals.css, layout.tsx, StudioShell, ProjectsDashboard, ModuleContextSidebar, entry route /style; audit các luồng chuyên biệt được bổ sung bên dưới. Đã xem production qua relay ở gallery Style Group, /projects, /settings và một project có ảnh/job history; trả browser về trang ban đầu sau khi khảo sát.

Bằng chứng screenshot hiện trạng: /tmp/omp-sshots-1579ddec4fa8e6cb.webp (dashboard). Screenshot là ảnh 2560px được thu nhỏ khi hiển thị, không dùng kích thước chữ trong bản thu nhỏ để kết luận font CSS quá nhỏ.

Chưa có usability study với người dùng, chưa đo tương phản tự động, chưa kiểm chứng mobile/keyboard toàn bộ, chưa chạy provider. Các nhận định từ code là heuristic audit; không gọi chúng là kết quả nghiên cứu định lượng. Lỗi job lịch sử không chứng minh lỗi provider hiện còn tồn tại.

## 3. Chẩn đoán UX hiện trạng


### Phát hiện bổ sung đã kiểm tra trực tiếp

- **P0 — Preview generation có lỗi contract thực:** `StyleGroupComposer.tsx:45–50` kiểm tra prompt có nội dung nhưng không gửi `prompt` trong request `/api/ai-execution-plan`; route `api/ai-execution-plan/route.ts:39–40` yêu cầu trường này. Đây là nguồn lỗi `PROMPT_REQUIRED` cần sửa trước cosmetic redesign, không phải vì preview tự gây phí. Acceptance: nhập bằng thao tác browser thật → preview 200 có planHash; không tạo job; sửa prompt làm plan cũ invalid. Báo cáo cũ quy toàn bộ blocker cho provider chưa chính xác.
- **Style UI đã tồn tại, không xây lại từ đầu:** `StylePanel` có list/create/upload/analyze/activate/rollback; `ClarificationForm` gọi synthesis; `TuningPanel` dùng proposal apply. Vấn đề là phân tán trong inspector/legacy workspace và chưa thống nhất với group page. Phải migrate/reuse, không thêm API list trùng `/api/styles`.
- **P1 — Busy/error recovery:** `StylePanel.tsx:113–125` không đặt busy=create trước POST; upload/analyze/remove thiếu finally bảo đảm phục hồi nếu fetch throw. Prioritize chống submit trùng và giữ lỗi theo operation; không tự retry lời gọi provider.
- **P1 — Accessibility/recovery của editor/jobs/settings:** audit code ghi nhận whole-card aria-live trong JobTimeline, thiếu trạng thái reconnect cho polling, provider save/remove thiếu recovery đầy đủ, và mask tools cần label/pressed/loading/error rõ. Realtime/polling hiện có phải giữ, không viết lại transport chỉ vì đổi UI.
- `EditorWorkspace` layer editor có gaps keyboard/property/persistence nhưng search src chưa thấy caller ngoài định nghĩa. Không biến layer editor chưa được nối thành feature mới trong redesign; chỉ sửa/thiết kế sâu khi xác nhận có route sử dụng. MaskEditor đang dùng trên inpaint là phạm vi ưu tiên.

### Phân biệt giới hạn và lỗi

Provider chưa được phép gọi là gate cho live execution, không phải lý do bỏ kiểm chứng preview không phí. API proposals list trả 404 không tự chứng minh backend lỗi vì chưa có contract list đó. Retry repopulate composer là hành vi an toàn có thể giữ; đổi nhãn thành “Dùng lại thiết lập” thay vì hứa đã gửi job mới. Cancellation queued-only phải giữ đúng giới hạn backend. Không tự thêm chức năng hủy running job, layer editor đầy đủ hoặc provider auto-validation.

### Bảng cải thiện trải nghiệm

| Mức | Bằng chứng | Vấn đề người dùng | Hướng sửa |
|---|---|---|---|
| P1 | globals.css:3–19,47–62; nhiều class màu literal | Dark-only, accent tím; đổi CSS variable đơn lẻ không tạo light mode đúng | Semantic tokens và migrate toàn bộ shared controls/surfaces |
| P1 | StudioShell.tsx:42 luôn có cột 360px, inspector render có điều kiện | Dashboard không có inspector vẫn mất diện tích bên phải, nội dung lệch | Layout hai cột mặc định; ba cột chỉ khi inspector đang hiện |
| P1 | /style/page.tsx trả StyleWorkspace legacy; group page là bố cục riêng | Người dùng vào Style nhưng gặp Restyle, khó tìm/quản lý group | /style thành thư viện Style Groups; giữ capability Restyle trong ngữ cảnh group |
| P1 | Gallery production có shell riêng, breadcrumb Styles trở về /style legacy | Mất định hướng giữa modules và các trang con | App shell nhất quán, group context và breadcrumbs |
| P1 | Tab Phong cách trên production hiển thị JSON schema | Người dùng phải đọc cấu trúc kỹ thuật để hiểu phong cách | Tóm tắt visual rules + references + revision; JSON trong Advanced |
| P1 | StudioShell.tsx:49–52: Create/Inpaint cùng href project | Nhãn hành động không dẫn đến đúng nhiệm vụ trên mobile | Navigation theo nơi đến; Inpaint chỉ xuất hiện khi chọn asset |
| P1 | ProjectsDashboard create/delete fetch thiếu xử lý network exception rõ ràng | Có thể kẹt submitting hoặc xóa thất bại nhưng dialog đóng | try/finally, lỗi inline, giữ context và retry có chủ đích |
| P1 | StudioShell dialog có Escape nhưng chưa có focus trap/restore trong component | Keyboard có thể đi vào nền; khó thao tác bằng trợ năng | Dialog/drawer chung với focus lifecycle đầy đủ |
| P2 | ModuleContextSidebar RecentPrompts trỏ về project hoặc /style | Chọn lịch sử không đi thẳng kết quả/job mong muốn | Deep-link scoped theo project/group + job/asset và giữ filter |
| P2 | Production có English navigation và Vietnamese status/form | Mental model và thuật ngữ không nhất quán | Một ngôn ngữ UI nhất quán trong rollout; mặc định đề xuất tiếng Việt |
| P2 | Workspace đồng thời canvas, filmstrip, timeline dài, inspector | Quá nhiều vùng cạnh tranh chú ý, progress lặp cả job cũ | Compact completed history, activity details mở theo nhu cầu |
| P2 | Settings hiển thị provider Not configured nhưng composer có model; heartbeat chưa có dữ liệu | Khó hiểu model có dùng được không và cần làm gì | Effective readiness, tách configured/available/verified; unknown không giả thành ready |
| P2 | Dashboard screenshot có thumbnail không tải | Card thiếu fallback có giải thích | Thumbnail loading/error state; lỗi preview không che mất project |

P1: cản trở nhiệm vụ chính hoặc khả năng truy cập. P2: giảm ma sát/độ rõ. Không nâng heuristic thành lỗi bảo mật hoặc lỗi backend đã được xác nhận.

## 4. Information architecture đề xuất

Giữ URL hiện có để tránh đổi route không cần thiết:

- /projects: dashboard Playground, danh sách project, tìm kiếm, sắp xếp, tiếp tục làm việc.
- /projects/[projectId]: workspace tạo ảnh và gallery/history của project.
- /style: dashboard Style Groups, bao gồm Draft và Active; Library là filter, không phải module mới.
- /style/[styleId]: group workspace; tabs Ảnh / Phong cách / References / Hoạt động khi có dữ liệu hỗ trợ.
- /style/[styleId]/new: composer scoped, thấy rõ group và style revision.
- Các URL asset/detail/edit hiện có: giữ nguyên, thêm breadcrumb/context thống nhất.
- /settings: Giao diện; AI providers; Trạng thái dịch vụ; Tài khoản.

Sidebar desktop: brand → Playground → Style Groups → context gần đây → footer Settings/account/theme. Sidebar thu gọn được; không nhồi danh sách lịch sử vô hạn. Sidebar mobile là drawer, header luôn thấy tên trang/ngữ cảnh. Không giữ bottom navigation giả vờ hỗ trợ Inpaint khi chưa có source.

Back từ asset/new/edit trở về đúng group/project và giữ tab/filter/scroll. Search/filter/sort nằm trong URL; không mặc định lưu prompt nhạy cảm vào URL.

## 5. Visual system — Minimal Blue

### 5.1 Tokens khởi điểm

Các màu sau là đề xuất thiết kế, phải đo WCAG trước khi khóa palette.

| Semantic token | Light | Dark |
|---|---|---|
| canvas | #FFFFFF | #101216 |
| sidebar/panel | #F7F8FA | #171A20 |
| surface | #FFFFFF | #1E232B |
| surface-hover | #EFF2F6 | #272E38 |
| text-primary | #172033 | #F3F5F9 |
| text-secondary | #526077 | #A9B4C5 |
| border | #DCE2EA | #343D4A |
| accent/action-fill | #2563EB | #2563EB |
| action-hover | #1D4ED8 | #1D4ED8 |
| on-accent | #FFFFFF | #FFFFFF |
| accent-text/focus | #1D4ED8 | #93C5FD |
| accent-subtle | #EFF6FF | #172B48 |

Success/warning/error có token riêng theo theme, icon + text đi cùng màu. Tách màu UI khỏi màu artwork và schema palette; không thay mã màu trong prompt, reference hay dữ liệu ảnh.

Thêm token overlay, disabled, placeholder, focus-ring, selection, scrollbar, image-stage và checkerboard. Editor có nền kiểm tra ảnh sáng/tối/checker riêng; đổi theme không sửa ảnh/mask và không áp CSS filter lên artwork.

### 5.2 Nhịp điệu giao diện

- Geist hiện tại; body 14–16px, heading 24–32px, label sentence case thay vì toàn bộ uppercase tracking rộng.
- Spacing theo 4/8px; gap section 24–32px. Control radius 10–12px, card 12–16px; shadow chỉ dùng cho layer nổi.
- Sidebar 240–256px; content dashboard max-width khoảng 1280–1440px, gallery mở rộng theo viewport; composer max-width 760–880px. Editor ưu tiên canvas, không ép cùng max-width dashboard.
- Một CTA chính mỗi vùng nhiệm vụ: Tạo project / Tạo Style Group / Xem kế hoạch / Xác nhận tạo. Các thao tác phụ dùng neutral text/outline.
- Card ảnh: thumbnail theo aspect ratio ổn định, tên rõ, updated time, menu phụ. Delete nằm trong menu, không là affordance nổi bật cạnh thao tác chính.
- Không gradient lớn, glassmorphism, dashboard KPI giả, animation trang trí hoặc số liệu không có nguồn.

### 5.3 Dashboard wireframe

Sidebar | Header tên module + CTA
        | Search + bộ lọc + sắp xếp
        | Tiếp tục gần đây (chỉ khi có dữ liệu thật)
        | Grid projects hoặc Style Groups
        | Load more/pagination khi cần

Empty state nằm trong content container với tiêu đề, một câu giải thích và đúng một hành động tiếp theo, không chỉ dòng text nhỏ giữa vùng trống khổng lồ. Khi chưa có dữ liệu không hiển thị search/filter vô dụng.

## 6. Light / Dark / System

- Mode: system mặc định cho người dùng mới, có lựa chọn Light/Dark rõ ở Settings và menu account. Lưu lựa chọn trên thiết bị, không cần database migration.
- Một nguồn truth cho preference; effective theme = explicit preference hoặc matchMedia. Lắng nghe OS change chỉ khi mode system; đồng bộ các tab bằng storage event.
- Áp data-theme trên html trước first paint bằng bootstrap nhỏ tương thích CSP của dự án; provider phía client cập nhật control sau hydration. Không chuyển root layout thành client component chỉ vì theme.
- Nếu storage bị chặn: fallback system, không crash. Tránh flash dark/light và hydration mismatch; chỉ dùng suppressHydrationWarning tại html nếu thật sự cần cho attribute theme, không che warning toàn ứng dụng.
- CSS variables làm nền tảng; cân nhắc provider nhỏ nội bộ vì chỉ có ba mode. Chỉ thêm next-themes nếu kiểm chứng đơn giản hơn giải pháp nội bộ và tương thích Next hiện tại; không thêm thư viện UI đầy đủ chỉ để đổi theme.
- Cutover toàn bộ màu presentation literal trong components/app; giữ domain colors và mask colors. Class studio-* tiếp tục là điểm tái sử dụng, không tạo design system song song.
- Các form native, dropdown, dialog, toast, skeleton, tooltips, scrollbar và focus đều có theme coverage.
- Acceptance: reload mọi deep-link không flash theme sai; System theo OS; đổi theme giữa lúc sửa mask không mất state; session auth không ảnh hưởng; login/reset-password cũng đúng theme.

## 7. UX theo hành trình

### 7.1 Đăng nhập và lần đầu dùng

- Login gọn, một CTA, lỗi đặt cạnh form, không tiết lộ email có tồn tại trong reset password.
- Khi vào app: đưa người dùng tới project/group gần đây hoặc dashboard hiện tại, không thêm màn onboarding chặn.
- Empty state giải thích Playground = sáng tạo tự do; Style Group = ảnh cùng quy tắc phong cách và references.
- Readiness banner chỉ hiện khi có vấn đề liên quan hành động; hướng dẫn cấu hình provider hoặc liên hệ admin nếu không có quyền.

### 7.2 Tìm và quản lý project/group

- Search theo tên, filter trạng thái/library và sort gần cập nhật; có Clear filters và phân biệt không có dữ liệu với không có kết quả.
- Nếu backend chỉ trả một phần dữ liệu: không gọi client-only search là tìm toàn bộ. Thêm pagination/search API trong cùng slice khi cần.
- Create dialog focus input, submit Enter, giữ dữ liệu khi lỗi, không tạo trùng khi double-click.
- Delete hiển thị tên và phạm vi ảnh/version bị ảnh hưởng, xác nhận rõ; lỗi giữ dialog mở. Không cung cấp Undo giả khi API xóa vĩnh viễn.

### 7.3 Thiết lập Style Group

Flow: tạo group → thêm references → phân tích → nhập mong muốn → xem proposal → xác nhận áp dụng → tạo ảnh.

- Upload có preview, progress, validation size/type trước submit, lỗi từng file và retry chỉ file lỗi.
- Reference selection dùng thumbnail, tên dễ hiểu và selected state có aria-pressed/checkbox; không chỉ UUID cắt ngắn.
- Phong cách hiển thị summary theo Màu sắc / Chất liệu / Ánh sáng / Bố cục / Điều tránh; schema editor và JSON nằm trong Advanced.
- Dùng task checklist có trạng thái thực thay wizard tuyến tính bắt buộc: người dùng quay lại sửa references mà không mất group.
- Synthesis/tuning là đề xuất, không auto-apply. Hiển thị diff, bằng chứng, thay đổi được chọn và cảnh báo ảnh hưởng lần tạo sau.
- Stale revision: giải thích cần tải proposal/context mới, không tự ghi đè style mới hơn. Unknown provenance phải hiện rõ, không suy đoán revision từ timestamp.

### 7.4 Tạo ảnh

- Composer luôn thấy scope project/group; prompt lớn, references dưới dạng chips/thumbnails; model và settings phụ ở popover/inspector.
- Model/size/quality/count thuộc một state, không có hai bản settings lệch nhau giữa composer và inspector.
- Preview plan là bước không enqueue và phải kiểm chứng độc lập: scope, operation, selected refs đúng thứ tự, số lượng, model và warnings.
- Hiển thị quota/cost nếu backend có dữ liệu đáng tin; nếu không có giá thì ghi Chưa có ước tính, không đoán giá tiền.
- Nút xác nhận mới tạo job. Thay prompt/settings/reference/revision làm consent cũ invalid và yêu cầu plan mới.
- Không tự gọi provider khi chọn model, đổi theme hoặc xem Settings. Keyboard shortcut không bypass consent hoặc gửi trong khi IME đang composition.
- Prompt draft giữ khi lỗi và khi đóng inspector. Có thể lưu session-scoped draft theo workspace/user/context để reload phục hồi; không lưu raw API keys, ảnh/base64; xóa draft sau submit thành công hoặc theo lệnh người dùng, tránh lộ draft giữa tài khoản dùng chung browser.

### 7.5 Jobs và kết quả

- Giai đoạn từ backend: queued/running/saving/completed/failed tương ứng contract; không progress phần trăm giả.
- Completed job compact, focus ảnh + prompt; timeline kỹ thuật trong details. Live region chỉ báo chuyển trạng thái, không đọc lại toàn feed mỗi poll.
- Retry giữ prompt/settings nhưng không tự retry job tính phí. Phải phân biệt mất kết nối khi submit (chưa biết enqueue chưa) với job failed để không tạo trùng.
- Reload theo dõi lại job tồn tại; lỗi polling báo mất kết nối chứ không đổi job thành failed.
- Result có Open / Download / Edit; gallery thấy asset mới; download URL hết hạn có đường refresh được kiểm soát.
- Không thêm Cancel nếu backend chưa hỗ trợ semantics cancellation; không biểu diễn cancel UI như đã dừng provider khi chỉ đóng màn hình.

### 7.6 Asset, inpaint và lineage

- Canvas là trọng tâm, metadata drawer đóng mặc định; Back quay đúng gallery và selected asset.
- Trước inpaint: source version, group/style revision, ảnh được giữ nguyên; chọn/vẽ mask và mô tả vùng sửa.
- Toolbar có Brush / Eraser / Undo / Redo / Reset / Fit / Zoom; keyboard shortcuts có hướng dẫn và không chiếm phím khi đang gõ prompt.
- Không bật submit khi source chưa tải hoặc mask rỗng; thông báo cụ thể, không chỉ nút disabled.
- Thay source có mask/draft chưa lưu cần xác nhận hoặc giữ draft độc lập theo source. Resize/theme không xóa mask.
- Với Style Group: A → B → C hiển thị asset lineage rõ, mỗi kết quả riêng trong gallery. Với Playground: giữ semantics version hiện hữu, không đồng nhất hai mô hình lưu trữ bằng UI.
- Trước/sau có mô tả và điều khiển keyboard; không chỉ slider kéo chuột. Mobile touch mask không làm trang cuộn ngoài ý muốn.

### 7.7 Settings và hỗ trợ lỗi

- Giao diện (theme) tách AI providers, service status và tài khoản.
- Provider state phân biệt workspace key chưa có, server provider available, validation chưa chạy, validation failed. Chỉ thêm field API tối thiểu cần cho trạng thái đã kiểm chứng; không suy luận ready từ model catalog.
- Worker: last seen timestamp và unknown/stale/healthy theo tiêu chí có nguồn; heartbeat không tự chứng minh provider chạy thành công.
- Không reveal key đã lưu; nhập key mới là password field, save feedback rõ; validation provider cần đồng ý riêng nếu có external call.
- Lỗi: giải thích người dùng có thể làm gì → nút hành động đúng → technical detail thu gọn gồm code/request ID nếu có. Không hứa đổi model sẽ giải quyết mọi lỗi.

## 8. Responsive, accessibility và hiệu năng

- Matrix 375×667, 390×844, 768×1024, 1280×800, 1440×900, 2560×1440. Kiểm tra cả 200% zoom và keyboard-only.
- Desktop: sidebar + content; inspector optional. Tablet: inspector drawer. Mobile: header + content + drawer, safe-area bottom, bàn phím không che submit. Không dựa overflow-x:hidden để giấu lỗi layout.
- WCAG 2.2 AA: text thường ≥4.5:1; text lớn ≥3:1; focus/control boundaries quan trọng ≥3:1. Target tối thiểu 24px theo tiêu chí WCAG, chuẩn thiết kế nội bộ 44px cho controls chính.
- Label gắn htmlFor/id; icon-only action có accessible name; không dùng placeholder làm label duy nhất.
- Dialog trap focus, Escape, restore focus, nền inert; thông báo lỗi role alert hợp lý; reduced motion giữ như hiện có.
- Thumbnail có fallback, kích thước/aspect ratio ổn định; lazy-load ngoài viewport, không tải full-resolution cho card.
- Không mount inspector nặng khi đóng nếu không cần giữ state; state quan trọng đặt ở owner ổn định. Chỉ virtualize khi có số lượng lớn và đo được vấn đề.
- Theme toggle không refetch dữ liệu domain. Đo baseline LCP/CLS/INP khi triển khai; mục tiêu CWV tốt, không tuyên bố đạt khi chưa đo thực tế.

## 9. Kế hoạch triển khai theo phase

### Phase A — Khóa UX contract và design baseline
Owner: UI/integration.
- Chốt IA, terminology tiếng Việt, token palette, desktop/mobile wireframes cho dashboard/group/composer/editor/settings.
- Xác nhận route/action matrix và persistence semantics; kiểm kê màu literal presentation, dialog và trạng thái async.
- Reuse components hiện hữu, thống nhất shell variants. Ghi rõ API nào đủ và phần nào cần bổ sung, không làm tab placeholder.
Acceptance: từng hành động có destination, empty/error/loading state và data source; kế hoạch light/dark bao phủ tất cả màn.

### Phase B — Tokens, theme và primitive controls
Files: src/app/globals.css, layout.tsx; shared studio-* classes; theme provider/control mới ở vị trí phù hợp.
- Semantic theme, prepaint bootstrap, preference persistence, focus/contrast.
- Shared button/control/badge/dialog/drawer/empty/error patterns; migrate đang dùng, không giữ hai hệ styles.
- Auth và Settings appearance làm màn proof đầu tiên.
Acceptance: Light/Dark/System và keyboard kiểm chứng thực; không flash/hydration warnings; color exceptions cho image/mask được giữ.

### Phase C — App shell, dashboards và navigation
Files: StudioShell.tsx, ModuleContextSidebar.tsx, ProjectSidebar.tsx, ProjectsDashboard.tsx; /projects và /style routes; group shell.
- Bỏ cột inspector rỗng; responsive sidebar/drawer và route-aware context.
- /style dashboard groups thay legacy landing; giữ Restyle capability bằng lối vào group thích hợp, migrate mọi caller trước khi gỡ component obsolete.
- Card/search/filter/empty/loading/error và create/delete feedback.
Acceptance: từ /style tới từng group không cần URL thủ công; back đúng context; dashboard không chừa 360px vô dụng; mobile có đường tới Settings và cả hai modules.

### Phase D — Style lifecycle và generation composer
Files: StylePanel, StyleGroupComposer, TuningPanel, ClarificationForm, SchemaEditor, GenerationComposer, ToolInspector; group pages/APIs liên quan.
- References, style summary, proposal review, group-scoped composer và consent UI.
- Dùng API hiện hữu; thêm persistence/retrieval endpoint nếu audit xác nhận còn thiếu để proposal không mất sau reload.
- Reuse presentation/state primitives nhưng giữ contracts Playground/Style riêng khi semantics khác.
Acceptance: không auto-apply, consent invalidation đúng, reference order giữ nguyên, stale schema xử lý có giải thích, preview không enqueue.

### Phase E — Gallery, jobs, editor và recovery
Files: ProjectWorkspace, StyleCanvas, AssetCanvas, JobTimeline, use-module-jobs; editor components và asset routes.
- Async recovery, compact history, deep-link job/result, image errors, source/mask readiness và asset lineage.
- Tách lỗi trình duyệt/relay automation khỏi lỗi form thật; không dùng DOM value injection để chứng minh input React hoạt động.
Acceptance: mock-free local UI smoke với fixture không provider cho transitions; reload/broken network không double submit; new-asset inpaint semantics không thay đổi. Live provider A→B→C do người dùng test sau.

### Phase F — Cross-app consistency và release gate
- Hoàn tất wording/auth/settings/accessibility/responsive; xóa legacy UI thật sự obsolete sau khi migrate all callers.
- Typecheck/build và sửa existing tests bị đổi contract; regression tests chỉ cho edge cases thực như theme storage blocked, consent stale, network ambiguous, focus restore.
- Visual browser proof ở các viewport/theme, local hoặc preview đã được duyệt. Không coi build thành công là UI acceptance.
- Sau smoke proof: cập nhật docs/changelog hiện có, bỏ throwaway fixtures/scripts, không thêm test chụp source text.
Acceptance: ma trận ở mục 10 hoàn tất; provider-cost cases đánh dấu user-owned, không đánh dấu pass giả. Production deploy cần duyệt riêng.

Dependencies: A → B → C; D/E có thể thực hiện song song sau shared shell/theme contract, phân ownership tránh cùng sửa composers; F sau tích hợp. Theme là cross-app cutover trong branch; không release từng trang nửa light nửa dark.

## 10. Acceptance matrix bắt buộc

| Luồng | Proof không provider | Gate live riêng |
|---|---|---|
| Theme | 3 modes × deep-link/reload/system change/storage blocked; canvas giữ mask | Không |
| Dashboard | dữ liệu rỗng/có/lỗi; search không kết quả; pagination; keyboard dialog | Production writes chỉ khi được phép |
| Style Group | Draft/Active; summary/references; proposal persisted/stale bằng local fixture | Analyze/synthesize/tuning trả phí do user test |
| Composer | input thật, preview valid, consent invalidation, capability error, refs order | Enqueue có phí cần explicit approval |
| Jobs | queued/running/completed/failed/poll offline/reload bằng fixture controlled | Worker/provider completion thật |
| Editor | loaded/failed source, mask empty/nonempty, undo/redo, resize/theme | Inpaint A→B→C thật |
| Settings/auth | theme, inline errors, provider status presentation, form semantics | Key change/provider validation cần xác nhận |
| Responsive/a11y | theme × viewport; focus/contrast/200% zoom/reduced motion | Không |

## 11. Đánh giá UX sau triển khai

Mời người dùng thực hiện 5 task: tìm group cũ; tạo draft/reference; hiểu plan trước xác nhận; tìm kết quả job; xác định source và ảnh mới sau inpaint. Đo baseline rồi so sánh task success, wrong-turns, thời gian tìm hành động, khả năng giải thích chi phí/scope và số lần mất draft. Không đặt tỷ lệ cải thiện giả khi chưa có baseline.

Mục tiêu định tính có thể kiểm chứng: người dùng biết đang ở project hay group, action tiếp theo là gì, có phát sinh job hay chưa, ảnh gốc còn nguyên hay không, lỗi cần tự sửa hay chờ hệ thống.

## 12. Quyết định đề xuất để duyệt

1. Minimal neutral surfaces + blue action accent; không clone giao diện chat cho gallery/editor.
2. Giữ Dark và thêm Light/System; mặc định System.
3. /style trở thành dashboard Style Groups; giữ Restyle nhưng đặt trong context rõ ràng.
4. Tiếng Việt nhất quán cho UI trong rollout; chưa mở rộng multi-language engine.
5. Thực hiện foundation/theme + navigation trước, rồi full lifecycle và editor/recovery; không chỉ đổi màu.
6. No paid provider, no production data changes và no deploy trong công việc thiết kế/verification mặc định.
