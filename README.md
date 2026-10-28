# RCV Live Scoring — chấm điểm trực tiếp + màn chiếu câu hỏi Rung Chuông Vàng

Express + lưu JSON (`data.json`). Trang: `/admin.html` (quản trị), `/screen.html?k=…` (máy chiếu), `/leaderboard.html?k=…`
(bảng xếp hạng), `/ctv.html?token=…` (cộng tác viên chấm trên điện thoại).

## Khoá (không public)
| Ai | Mở bằng | Ghi chú |
|---|---|---|
| Quản trị | mã `ADMIN_KEY` (biến môi trường) nhập ở `/admin.html` | so khớp an toàn; sai 10 lần/15 phút/IP → chặn (429) |
| Máy chiếu + bảng xếp hạng | link có mã `?k=` lấy trong trang quản trị | Admin bấm "Tạo mã màn chiếu mới" khi lộ link; ảnh + nhạc của đề cũng cần mã này |
| CTV | link có mã ngẫu nhiên, mỗi CTV một link (trang quản trị) | nút "Tạo lại toàn bộ link CTV" |

Mọi trang/API: `X-Robots-Tag: noindex`, `Cache-Control: no-store`, `robots.txt` chặn hết. Màn chiếu chỉ nhận phương án từ
bước Play và đáp án từ bước Đáp án (máy chủ không gửi trước).

## Đặt biến môi trường trên Render (Điều phối làm khi deploy)
Render → dịch vụ → **Environment** → thêm `ADMIN_KEY` = chuỗi ngẫu nhiên ≥ 20 ký tự (vd tạo bằng
`node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"`), lưu riêng, KHÔNG ghi vào repo/chat công khai.
Thiếu `ADMIN_KEY` trên Render thì server không khởi động (cố ý). Tuỳ chọn: `DATA_FILE`, `MEDIA_DIR`, `PORT`.

⚠ Render miễn phí **mất dữ liệu khi deploy lại** (đề, ảnh, nhạc, điểm, mã màn chiếu, mã CTV đổi) → sau mỗi lần deploy: nhập lại
đề, gửi lại link CTV + link màn chiếu.

## Nhập đề
1. **Từ PowerPoint (.pptx) — cách chính**: trang quản trị → "Nhập đề từ PowerPoint" → chọn tệp → Đọc & xem trước → Lưu.
   Đọc đúng khuôn slide của trung tâm: slide "Hội thi RUNG CHUÔNG VÀNG – Vòng …" mở vòng; slide "Câu số N": đề, 4 phương án
   `A. …`–`D. …`, **đáp án đúng = phương án còn lại khi bấm nút Đáp án trong slide** (theo hiệu ứng biến mất; tên hình
   "dap an dung" trong bộ đề mẫu đặt nhầm ở nhiều slide nên chỉ dùng khi slide không có hiệu ứng), câu tự luận (đáp án mẫu =
   ô hiện khi bấm Đáp án), ảnh minh hoạ, số giây đếm (10/15), nhạc gắn nút Play / nút Đáp án, âm slide kết.
   Ảnh + nhạc lưu ở `MEDIA_DIR` (mặc định `media/` cạnh data.json, đã .gitignore) — **không đưa đề vào repo**.
2. **Dán từ Excel** (không ảnh/nhạc): 8 cột `Vòng | Câu | Đề | A | B | C | D | Đáp án`, 2 vòng × 10 câu.

## Điều khiển màn chiếu (giống bấm slide)
Mở vòng → Hiện câu (đề + ảnh + nút Play) → ▶ Play (4 phương án + đếm ngược + nhạc; số giây theo slide, sửa được) → hết giờ
hiện nút "???" → Đáp án (3 phương án sai biến mất / hiện đáp án mẫu, âm công bố nếu slide có) → "Sang câu tiếp →" ở khung
trạng thái (sang vòng mới thì về slide mở vòng). "Hiện bảng điểm", "Màn kết thúc" (âm kết). Máy chiếu bấm 1 lần
"🔊 Bật âm thanh" khi mở (trình duyệt bắt buộc), F11 toàn màn hình. Vòng ngoài 2 vòng đầu (vd Vòng C tự luận loại trực tiếp)
không cộng điểm.

## Chạy trên máy (xem thử)
```
npm install
set ADMIN_KEY=<mã tự đặt>        (PowerShell: $env:ADMIN_KEY="<mã>")
set PORT=4110
npm start
```
Không đặt `ADMIN_KEY` thì server tự sinh mã và in ra màn hình. Mở `http://localhost:4110/admin.html`.

## Kiểm tự động
`python scripts/check_screen.py <thư mục 3 tệp pptx mẫu>` (Playwright + Edge): khoá, đọc 3 bộ đề, chạy hết 30 câu trên màn
chiếu 1920×1080 + CTV iPhone 13 (kịch bản 4 lượt chạm), nhạc đúng từng bước, bảng điểm, màn kết. Ảnh ra `shots/` (.gitignore).
