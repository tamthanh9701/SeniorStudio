# Báo cáo review SeniorStudio

## 1. Kết luận điều hành

**Chưa đủ cơ sở coi ứng dụng hiện tại là production-ready, đặc biệt khi có nhiều workspace.** Build và test xanh không chứng minh các luồng tương tác mới hoạt động. Review xác nhận lỗi bảo mật ở ranh giới Storage và schema patch; lỗi hợp đồng UI/API trong Apply tuning; sai lệch giữa schema đang sửa và trạng thái readiness; và điểm fidelity không dựa trên ảnh đầu ra trong luồng Tune.

Đây là báo cáo read-only: không sửa source, không deploy, không chạy provider trả phí, không xóa dữ liệu và không thử khai thác trên tài khoản khác. Chỉ tạo báo cáo này. Kiểm tra Supabase chỉ đọc metadata/policies/migration history, không đọc ảnh hoặc bản ghi nội dung người dùng.

### Mức ưu tiên

- **P0 — chặn triển khai nhiều tenant:** cô lập Storage và ngăn thao tác service-role dựa trên storage path do người dùng kiểm soát.
- **P1 — sửa trước khi công bố interactive loop hoàn tất:** prototype pollution, migration thiếu trên database đang kết nối, Apply tuning bị API từ chối, fingerprint áp quy tắc vector lên ảnh photography, readiness lỗi thời.
- **P2 — tính đúng và độ tin cậy:** fidelity, patch remove/append, history không atomic, quota mềm, xử lý lỗi và đồng bộ UI.

P0/P1 là thứ tự xử lý, không phải khẳng định đã có tấn công thực tế.

## 2. Phạm vi và chất lượng bằng chứng

Đã đọc đường đi Style UI → API → schema/fingerprint → job creation/provider/worker; migrations/RLS và quota. Có ba reviewer độc lập cho backend security, generation và UI. Parent chạy các probe cô lập để kiểm chứng những lỗi có thể tái hiện an toàn.

Nhãn bằng chứng:

- **Đã tái hiện:** chạy code/helper hoặc hợp đồng thư viện thực tế trong process riêng, không tác động dữ liệu thật.
- **Đã xác nhận metadata:** kết quả đọc database đang gắn với công cụ Supabase.
- **Source-traced:** chỉ ra chuỗi dữ liệu trong mã nguồn; chưa exercise endpoint với phiên đăng nhập thật.
- **[INFERENCE]:** hệ quả hoặc rủi ro cần xác minh thêm.

Không kiểm thử end-to-end bằng tài khoản đăng nhập ở lượt audit này. Không khẳng định chất lượng ảnh provider đã được đo. Không chạy lại toàn bộ suite/build chỉ để thay thế việc review logic.

## 3. Phát hiện bảo mật và triển khai

### A01 — Storage chưa cô lập workspace

**Ưu tiên P0 · Mức nghiêm trọng cao · Source-traced + metadata trực tiếp.**

**Vị trí:** `supabase/migrations/0001_core.sql:87-98`.

Policy SELECT/INSERT của bucket `assets` chỉ kiểm tra `bucket_id = 'assets'` và `auth.role() = 'authenticated'`. Không có membership hoặc ownership theo workspace/path. Kết quả đọc `pg_policies` trên database đang kết nối xác nhận đúng hai policy rộng này vẫn tồn tại.

**Hệ quả:** người đăng nhập có quyền Storage rộng hơn quyền bảng ứng dụng; RLS trên `assets`/`styles` không tự bảo vệ `storage.objects`. [INFERENCE] Có thể list/read/sign object workspace khác và upload vào prefix ngoài phạm vi của mình qua Storage API thông thường. Chưa thực hiện đọc chéo tenant.

**Sửa:** policy kiểm tra membership từ workspace prefix canonical, kiểm tra insert namespace; rà soát toàn bộ read/write/sign/delete. Test bằng hai tenant fixture: A không được list/read/sign/write object của B.

### A02 — Service-role delete tin storage path do người dùng sửa được

**Ưu tiên P0 · Mức nghiêm trọng cao · Source-traced, không thử xóa.**

**Vị trí:** `supabase/migrations/0021_style_profiles.sql:18-28,38-44`; `src/app/api/styles/[styleId]/references/[referenceId]/route.ts:17-28`; `src/app/api/styles/[styleId]/route.ts:104-112`.

RLS cho phép người dùng sửa reference thuộc style của mình nhưng không ràng buộc `storage_path` với workspace/style. DELETE đọc row hợp lệ rồi gọi service-role storage remove với path đó. Đây là lỗi confused deputy: quyền sở hữu row không chứng minh quyền sở hữu object được row trỏ đến.

**Hệ quả:** [INFERENCE] người dùng có thể tạo reference của mình trỏ vào object người khác rồi yêu cầu backend xóa. A01 làm việc biết path dễ hơn. Không cần vượt RLS trên style của nạn nhân.

**Sửa:** ràng buộc ownership ở DB và kiểm tra canonical path trước mọi privileged storage operation; ưu tiên client user-scoped với Storage RLS đúng. Xác minh bằng object hy sinh trong hai tenant test, tuyệt đối không thử trên dữ liệu thật.

### A03 — Prototype pollution qua schema tuning

**Ưu tiên P1 · Mức nghiêm trọng cao · Đã tái hiện helper; endpoint source-traced.**

**Vị trí:** `src/lib/style/schema-patch.ts:53-74,99-106`; `src/app/api/styles/[styleId]/tune/apply/route.ts:11-16,27-39`.

API nhận `group`/`field` dạng chuỗi tùy ý rồi nối thành path. Patcher chỉ whitelist root; traversal truy cập inherited properties. Một path nested đi qua prototype có thể ghi ra ngoài bản clone schema.

Probe trong process Node riêng với marker vô hại cho kết quả `prototype_pollution=confirmed`; marker được xóa ngay. Điều kiện endpoint: đăng nhập, feature enabled, có style truy cập được. Không khẳng định RCE hoặc privilege escalation đã được chứng minh.

**Sửa:** validate toàn bộ path theo metadata/schema; cấm `__proto__`, `prototype`, `constructor` ở mọi segment; chỉ đi qua own properties; không dùng object kế thừa cho container tùy ý. Regression phải chứng minh prototype ngoài schema không thay đổi.

### A04 — Database đang kết nối thiếu migration cho code mới

**Ưu tiên P1 · Đã xác nhận metadata, cần gắn đúng deployment.**

**Vị trí:** `supabase/migrations/0024_style_libraries.sql`; `supabase/migrations/0025_style_interactive_features.sql`.

`list_migrations` kết thúc ở `0023_style_module_jobs`. `list_tables` không có `style_libraries`, `style_schema_versions`, `ai_usage_quota`. Cột `styles` đang có: id, workspace_id, name, status, schema, fingerprint, invariant_contract, analysis_meta, created_at, updated_at. Không có library_id, clarification_questions, clarification_answers, operability, last_fidelity.

**Phạm vi:** đây là database gắn với Supabase tool; chưa đối chiếu project identity với mọi local/production deployment. Không được suy diễn rằng tất cả deployment đều dùng database này.

**Hệ quả nếu app dùng database này:** query library/interactive fields lỗi; history không ghi được; quota fail-open không giới hạn. Đây không phải lỗi TypeScript/build có thể phát hiện.

**Sửa:** xác minh target, review và apply migration theo quy trình deploy được phê duyệt; smoke authenticated trên đúng target. Không tự apply trong lượt audit.

## 4. Luồng tương tác Style

### A05 — Apply selected changes gửi payload API không chấp nhận

**Ưu tiên P1 · Đã tái hiện hợp đồng Zod.**

**Vị trí:** `src/components/studio/TuningPanel.tsx:6-12,34-40`; `src/app/api/styles/[styleId]/tune/apply/route.ts:11-16`.

UI gửi toàn bộ suggestion, gồm `current_value` và `reason`. API `.strict()` chỉ nhận `group`, `field`, `suggested_value`. Probe dùng Zod thật trả `success:false`, `unrecognized_keys: current_value, reason`.

**Hệ quả:** suggestion có đủ metadata hiển thị thông thường bị 400 khi Apply; nút tồn tại không đồng nghĩa chức năng hoạt động.

**Sửa:** map UI sang DTO chuẩn hoặc thiết kế schema dùng chung rõ ràng; không vô hiệu hóa validation tùy tiện. Test hành vi phải đi từ suggestion đầy đủ đến apply thành công và schema thực tế đổi.

### A06 — Operability không cập nhật sau sửa schema

**Ưu tiên P1 · Source-traced.**

**Vị trí:** `src/lib/style/service.ts:126-151`; `src/app/api/styles/[styleId]/route.ts:55-69`; `validate/route.ts:46-64`; `tune/apply/route.ts:39-46` trong cùng thư mục style.

Analysis ghi operability; manual edit, validate và tuning thay schema/fingerprint/contract nhưng không tính lại operability. Activation kiểm tra grade đã lưu trước khi xử lý candidate schema.

**Hệ quả:** style `not_ready` sửa xong vẫn không active; style trước đây tốt nhưng bị sửa hỏng vẫn giữ grade cũ. Interactive repair loop không đóng kín.

**Sửa:** một mutation boundary thống nhất tính schema, fingerprint, contract, operability và readiness từ candidate hiện tại; lưu cùng transaction. Kiểm thử cả hướng repaired→ready và degraded→not_ready.

### A07 — Remove xóa cả field thay vì item được yêu cầu

**Ưu tiên P2 · Đã tái hiện.**

**Vị trí:** `src/lib/style/schema-patch.ts:127-130`; consumer `schema-validator.ts`.

Input `negative_prompt.avoid_quality = ['High resolution','blur']`; patch remove có value `['High resolution']`; kết quả thực tế `{"negative_prompt":{}}`. Rule `blur` cũng mất. `value` của remove không được dùng để lọc phần tử.

**Sửa:** định nghĩa rõ remove-field và remove-items; dùng đúng semantics cho validation patch. Giữ các rule không được người dùng yêu cầu xóa.

### A08 — Append không sửa được nhóm còn thiếu

**Ưu tiên P2 · Đã tái hiện helper.**

**Vị trí:** `src/lib/style/schema-patch.ts:115-123`; `validate/route.ts:41-47`.

Append vào `artistic_style.rendering_style` khi schema chưa có artistic_style ném `Path segment 'artistic_style' does not exist in schema.` Validation route không catch lỗi patch tại vị trí này.

**Hệ quả:** [INFERENCE] câu trả lời nhằm bổ sung schema thiếu có thể thành 500 thay vì sửa schema. Cần kiểm tra từng patch builder để xác định tất cả câu hỏi bị ảnh hưởng.

**Sửa:** tạo parent cho thao tác bổ sung hợp lệ hoặc builder dùng set theo contract; map invalid patch thành lỗi có cấu trúc.

### A09 — Câu trả lời single-choice không bị giới hạn bởi options

**Ưu tiên P2 · Đã tái hiện.**

**Vị trí:** `src/lib/style/clarification-answers.ts`, `normalizeStyleClarificationAnswers`.

Required question có options `['allowed']`; gửi selected_option `not-in-options` vẫn `ok:true`, không missing required và không errors.

**Hệ quả:** client có thể coi required question đã giải quyết bằng giá trị không thuộc câu hỏi. UI dropdown không thay thế server validation.

**Sửa:** kiểm tra membership, duplicate/unknown question ID và kiểu answer theo question type; phân biệt bỏ qua với câu trả lời hợp lệ.

### A10 — Danh sách style mặc định dùng eq(null)

**Ưu tiên P2 · SDK encoding đã tái hiện, endpoint chưa gọi có auth.**

**Vị trí:** `src/app/api/styles/route.ts:20-27`.

Không có libraryId vẫn `.eq('library_id', null)`. SDK thực tế encode thành `library_id=eq.null`, không phải `is.null`.

**Hệ quả:** [INFERENCE] PostgREST với UUID có thể trả invalid syntax/LOAD_FAILED; không thể coi đây là query đúng cho ungrouped. Nếu nghĩa là “tất cả”, filter này cũng sai logic.

**Sửa:** quyết định all vs ungrouped; all bỏ filter, ungrouped dùng `.is(..., null)`; reject query ID sai thay vì âm thầm biến thành null.

### A11 — History và schema không commit nguyên tử

**Ưu tiên P2 · Source-traced.**

**Vị trí:** `src/app/api/styles/[styleId]/route.ts:63-84`; `src/lib/style/schema-versions.ts:13-27`; `0025_style_interactive_features.sql:45-56`.

Manual PATCH ghi version trước khi update style. Nếu libraryId hợp lệ về định dạng nhưng không tồn tại, version có thể thành công còn style update lỗi foreign key. Trigger vẫn trim lịch sử xuống 20. Các route ghi theo thứ tự ngược có rủi ro style đổi nhưng history thất bại.

**Hệ quả:** history chứa schema chưa áp dụng; request lỗi có thể đẩy mất version thật; client không biết trạng thái commit. Hai editor đồng thời có thể ghi đè nhau nếu không kiểm tra revision.

**Sửa:** transaction/RPC gộp update và append; optimistic revision check. Kiểm thử rollback transaction khi bước sau lỗi và hai mutation đồng thời.

## 5. Generation và chất lượng đánh giá

### A12 — Fingerprint ép quy tắc vector lên style không phải vector

**Ưu tiên P1 · Đã tái hiện.**

**Vị trí:** `src/lib/style/fingerprint.ts:145-199,203-214`; compiler trong `src/lib/style/service.ts`.

Input photography, `photorealistic, no outlines` vẫn tạo prompt có `clean colored outline, medium thickness`, `Pastel flat fills`, line texture/hatching, giới hạn ba hue families và danh sách nội dung holiday/cinema/financial hardcode.

**Hệ quả:** compiler tự thêm ràng buộc mâu thuẫn với style đã phân tích; đặc biệt ảnh chụp, painting, monochrome hoặc full-scene. Việc wire fingerprint vào generation mở rộng tác động của các default thiên lệch có sẵn.

**Sửa:** fingerprint phải biểu diễn bằng chứng/reference/schema, unknown giữ unknown và không phát minh rule; quy tắc theo style family chỉ khi có bằng chứng. Probe photography phải không sinh outline/pastel/hatching không được yêu cầu.

### A13 — Điểm fidelity trong Tune không đo ảnh đầu ra

**Ưu tiên P1 về độ tin cậy sản phẩm · Đã tái hiện helper + source-traced route.**

**Vị trí:** `src/app/api/styles/[styleId]/tune/route.ts:48-60`; `src/lib/style/fidelity-evaluator.ts:124-135,185-198,218-251`; `TuningPanel.tsx:55`.

Tune gửi ảnh cho vision để lấy suggestions, nhưng deterministic evaluator chỉ nhận fingerprint và feedback, không nhận detectedOutput. Probe `evaluateStyleFidelity({})` trả:

```
style_fidelity: 0.77
palette_fidelity: 0.75
background_policy_match: 0.8
line_texture_fidelity: 0.75
composition_match: 0.75
content_match: 0.85
issues: []
should_regenerate_with_stricter_style: false
```

**Hệ quả:** người dùng nhìn phần trăm giống điểm đo trong khi đó là defaults; ảnh khác nhau không đi vào scoring này. Không đánh đồng phát hiện này với endpoint LLM evaluate riêng.

**Sửa:** vision tạo output observations có schema kiểm chứng rồi evaluator chấm dựa trên observations; thiếu evidence hiển thị “chưa đánh giá”, không tự cho điểm tốt.

### A14 — Cost budget chưa phải hard character cap chính xác

**Ưu tiên P2/thấp · Đã tái hiện.**

**Vị trí:** `src/lib/style/prompt-schema.ts`, `buildStyleGenerationPrompt`.

Với rendering_style dài, `maxChars=1600` trả length 1602. Sai số nhỏ, nhưng chứng minh budget implementation không đáp ứng chính xác contract. Character budget cũng không đồng nghĩa token/cost guarantee.

**Sửa:** tính cả suffix/truncation marker trong cap; giữ prompt ngữ nghĩa khi cắt và không quảng bá character cap như hard billing cap.

## 6. Quota và vận hành

### A15 — Quota race làm vượt giới hạn và mất lượt đếm

**Ưu tiên P2 · Đã tái hiện interleaving trong bộ nhớ.**

**Vị trí:** `src/lib/ai/quota.ts:37-48`.

Read count rồi upsert used+1 không atomic. Probe: starting usage=1, limit=2, năm request đồng thời → cả năm allowed, finalUsage=2.

**Quan trọng:** plan đã chấp nhận soft quota/race/fail-open. Đây là nhược điểm của quyết định thiết kế, không được gọi là vi phạm yêu cầu hard limit. Khi bảng thiếu hoặc write lỗi, fail-open tiếp tục cho chạy là hành vi đã chọn.

**Sửa nếu cần kiểm soát chi phí thật:** atomic conditional increment/reservation, phân biệt request/image/provider call; giữ chính sách fail-open hoặc fail-closed thành quyết định minh bạch. Không dùng quota này làm security boundary.

### A16 — Hai overload enqueue cùng tồn tại

**Ưu tiên P2 · Metadata trực tiếp; lỗi runtime chưa tái hiện.**

`pg_proc` trên database đang kết nối có `enqueue_ai_job` cả 15 và 16 tham số. Migration 0023 tạo bản thêm p_module; các route project/asset không truyền p_module trong khi Style có truyền.

**Vị trí:** `supabase/migrations/0023_style_module_jobs.sql`; `src/app/api/projects/[projectId]/ai-jobs/route.ts:56`; `src/app/api/assets/[assetId]/ai-jobs/route.ts:24`; `src/app/api/style/ai-jobs/route.ts:62-78`.

**[INFERENCE]:** matching named arguments/defaults có thể gây ambiguity hoặc chọn implementation cũ; chưa gọi RPC để tránh tạo job thật. Không khẳng định đã xảy ra PGRST203.

**Sửa/kiểm tra:** audit toàn bộ signature/default/caller; clean cutover một signature và migrate callers; thử trên database fixture không nối provider.

### A17 — Bản enqueue mới bỏ kiểm tra liên kết mask/parent

**Ưu tiên P1/P2 tùy khả năng gọi RPC · Source-traced, chưa exploit.**

**Vị trí:** `supabase/migrations/0023_style_module_jobs.sql:80-92` so với `0021_style_profiles.sql:93-102`.

Nhánh inpaint mới kiểm tra parent thuộc project, nhưng không giữ toàn bộ kiểm tra mask input ownership/expiry/job binding và equality giữa asset truyền vào với parent asset. Insert vẫn dùng p_asset_id do caller gửi. Authenticated được execute RPC.

**Hệ quả [INFERENCE]:** direct RPC có thể bỏ qua validation route và tạo job liên kết sai hoặc dùng mask không hợp lệ. Cần fixture để đo tác động worker, không khẳng định đọc/xóa chéo tenant đã xảy ra từ riêng lỗi này.

**Sửa:** DB phải enforce invariant độc lập route: parent thuộc đúng asset/project/workspace; mask thuộc request/user/job và còn hạn; không chỉ kiểm tra non-null.

## 7. Bằng chứng về phạm vi hoàn thành và kiểm thử trước đây

- Đã đếm runtime metadata: **15 groups, 98 fields**. Không báo thiếu metadata vì thông tin này đúng.
- Kết quả lịch sử 111/111 tests, build/typecheck passed là kết quả ở lượt trước; audit này không chạy lại và không coi chúng là bằng chứng end-to-end.
- Smoke trước đây vào `/style` bị chuyển `/login`, API trả 401 chỉ chứng minh route/auth boundary load được. **Không chứng minh clarification/editor/tuning/rollback hoạt động khi đăng nhập.**
- Tuning payload bug A05 có thể được phát hiện bằng một contract exercise không cần provider thật.
- `tests/style-schema-versions.test.ts:13-25` chủ yếu kiểm tra `.insert/.order/.limit` và mock echoes; không bảo vệ tính atomic, rollback đúng dữ liệu hoặc failed-update history. Test xanh này không phản chứng A11.
- Trong lượt này không xóa/sửa test vì user yêu cầu review, không yêu cầu remediation.

## 8. Thứ tự khắc phục và tiêu chí nghiệm thu

1. **Cô lập tenant:** A01/A02. Hai tài khoản fixture; không đọc/ghi/ký/xóa chéo workspace qua Storage API hoặc reference cleanup.
2. **Khóa schema boundary:** A03, A07-A09. Full path/type validation; giữ invariant object; remove không mất rule ngoài lựa chọn; incomplete schema sửa được.
3. **Đồng bộ deployment:** A04/A16/A17. Đúng database target, migrations đủ, RPC signature duy nhất và DB invariants giữ nguyên.
4. **Sửa interactive loop:** A05/A06/A10/A11. Analyze → answer → edit → activate → tune → apply → history/rollback bằng phiên đăng nhập thật; state UI và DB phải khớp.
5. **Sửa tính đúng generation/evaluation:** A12-A14. Không phát minh style constraints; score cần evidence; budget được định nghĩa đúng.
6. **Chọn mức bảo đảm quota:** A15. Nếu vẫn soft fail-open, ghi rõ không bảo đảm ngăn overspend.

Không cần tái cấu trúc toàn bộ ứng dụng. Ưu tiên sửa invariant ở đúng boundary và dùng lại contract chung, thay vì thêm abstraction/telemetry để che lỗi.

## 9. Giới hạn audit

Đây không phải chứng nhận bảo mật toàn ứng dụng. Không pentest OAuth/MCP đầy đủ, không load test, không thử provider trả phí, không kiểm chứng chất lượng ảnh thực nghiệm, không đọc dữ liệu tenant khác. Các claim dựa trên source và metadata đều được phân biệt với reproduction thực tế. Cần vòng smoke authenticated sau khi sửa trước khi đánh dấu production-ready.
