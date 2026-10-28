# 🍙 Cơm Trưa Văn Phòng - Realtime & Vercel Ready

Ứng dụng đặt cơm trưa văn phòng phong cách tinh gọn **Xanh Dương Chàm (Indigo Blue) · Trắng Hạt Gạo · Đen Lá Rong** với **Họa tiết xoắn ốc Nhật Bản**, hỗ trợ đồng bộ **Realtime tức thì** cho toàn bộ đồng nghiệp trong công ty qua Vercel Cloud, Internet hoặc mạng Wi-Fi LAN.

---

## ⚡ Hướng dẫn Deploy lên Vercel (1-Click)

Dự án đã được cấu hình chuẩn Serverless Function và sẵn sàng 100% để deploy lên Vercel:

1. Đăng nhập vào [vercel.com](https://vercel.com) (bằng tài khoản GitHub cá nhân `huongtran0503`).
2. Bấm **Add New...** ➜ **Project**.
3. Tìm và chọn repository **`huongtran0503/com-trua-van-phong`** rồi bấm **Import**.
4. Mở rộng phần **Environment Variables** và thêm biến sau:
   - **Key**: `MONGODB_URI`
   - **Value**: `mongodb+srv://huongtt009_db_user:5K7Fm1TnkpmcPAyk@cluster0.jaisrlu.mongodb.net/com_trua?retryWrites=true&w=majority`
5. Bấm nút **Deploy**.
   - Sau ~30 giây, Vercel sẽ cấp cho bạn một domain miễn phí dạng `https://com-trua-van-phong.vercel.app`.
   - Mọi người trong công ty mở link từ điện thoại, máy tính, 4G hay Wi-Fi đều đặt cơm và xem đơn đồng bộ tức thì!

---

## 🚀 Cách chạy ứng dụng cục bộ (Local / Office Wi-Fi)

### Cách 1: Bấm đúp chạy ngay trên Windows
Chỉ cần nhấp đúp chuột vào file **`start.bat`** trong thư mục dự án.

### Cách 2: Chạy qua dòng lệnh (Terminal / PowerShell)
```bash
npm start
# hoặc
node server.js
```

Khi server chạy trên máy bạn:
- **Máy của bạn (Local)**: [http://localhost:3000](http://localhost:3000)
- **Đồng nghiệp trong cùng Wi-Fi văn phòng**:
  `http://<IP-may-ban>:3000` (ví dụ: `http://172.16.1.167:3000`)
  *(Bấm biểu tượng Share trên thanh tiêu đề để copy link gửi nhóm Zalo/Telegram).*

---

## ✨ Điểm nổi bật kỹ thuật

1. **Cơ sở dữ liệu đám mây (MongoDB Atlas Cloud)**: Dữ liệu thực đơn, đơn đặt hàng và người dùng được lưu trữ an toàn trên MongoDB Atlas, không bao giờ bị mất khi khởi động lại server hoặc tắt máy.
2. **Cơ chế đồng bộ Realtime Hybrid (WebSocket + Smart Polling)**:
   - Khi chạy Local/Server riêng: Tự động dùng WebSockets độ trễ siêu thấp.
   - Khi chạy trên Vercel Serverless: Tự động kích hoạt cơ chế Smart Sync Cloud Polling (3.5s khi mở tab) và cập nhật tức thì (Optimistic UI) khi đặt món hoặc chốt đơn.
3. **Phân tầng thị giác cao cấp**:
   - Vùng chọn món và nút **"Đặt cơm ngay"** nổi bật làm hành động trọng tâm.
   - Danh sách đơn hàng rõ ràng, tự động đếm tổng suất theo từng món.
   - Hộp công cụ xuất tin nhắn Zalo/Slack và chốt đơn thu gọn thanh lịch.
4. **Hỗ trợ PWA & Mobile Web**: Mở mượt mà trên iPhone/Android, hỗ trợ "Thêm vào màn hình chính" (Add to Home Screen).
