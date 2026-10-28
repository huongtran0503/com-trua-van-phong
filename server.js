require('dotenv').config();
const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const os = require('os');
const app = require('./api/index');
const db = require('./lib/db');

const PORT = process.env.PORT || 3000;
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Broadcast updates to all connected local WebSocket clients
function broadcast(type, date, data = {}) {
  const message = JSON.stringify({ type, date, data, timestamp: Date.now() });
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
}
app.setBroadcastHook(broadcast);

// WebSocket connection handling
wss.on('connection', async (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  const today = db.todayVN();
  const initialState = await db.getStateForDate(today);

  ws.send(JSON.stringify({
    type: 'INIT',
    date: today,
    data: initialState
  }));

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message);
      if (data.type === 'SUBSCRIBE_DATE') {
        const state = await db.getStateForDate(data.date);
        ws.send(JSON.stringify({
          type: 'DATE_STATE',
          date: data.date,
          data: state
        }));
      }
    } catch (e) {
      console.error('Invalid WS message', e);
    }
  });
});

// Heartbeat to prune dead connections
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
  console.log('  🍙 CƠM TRƯA VĂN PHÒNG - MONGODB CLOUD & REALTIME');
  console.log('======================================================');
  console.log(`  ➜ Local:   http://localhost:${PORT}`);
  ips.forEach((ip) => {
    console.log(`  ➜ Wi-Fi:   ${ip}  (Mọi người cùng Wi-Fi văn phòng có thể vào)`);
  });
  console.log('  ➜ Database: MongoDB Atlas (com_trua collection)');
  console.log('======================================================\n');
});
