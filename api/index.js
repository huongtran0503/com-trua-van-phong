require('dotenv').config();
const express = require('express');
const path = require('path');
const os = require('os');
const db = require('../lib/db');

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static assets from public/ folder (Local development)
app.use(express.static(path.join(__dirname, '..', 'public')));

// Optional WebSocket broadcaster hook for local server
let broadcastHook = null;
app.setBroadcastHook = (fn) => {
  broadcastHook = fn;
};

// ---------- API Routes ----------

// 1. Get state for date
app.get('/api/state', async (req, res) => {
  try {
    const reqDate = req.query.date || db.todayVN();
    const state = await db.getStateForDate(reqDate);
    res.json(state);
  } catch (err) {
    console.error('Lỗi /api/state:', err);
    res.status(500).json({ error: 'Lỗi máy chủ khi lấy dữ liệu' });
  }
});

// 2. Save or update menu
app.post('/api/menu', async (req, res) => {
  try {
    const { date, dishes, postedBy, locked } = req.body;
    if (!date) return res.status(400).json({ error: 'Thiếu ngày' });

    const menu = await db.saveMenu({ date, dishes, postedBy, locked });
    if (broadcastHook) {
      broadcastHook('MENU_UPDATED', date, menu);
    }
    res.json({ success: true, menu });
  } catch (err) {
    console.error('Lỗi /api/menu:', err);
    res.status(500).json({ error: err.message || 'Lỗi khi lưu thực đơn' });
  }
});

// 3. Save or update order
app.post('/api/order', async (req, res) => {
  try {
    const { id, date, name, dishes, rice, note, forUser, createdBy } = req.body;
    const targetDate = date || db.todayVN();

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Vui lòng nhập tên người đặt' });
    }
    if (!dishes || !dishes.length) {
      return res.status(400).json({ error: 'Vui lòng chọn ít nhất một món' });
    }

    const order = await db.saveOrder({ id, date: targetDate, name, dishes, rice, note, forUser, createdBy });
    if (broadcastHook) {
      broadcastHook('ORDER_UPDATED', targetDate, { order });
    }
    res.json({ success: true, order });
  } catch (err) {
    if (err.message === 'LOCKED') {
      return res.status(403).json({ error: 'Đơn ngày này đã chốt, không thể thay đổi.' });
    }
    console.error('Lỗi /api/order:', err);
    res.status(500).json({ error: err.message || 'Lỗi khi lưu đơn đặt' });
  }
});

// 4. Delete order
app.delete('/api/order/:id', async (req, res) => {
  try {
    const orderId = req.params.id;
    const order = await db.deleteOrder(orderId);
    if (!order) {
      return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
    }

    if (broadcastHook) {
      broadcastHook('ORDER_DELETED', order.date, { id: orderId });
    }
    res.json({ success: true, id: orderId });
  } catch (err) {
    if (err.message === 'LOCKED') {
      return res.status(403).json({ error: 'Đơn ngày này đã chốt, không thể xóa.' });
    }
    console.error('Lỗi DELETE /api/order:', err);
    res.status(500).json({ error: err.message || 'Lỗi khi xóa đơn đặt' });
  }
});

// 5. Save or update person
app.post('/api/people', async (req, res) => {
  try {
    const { id, name } = req.body;
    if (!id || !name) return res.status(400).json({ error: 'Thiếu thông tin' });

    const person = await db.savePerson({ id, name });
    if (broadcastHook) {
      broadcastHook('PEOPLE_UPDATED', db.todayVN(), { person });
    }
    res.json({ success: true, person });
  } catch (err) {
    console.error('Lỗi /api/people:', err);
    res.status(500).json({ error: err.message || 'Lỗi khi lưu thông tin người dùng' });
  }
});

// 6. Dish ratings: every dish ever served with its votes, plus the caller's own votes
app.get('/api/ratings', async (req, res) => {
  try {
    const user = typeof req.query.user === 'string' ? req.query.user.slice(0, 80) : '';
    res.json(await db.getRatings(user));
  } catch (err) {
    console.error('Lỗi /api/ratings:', err);
    res.status(500).json({ error: 'Lỗi máy chủ khi lấy đánh giá' });
  }
});

// One vote per person per dish; no order needed. stars 0 withdraws the vote.
app.post('/api/rating', async (req, res) => {
  try {
    const { userId, dish, stars } = req.body;
    if (typeof userId !== 'string' || !userId || userId.length > 80 ||
        typeof dish !== 'string' || !dish.trim() || dish.length > 120 ||
        !Number.isInteger(stars) || stars < 0 || stars > 5) {
      return res.status(400).json({ error: 'Đánh giá không hợp lệ' });
    }

    const rating = await db.saveRating({ userId, dish, stars });
    if (broadcastHook) {
      broadcastHook('RATING_UPDATED', db.todayVN(), { rating });
    }
    res.json({ success: true, rating });
  } catch (err) {
    if (err.message === 'UNKNOWN_DISH') {
      return res.status(404).json({ error: 'Món này chưa có trong thực đơn nào.' });
    }
    console.error('Lỗi /api/rating:', err);
    res.status(500).json({ error: err.message || 'Lỗi khi lưu đánh giá' });
  }
});

// 7. Network info (Office Wi-Fi IP helper)
app.get('/api/network', (req, res) => {
  const PORT = process.env.PORT || 3000;
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push({ name, address: net.address, url: `http://${net.address}:${PORT}` });
      }
    }
  }
  res.json({
    port: PORT,
    localUrl: `http://localhost:${PORT}`,
    lanIps: ips,
    isVercel: !!process.env.VERCEL
  });
});

// 8. Health check
app.get('/api/health', async (req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    env: process.env.VERCEL ? 'vercel' : 'local',
    hasMongo: !!process.env.MONGODB_URI,
    db: await db.pingDb()
  });
});

module.exports = app;
