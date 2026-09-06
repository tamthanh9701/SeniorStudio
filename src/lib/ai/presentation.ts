import type { AiJobStatus } from "@/db/ai-jobs";

export const JOB_STATUS_LABELS: Record<AiJobStatus, string> = {
  queued: "Đang chờ",
  submitting: "Đang bắt đầu",
  processing: "Đang tạo",
  persisting: "Đang lưu",
  succeeded: "Hoàn thành",
  failed: "Thất bại",
  canceled: "Đã hủy",
};

export const JOB_ERROR_MESSAGES: Record<string, string> = {
  PROVIDER_NOT_CONFIGURED: "Chưa cấu hình nhà cung cấp AI cho workspace này. Liên hệ quản trị viên để thêm API key.",
  INVALID_REQUEST: "Yêu cầu không hợp lệ. Kiểm tra lại prompt hoặc cài đặt rồi thử lại.",
  INVALID_MODEL: "Model không còn được hỗ trợ. Chọn model khác rồi thử lại.",
  MALFORMED_PROVIDER_OUTPUT: "Phản hồi từ nhà cung cấp không đúng định dạng. Thử lại, nếu vẫn lỗi hãy chọn model khác.",
  INVALID_PROVIDER_STATE: "Nhà cung cấp trả về trạng thái không hợp lệ. Thử lại, nếu vẫn lỗi hãy liên hệ hỗ trợ.",
  JOB_NOT_CANCELABLE: "Job này không thể hủy ở trạng thái hiện tại.",
  NOT_FOUND: "Không tìm thấy tài nguyên trên nhà cung cấp. Thử lại hoặc chọn model khác.",
  FILE_UNAVAILABLE: "Tệp nguồn trên nhà cung cấp không còn khả dụng. Thử lại hoặc tạo ảnh mới.",
  FILE_TOO_LARGE: "Tệp quá lớn đối với nhà cung cấp. Thử lại với ảnh nhỏ hơn.",
  VERSION_CONFLICT: "Phiên bản ảnh đã thay đổi từ lúc bạn bắt đầu. Tải lại trang rồi thử lại.",
  GENERATION_FAILED: "Không tạo được ảnh. Thử lại, nếu vẫn lỗi hãy chọn model khác.",
};

export function jobErrorMessage(code: string | null | undefined): string {
  return JOB_ERROR_MESSAGES[code ?? ""] ?? JOB_ERROR_MESSAGES.GENERATION_FAILED;
}

export const JOB_STATUS_ORDER: readonly AiJobStatus[] = [
  "queued",
  "submitting",
  "processing",
  "persisting",
  "succeeded",
  "failed",
  "canceled",
];
