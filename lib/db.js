require('dotenv').config();
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');

const MONGODB_URI = process.env.MONGODB_URI;
const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

// Default Menu Items
const DEFAULT_DISHES = [
  'Sườn heo sốt chua ngọt',
  'Bò xào tiêu đen rau củ',
  'Gà ta chiên nước mắm',
  'Cá basa kho tộ',
  'Canh cải thịt băm',
  'Rau muống xào tỏi'
];

// Local JSON File Fallback Store
let localDb = {
  menus: {},
  orders: {},
  people: {}
};

function ensureLocalDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(STORE_FILE)) {
      localDb = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    }
  } catch (e) {
    console.warn('Lỗi đọc local store.json:', e.message);
  }
}
ensureLocalDataDir();

function saveLocalDb() {
  try {
    fs.writeFileSync(STORE_FILE, JSON.stringify(localDb, null, 2), 'utf8');
  } catch (e) {
    // In serverless / read-only filesystem environments, file write may fail silently
  }
}

// Vietnam Timezone Helper (YYYY-MM-DD)
function todayVN() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(new Date());
}

// Global cached MongoDB Client Promise for Serverless (Vercel) & Local reuse
let cachedClient = null;

async function getMongoClient() {
  if (!MONGODB_URI) {
    return null;
  }
  if (cachedClient) {
    return cachedClient;
  }
  try {
    if (!global._mongoClientPromise) {
      const client = new MongoClient(MONGODB_URI, {
        maxPoolSize: 10,
        serverSelectionTimeoutMS: 5000
      });
      global._mongoClientPromise = client.connect();
    }
    cachedClient = await global._mongoClientPromise;
    return cachedClient;
  } catch (err) {
    console.error('Lỗi kết nối MongoDB Atlas:', err.message);
    return null;
  }
}

async function getCollections() {
  const client = await getMongoClient();
  if (!client) return null;
  const db = client.db('com_trua');
  return {
    menus: db.collection('menus'),
    orders: db.collection('orders'),
    people: db.collection('people')
  };
}

// ---------- DB Operations ----------

async function getStateForDate(reqDate) {
  const targetDate = reqDate || todayVN();
  const cols = await getCollections();

  if (cols) {
    try {
      let menu = await cols.menus.findOne({ date: targetDate });
      if (!menu && targetDate === todayVN()) {
        menu = {
          date: targetDate,
          dishes: DEFAULT_DISHES,
          postedBy: 'admin',
          locked: false,
          lockedAt: null,
          updatedAt: Date.now()
        };
        await cols.menus.updateOne(
          { date: targetDate },
          { $set: menu },
          { upsert: true }
        );
      }

      const ordersList = await cols.orders
        .find({ date: targetDate })
        .sort({ createdAt: 1 })
        .toArray();

      const peopleList = await cols.people.find({}).toArray();
      const peopleMap = {};
      peopleList.forEach((p) => {
        peopleMap[p.id] = { id: p.id, name: p.name, updatedAt: p.updatedAt };
      });

      return {
        date: targetDate,
        menu: menu ? {
          date: menu.date,
          dishes: menu.dishes || [],
          postedBy: menu.postedBy || 'admin',
          locked: !!menu.locked,
          lockedAt: menu.lockedAt || null,
          updatedAt: menu.updatedAt || Date.now()
        } : null,
        orders: ordersList.map((o) => ({
          id: o.id,
          date: o.date,
          name: o.name,
          dishes: o.dishes || [],
          rice: o.rice || '',
          note: o.note || '',
          forUser: o.forUser || null,
          createdBy: o.createdBy || o.name,
          createdAt: o.createdAt || 0,
          updatedAt: o.updatedAt || 0
        })),
        people: peopleMap,
        serverTime: Date.now(),
        dbType: 'mongodb'
      };
    } catch (err) {
      console.error('Lỗi khi truy vấn MongoDB, chuyển fallback local:', err.message);
    }
  }

  // Fallback Local
  if (!localDb.menus) localDb.menus = {};
  if (!localDb.orders) localDb.orders = {};
  if (!localDb.people) localDb.people = {};

  if (!localDb.menus[targetDate] && targetDate === todayVN()) {
    localDb.menus[targetDate] = {
      date: targetDate,
      dishes: DEFAULT_DISHES,
      postedBy: 'admin',
      locked: false,
      lockedAt: null,
      updatedAt: Date.now()
    };
    saveLocalDb();
  }

  const dayOrders = Object.values(localDb.orders).filter((o) => o.date === targetDate);
  dayOrders.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));

  return {
    date: targetDate,
    menu: localDb.menus[targetDate] || null,
    orders: dayOrders,
    people: localDb.people || {},
    serverTime: Date.now(),
    dbType: 'local'
  };
}

async function saveMenu({ date, dishes, postedBy, locked }) {
  if (!date) throw new Error('Thiếu ngày');
  const cols = await getCollections();

  if (cols) {
    try {
      const existing = (await cols.menus.findOne({ date })) || {};
      const menuDoc = {
        date,
        dishes: Array.isArray(dishes) ? dishes : existing.dishes || [],
        postedBy: postedBy || existing.postedBy || 'admin',
        locked: typeof locked === 'boolean' ? locked : !!existing.locked,
        lockedAt: locked ? Date.now() : locked === false ? null : existing.lockedAt,
        updatedAt: Date.now()
      };

      await cols.menus.updateOne(
        { date },
        { $set: menuDoc },
        { upsert: true }
      );
      return menuDoc;
    } catch (err) {
      console.error('Lỗi lưu menu MongoDB:', err.message);
    }
  }

  // Local fallback
  const existing = localDb.menus[date] || {};
  localDb.menus[date] = {
    date,
    dishes: Array.isArray(dishes) ? dishes : existing.dishes || [],
    postedBy: postedBy || existing.postedBy || 'admin',
    locked: typeof locked === 'boolean' ? locked : !!existing.locked,
    lockedAt: locked ? Date.now() : locked === false ? null : existing.lockedAt,
    updatedAt: Date.now()
  };
  saveLocalDb();
  return localDb.menus[date];
}

async function saveOrder({ id, date, name, dishes, rice, note, forUser, createdBy }) {
  const targetDate = date || todayVN();
  const cols = await getCollections();
  const now = Date.now();

  if (cols) {
    try {
      const menu = await cols.menus.findOne({ date: targetDate });
      if (menu && menu.locked) {
        throw new Error('LOCKED');
      }

      let existing = null;
      if (id) {
        existing = await cols.orders.findOne({ id });
      }

      const orderId = id || 'ord_' + now + '_' + Math.random().toString(36).slice(2, 7);
      const orderDoc = {
        id: orderId,
        date: targetDate,
        name: name.trim(),
        dishes: Array.isArray(dishes) ? dishes : [dishes],
        rice: rice || '',
        note: (note || '').trim(),
        forUser: forUser || null,
        createdBy: createdBy || name.trim(),
        createdAt: existing?.createdAt || now,
        updatedAt: now
      };

      await cols.orders.updateOne(
        { id: orderId },
        { $set: orderDoc },
        { upsert: true }
      );
      return orderDoc;
    } catch (err) {
      if (err.message === 'LOCKED') throw err;
      console.error('Lỗi lưu order MongoDB:', err.message);
    }
  }

  // Local fallback
  const menu = localDb.menus[targetDate];
  if (menu && menu.locked) {
    throw new Error('LOCKED');
  }

  const orderId = id || 'ord_' + now + '_' + Math.random().toString(36).slice(2, 7);
  localDb.orders[orderId] = {
    id: orderId,
    date: targetDate,
    name: name.trim(),
    dishes: Array.isArray(dishes) ? dishes : [dishes],
    rice: rice || '',
    note: (note || '').trim(),
    forUser: forUser || null,
    createdBy: createdBy || name.trim(),
    createdAt: localDb.orders[orderId]?.createdAt || now,
    updatedAt: now
  };
  saveLocalDb();
  return localDb.orders[orderId];
}

async function deleteOrder(orderId) {
  const cols = await getCollections();

  if (cols) {
    try {
      const order = await cols.orders.findOne({ id: orderId });
      if (!order) return null;

      const menu = await cols.menus.findOne({ date: order.date });
      if (menu && menu.locked) {
        throw new Error('LOCKED');
      }

      await cols.orders.deleteOne({ id: orderId });
      return order;
    } catch (err) {
      if (err.message === 'LOCKED') throw err;
      console.error('Lỗi xóa order MongoDB:', err.message);
    }
  }

  // Local fallback
  const order = localDb.orders[orderId];
  if (!order) return null;
  const menu = localDb.menus[order.date];
  if (menu && menu.locked) {
    throw new Error('LOCKED');
  }
  delete localDb.orders[orderId];
  saveLocalDb();
  return order;
}

async function savePerson({ id, name }) {
  const cols = await getCollections();
  const now = Date.now();
  const person = {
    id,
    name: name.trim(),
    updatedAt: now
  };

  if (cols) {
    try {
      await cols.people.updateOne(
        { id },
        { $set: person },
        { upsert: true }
      );
      return person;
    } catch (err) {
      console.error('Lỗi lưu person MongoDB:', err.message);
    }
  }

  localDb.people[id] = person;
  saveLocalDb();
  return person;
}

module.exports = {
  todayVN,
  getStateForDate,
  saveMenu,
  saveOrder,
  deleteOrder,
  savePerson
};
