# RA · NEBULA — Tarot Live Studio 2.0

Ứng dụng Tarot TikTok Live chạy cục bộ, giao diện viết lại hoàn toàn: tinh vân tím/hồng/xanh, bộ 78 lá vector Nebula, bàn điều khiển riêng và màn hình phát 9:16. Giữ bộ kết nối TikTok, JSON-RPC, hàng chờ ưu tiên, quà tặng, claim và lời nguyện của dự án gốc.

## Chạy trong 3 bước

Yêu cầu Node.js 20 trở lên, kết nối internet để cài thư viện. Mở Terminal trong thư mục dự án:

```sh
npm ci
npm start
```

Mở **http://localhost:3000**. Bấm **Bật demo** để thử. Bấm **Bật âm thanh xem trước** để nghe trong Studio. Kết nối kênh thật tại **AI & kết nối**.

- Studio: `/` hoặc `/admin`
- Màn hình phát: `/live`
- OBS Browser Source: `http://localhost:3000/live`, kích thước **1080 × 1920**.
- Địa chỉ OBS cũ `/?obs=1` tự chuyển đến màn hình mới.
- Máy chủ mặc định chỉ lắng nghe `127.0.0.1`. Không xuất bản trực tiếp máy chủ điều khiển lên internet.

## Câu hỏi và AI

Người xem bình luận `hỏi: Mình nên nhìn nhận cơ hội chuyển việc thế nào?` hoặc bình luận có dấu `?`. Hệ thống gắn câu hỏi theo ID người xem, giữ nguyên khi người đó follow hoặc tặng quà. Câu hỏi gửi khi lượt đã bắt đầu được lưu cho lượt sau; nội dung đang đọc không bị đổi giữa chừng.

Không có key: lời đọc dựa trên ý nghĩa lá bài và các chủ đề tình cảm, công việc, tài chính, học tập, tổng quan. Đây là các mẫu diễn giải theo chủ đề, không phải mô hình AI hiểu ngôn ngữ toàn diện.

Có key: vào **AI & kết nối**, nhập OpenAI API key và model có hỗ trợ Responses API / Structured Outputs (mặc định `gpt-4.1-mini`). Sau khi lưu, bật **AI diễn giải** tại Phòng phát sóng. Ứng dụng gửi câu hỏi cùng các lá thực sự đã rút, vị trí và ý nghĩa; không gửi avatar, tên hay ID tài khoản. Hạn chế đưa thông tin riêng tư vào câu hỏi. Nội dung AI có thể sai; Tarot không bảo đảm dự đoán chính xác.

Key chỉ giữ trong bộ nhớ của máy chủ và mất khi khởi động lại. Không ghi key vào localStorage, trạng thái công khai hay ZIP. Có thể đặt biến môi trường `OPENAI_API_KEY` trước khi chạy. Không cần gửi key vào cuộc trò chuyện.

Khi AI lỗi, hết hạn mức hoặc trả nội dung không hợp lệ, hệ thống dùng lời đọc theo chủ đề và hiển thị trạng thái. Cả AI diễn giải và giọng OpenAI đều có thể phát sinh phí. AI đọc bài mặc định tắt.

## Giọng đọc

**Giọng đọc & âm nhạc** có ba nguồn:

1. **Trình duyệt / hệ điều hành:** miễn phí, chỉ liệt kê giọng tiếng Việt thực sự được cài; nếu máy không có thì cần cài giọng Việt hoặc chọn dịch vụ khác.
2. **OpenAI:** 13 lựa chọn thực: marin, cedar, coral, nova, shimmer, sage, alloy, ash, ballad, echo, fable, onyx, verse. Dùng model `gpt-4o-mini-tts`, có phong cách ấm áp/sâu lắng/tươi sáng và tốc độ. Nhấn **Nghe thử giọng** để chọn theo tai nghe của bạn; tiếng Việt khác nhau giữa các giọng, không có cam kết giọng vùng miền. Yêu cầu API key có quyền và hạn mức tương ứng.
3. **ZeroTTS:** tương thích worker cũ, tùy chọn nâng cao. Cài Python/môi trường `zerotts` tương thích trong `.venv`, đặt `RA_ENABLE_ZEROTTS=1` trước khi chạy. Worker không tự tải model khi dùng chế độ mặc định. Phong cách giọng áp dụng cho OpenAI và trình duyệt; ZeroTTS dùng giọng gốc `maichi` hoặc `ttsVoice` qua API.

Giọng nói tổng hợp được ghi chú trên màn hình. Khi giọng dịch vụ lỗi, ứng dụng dùng giọng Việt trên máy nếu có. Trình duyệt có thể yêu cầu nhấn **Bật âm thanh**; màn hình xem trước mặc định im lặng. Chỉ bật âm thanh ở một nơi khi phát để tránh tiếng lặp.

## MP3 và OBS

Chọn MP3 tối đa 40 MB trong **Giọng đọc & âm nhạc**. File lưu cục bộ trong `data/music/`, dùng chung cho màn hình live và OBS, tiếp tục khả dụng sau khi mở lại Studio. Có phát/tạm dừng, âm lượng, phát lặp và giảm âm lượng khi có giọng đọc. Tải file mới thay bản nền hiện tại.

## Hàng chờ và hiệu ứng

- Miễn phí: thông điệp ngắn.
- Follow / share: ý nghĩa đầy đủ hơn và câu hỏi suy ngẫm.
- Quà: diễn giải chi tiết, gợi ý thực hành; **1–10 xu: 1 lá**, **11–99 xu: 2 lá**, **100+ xu: 3 lá**.
- Ưu tiên: quà lớn trước; sau đó 2 lượt follow / 1 lượt thường.
- **Tắt demo** dừng sự kiện mới. **Tạm dừng hàng chờ** giữ nguyên lượt hiện tại và tạm ngừng chọn lượt mới. **Bỏ qua lượt** dừng lượt đang đọc. **Xóa hàng chờ** dừng và xóa dữ liệu chờ.
- `claim` / `đón nhận`: ghi nhận nhận bài, thông báo trên màn hình. `cầu…` / `nam mô…` / `chúc…`: lời nguyện và đèn bay.
- Lịch sử giữ 30 lượt trong bộ nhớ phiên máy chủ (giao diện hiển thị 20 gần nhất); khởi động lại sẽ xóa lịch sử và câu hỏi.
- Nền tinh vân chuyển động, sao nhấp nháy, quỹ đạo, hiệu ứng lật bài, phụ đề chia đoạn, nhân vật chờ có avatar trên đầu. Phụ đề phân bổ theo độ dài văn bản, không phải timestamp chính xác từng từ từ TTS.

## Kiểm tra

```sh
npm test
```

Bộ kiểm thử dùng dữ liệu và dịch vụ giả lập, không gọi API trả phí hoặc phòng TikTok thật. Bao gồm 78 lá, phân cấp nội dung, nhận diện chủ đề, câu hỏi đúng người, nâng ưu tiên, mức quà, tạm dừng/reset, giữ kín key, phản hồi AI lỗi và đối chiếu tham chiếu HTML/JS.

Xem `KIEM-THU.md` để biết kết quả và giới hạn kiểm tra của bản giao.

## Cấu trúc

```
server.js                 Kết nối TikTok, JSON-RPC, hàng chờ, timeline
lib/intelligence.js       Diễn giải theo chủ đề, OpenAI, TTS
public/index.html         Studio mới
public/studio.css/js       Điều khiển, câu hỏi, giọng, nhạc, bộ bài
public/live.html/css/js    Màn hình 9:16 và phát âm thanh
public/deck/              78 lá SVG và mặt sau mới
data/cards.json           Bộ nghĩa, tên và đường dẫn lá bài
tts_worker.py             Worker ZeroTTS tùy chọn
tests/                    Kiểm thử tự động không gọi mạng
```

`node_modules`, model ZeroTTS, API key, MP3 người dùng, trạng thái và cache TTS không nằm trong ZIP. Chạy `npm ci` để cài đúng phiên bản thư viện.

Tài liệu tích hợp chính thức:
- https://developers.openai.com/api/docs/guides/structured-outputs
- https://developers.openai.com/api/docs/guides/text-to-speech

