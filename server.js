const express = require('express');
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'store.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Vietnamese Timezone Helper
const TZ = 'Asia/Ho_Chi_Minh';
function todayVN() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

// Initial Database Structure
let db = {
  menus: {},
  orders: {},
  people: {}
};

// Load database from file
function loadDb() {
  try {
    if (fs.existsSync(DB_FILE)) {
      const data = fs.readFileSync(DB_FILE, 'utf8');
      db = JSON.parse(data);
    }
  } catch (err) {
    console.error('Lỗi khi đọc file store.json:', err);
  }

  // Ensure default menu for today
  const today = todayVN();
  if (!db.menus) db.menus = {};
  if (!db.orders) db.orders = {};
  if (!db.people) db.people = {};

  if (!db.menus[today]) {
    db.menus[today] = {
      date: today,
      dishes: [
        'Sườn heo sốt chua ngọt',
        'Bò xào tiêu đen rau củ',
        'Gà ta chiên nước mắm',
        'Cá basa kho tộ',
        'Canh cải thịt băm',
        'Rau muống xào tỏi'
      ],
      postedBy: 'admin',
      locked: false,
      lockedAt: null,
      updatedAt: Date.now()
    };
    saveDb();
  }
}

// Save database to file
function saveDb() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error('Lỗi khi lưu file store.json:', err);
  }
}

loadDb();

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Broadcast updates to all connected WebSocket clients
function broadcast(type, date, data = {}) {
  const message = JSON.stringify({ type, date, data, timestamp: Date.now() });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}

// Helper: Get state for a specific date
function getStateForDate(reqDate) {
  const targetDate = reqDate || todayVN();
  const menu = db.menus[targetDate] || null;
  const dayOrders = Object.values(db.orders).filter((o) => o.date === targetDate);
  // Sort orders chronologically
  dayOrders.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  return {
    date: targetDate,
    menu,
    orders: dayOrders,
    people: db.people,
    serverTime: Date.now()
  };
}

// ---------- API Routes ----------

// 1. Get state for a date
app.get('/api/state', (req, res) => {
  const reqDate = req.query.date || todayVN();
  res.json(getStateForDate(reqDate));
});

// 2. Save or update menu
app.post('/api/menu', (req, res) => {
  const { date, dishes, postedBy, locked } = req.body;
  if (!date) return res.status(400).json({ error: 'Thiếu ngày' });

  const existing = db.menus[date] || {};
  db.menus[date] = {
    date,
    dishes: Array.isArray(dishes) ? dishes : existing.dishes || [],
    postedBy: postedBy || existing.postedBy || 'admin',
    locked: typeof locked === 'boolean' ? locked : !!existing.locked,
    lockedAt: locked ? Date.now() : (locked === false ? null : existing.lockedAt),
    updatedAt: Date.now()
  };

  saveDb();
  broadcast('MENU_UPDATED', date, db.menus[date]);
  res.json({ success: true, menu: db.menus[date] });
});

// 3. Save or update order
app.post('/api/order', (req, res) => {
  const { id, date, name, dishes, rice, note, forUser, createdBy } = req.body;
  const targetDate = date || todayVN();
  const menu = db.menus[targetDate];

  if (menu && menu.locked) {
    return res.status(403).json({ error: 'Đơn ngày này đã chốt, không thể thay đổi.' });
  }

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Vui lòng nhập tên người đặt' });
  }
  if (!dishes || !dishes.length) {
    return res.status(400).json({ error: 'Vui lòng chọn ít nhất một món' });
  }

  const orderId = id || 'ord_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
  const now = Date.now();

  db.orders[orderId] = {
    id: orderId,
    date: targetDate,
    name: name.trim(),
    dishes: Array.isArray(dishes) ? dishes : [dishes],
    rice: rice || '',
    note: (note || '').trim(),
    forUser: forUser || null,
    createdBy: createdBy || name.trim(),
    createdAt: db.orders[orderId]?.createdAt || now,
    updatedAt: now
  };

  saveDb();
  broadcast('ORDER_UPDATED', targetDate, { order: db.orders[orderId] });
  res.json({ success: true, order: db.orders[orderId] });
});

// 4. Delete order
app.delete('/api/order/:id', (req, res) => {
  const orderId = req.params.id;
  const order = db.orders[orderId];

  if (!order) {
    return res.status(404).json({ error: 'Không tìm thấy đơn hàng' });
  }

  const targetDate = order.date;
  const menu = db.menus[targetDate];
  if (menu && menu.locked) {
    return res.status(403).json({ error: 'Đơn ngày này đã chốt, không thể xóa.' });
  }

  delete db.orders[orderId];
  saveDb();

  broadcast('ORDER_DELETED', targetDate, { id: orderId });
  res.json({ success: true, id: orderId });
});

// 5. Save or update user name
app.post('/api/people', (req, res) => {
  const { id, name } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'Thiếu thông tin' });

  db.people[id] = {
    id,
    name: name.trim(),
    updatedAt: Date.now()
  };

  saveDb();
  broadcast('PEOPLE_UPDATED', todayVN(), { person: db.people[id] });
  res.json({ success: true, person: db.people[id] });
});

// 6. Network info (Local IPs for office Wi-Fi sharing)
app.get('/api/network', (req, res) => {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      // IPv4 and not internal localhost
      if (net.family === 'IPv4' && !net.internal) {
        ips.push({ name, address: net.address, url: `http://${net.address}:${PORT}` });
      }
    }
  }
  res.json({ port: PORT, localUrl: `http://localhost:${PORT}`, lanIps: ips });
});

// ---------- WebSocket Connection Handling ----------
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  // Send initial welcome & today's state
  ws.send(JSON.stringify({
    type: 'INIT',
    date: todayVN(),
    data: getStateForDate(todayVN())
  }));

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'SUBSCRIBE_DATE') {
        ws.send(JSON.stringify({
          type: 'DATE_STATE',
          date: data.date,
          data: getStateForDate(data.date)
        }));
      }
    } catch (e) {
      console.error('Invalid WS message', e);
    }
  });
});

// Heartbeat interval to prune dead connections
const interval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(interval);
});

// Start Server
server.listen(PORT, '0.0.0.0', () => {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const net of interfaces[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        ips.push(`http://${net.address}:${PORT}`);
      }
    }
  }

  console.log('\n======================================================');
  console.log('  🍙 CƠM TRƯA VĂN PHÒNG - REALTIME SERVER ĐANG CHẠY');
  console.log('======================================================');
  console.log(`  ➜ Local:   http://localhost:${PORT}`);
  ips.forEach((ip) => {
    console.log(`  ➜ Wi-Fi:   ${ip}  (Mọi người cùng Wi-Fi văn phòng có thể vào)`);
  });
  console.log('======================================================\n');
});
