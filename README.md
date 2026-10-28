# 🍙 Cơm Trưa Văn Phòng - Realtime App

Ứng dụng đặt cơm trưa văn phòng phong cách tinh gọn **Xanh Dương Chàm (Indigo Blue) · Trắng Hạt Gạo · Đen Lá Rong** với **Họa tiết xoắn ốc Nhật Bản**, hỗ trợ đồng bộ **Realtime tức thì** cho toàn bộ đồng nghiệp trong công ty qua mạng Wi-Fi LAN hoặc Internet.

---

## 🚀 Cách chạy ứng dụng

### Cách 1: Bấm đúp chạy ngay trên Windows
Chỉ cần nhấp đúp chuột vào file **`start.bat`** trong thư mục này.

### Cách 2: Chạy qua dòng lệnh (Terminal / PowerShell)
```bash
npm start
# hoặc
node server.js
```

---

## 🌐 Đường dẫn truy cập

Khi server chạy, hệ thống sẽ tự động phát hiện địa chỉ mạng:

- **Máy của bạn (Local)**: [http://localhost:3000](http://localhost:3000)
- **Đồng nghiệp trong cùng Wi-Fi văn phòng**:
  `http://<IP-may-ban>:3000` (ví dụ: `http://172.16.1.167:3000`)
  *(Bạn có thể bấm biểu tượng Share trên thanh tiêu đề để copy link gửi nhóm Zalo/Telegram).*

---

## ✨ Điểm nổi bật

1. **Đồng bộ thời gian thực (Realtime WebSockets)**: Khi bất kỳ ai đặt món, sửa món, hủy đơn hoặc chốt sổ, màn hình của mọi người đều tự động cập nhật ngay lập tức mà không cần bấm F5.
2. **Lưu trữ bền vững (Persistent JSON Database)**: Toàn bộ thực đơn và đơn đặt hàng được tự động lưu vào thư mục `data/store.json`, không sợ mất dữ liệu khi tắt máy hay khởi động lại.
3. **Phân tầng thị giác chuẩn mực**:
   - Vùng chọn món và nút **"Đặt cơm ngay"** nổi bật làm hành động trọng tâm.
   - Danh sách đơn hàng rõ ràng, tự động tính tổng số suất.
   - Hộp công cụ xuất tin nhắn và chốt đơn được thu gọn nhẹ nhàng ở góc phụ.
4. **Hỗ trợ PWA**: Có thể mở trên điện thoại (iPhone / Android) và bấm "Thêm vào màn hình chính" (Add to Home Screen) để dùng như một ứng dụng di động thật thụ.
