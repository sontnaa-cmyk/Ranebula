# Kết quả kiểm tra bản 2.0

Đã đạt 13 kiểm thử tự động:

- 78 lá, ID riêng, có đủ file SVG.
- Thông điệp miễn phí < follow < gift trên toàn bộ bộ bài.
- Chủ đề câu hỏi tiếng Việt: tình cảm, công việc, tài chính, học tập, tổng quan.
- Chưa có key: hoạt động và không gửi yêu cầu API.
- AI nhận đúng câu hỏi, các lá và vị trí; structured output; `store: false`.
- Không gửi tên người xem trong đầu vào AI và không lộ key ở trạng thái công khai.
- Phản hồi AI không hợp lệ, từ chối hoặc mã lỗi: quay về đọc theo chủ đề.
- Có danh sách giọng OpenAI thực và chức năng gỡ key.
- Câu hỏi gắn đúng người, giữ khi follow/gift.
- Các ngưỡng quà và chọn hàng ưu tiên.
- Tạm dừng/tiếp tục, demo bật/tắt, reset.
- Kiểm tra và giới hạn giá trị cài đặt.
- Các ID được mã giao diện tham chiếu đều có trong HTML tương ứng.

Đã kiểm tra cú pháp JavaScript và Python. Máy chủ khởi tạo được với các thư viện của dự án.

**Chưa xác minh:** bố cục bản mới bằng trình duyệt, phát MP3 thực tế, tiếng Việt từ dịch vụ TTS, tài khoản OpenAI có key thật và kết nối TikTok Live thật. Trình duyệt kiểm tra không truy cập được máy chủ cục bộ trong môi trường thực hiện. Các bài kiểm thử máy chủ sử dụng bộ hẹn giờ/socket giả lập, không thay thế kiểm thử phát sóng đầu cuối.

Trước phiên live đầu tiên: chạy demo, gửi thử câu hỏi, nghe thử giọng và kiểm tra âm thanh trong OBS. Bản này không kèm key hay sử dụng dịch vụ trả phí để kiểm tra.

