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
  people: {},
  ratings: {}
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

// When MONGODB_URI is set, Mongo errors surface to the user instead of
// silently writing to store.json (which is lost on Vercel).
const DB_UNAVAILABLE = 'Không kết nối được cơ sở dữ liệu, vui lòng thử lại.';

function dbUnavailable(err) {
  console.error('Lỗi MongoDB:', err.message);
  return new Error(DB_UNAVAILABLE, { cause: err });
}

// Health probe: error class only (never the URI or message), so a deploy can be diagnosed safely.
async function pingDb() {
  if (!MONGODB_URI) return 'local';
  try {
    const client = await getMongoClient();
    await client.db('com_trua').command({ ping: 1 });
    return 'ok';
  } catch (err) {
    const cause = err.cause || err;
    return cause.codeName ? `${cause.name}:${cause.codeName}` : cause.name;
  }
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
    // Drop the rejected promise so the next request retries the connection.
    global._mongoClientPromise = null;
    throw dbUnavailable(err);
  }
}

async function getCollections() {
  const client = await getMongoClient();
  if (!client) return null;
  const db = client.db('com_trua');
  return {
    menus: db.collection('menus'),
    orders: db.collection('orders'),
    people: db.collection('people'),
    ratings: db.collection('ratings')
  };
}

// ---------- DB Operations ----------

async function getStateForDate(reqDate) {
  const targetDate = reqDate || todayVN();
  const cols = await getCollections();

  if (cols) {
    try {
      // Independent reads in parallel: one round trip to Atlas instead of three.
      let [menu, ordersList, peopleList] = await Promise.all([
        cols.menus.findOne({ date: targetDate }),
        cols.orders.find({ date: targetDate }).sort({ createdAt: 1 }).toArray(),
        cols.people.find({}).toArray()
      ]);
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
      throw dbUnavailable(err);
    }
  }

  // Local store (no MONGODB_URI)
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
      throw dbUnavailable(err);
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
      throw dbUnavailable(err);
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
      throw dbUnavailable(err);
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
      throw dbUnavailable(err);
    }
  }

  localDb.people[id] = person;
  saveLocalDb();
  return person;
}

// ---------- Dish ratings ----------
// Menus are free text typed each day, so a dish is identified across days by its normalized name.
// Anyone may rate any dish that has appeared on a menu; one vote per person per dish, re-voting replaces it.
const dishKey = (name) => String(name || '').normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();

// Ratings are pulled toward the overall mean until a dish has a few votes, so one 5-star
// doesn't put a dish on top. "Recommended" also needs at least two people agreeing.
const PRIOR_WEIGHT = 2;
const RECOMMEND_MIN_SCORE = 4;
const RECOMMEND_MIN_COUNT = 2;

function summarizeRatings(groups) {
  const total = groups.reduce((acc, g) => ({ sum: acc.sum + g.sum, count: acc.count + g.count }), { sum: 0, count: 0 });
  const mean = total.count ? total.sum / total.count : 3.5;
  return groups
    .map((g) => {
      const score = (PRIOR_WEIGHT * mean + g.sum) / (PRIOR_WEIGHT + g.count);
      return {
        key: g.key,
        dish: g.dish,
        avg: Math.round((g.sum / g.count) * 10) / 10,
        count: g.count,
        score: Math.round(score * 100) / 100,
        recommended: score >= RECOMMEND_MIN_SCORE && g.count >= RECOMMEND_MIN_COUNT
      };
    })
    .sort((a, b) => b.score - a.score || b.count - a.count);
}

// Every dish ever served, keyed by normalized name: latest spelling, how many days, last date.
function dishCatalog(menus) {
  const catalog = new Map();
  [...menus].sort((a, b) => (a.date < b.date ? -1 : 1)).forEach((m) => {
    (m.dishes || []).forEach((name) => {
      const key = dishKey(name);
      if (!key) return;
      const entry = catalog.get(key) || { key, dish: name.trim(), served: 0, lastDate: null };
      entry.dish = name.trim(); entry.served += 1; entry.lastDate = m.date;
      catalog.set(key, entry);
    });
  });
  return catalog;
}

// Rated dishes best first, then never-rated dishes most recently served first.
function buildRatingBoard(menus, groups, mine) {
  const catalog = dishCatalog(menus);
  const stats = new Map(summarizeRatings(groups).map((s) => [s.key, s]));
  const keys = new Set([...catalog.keys(), ...stats.keys()]);
  const dishes = [...keys].map((key) => {
    const c = catalog.get(key), s = stats.get(key);
    return {
      key,
      dish: c?.dish || s.dish,
      served: c?.served || 0,
      lastDate: c?.lastDate || null,
      avg: s?.avg || 0,
      count: s?.count || 0,
      score: s?.score ?? null,
      recommended: !!s?.recommended
    };
  });
  dishes.sort((a, b) =>
    (b.score ?? -1) - (a.score ?? -1) || b.count - a.count ||
    String(b.lastDate || '').localeCompare(String(a.lastDate || '')) || a.dish.localeCompare(b.dish, 'vi'));
  return { dishes, mine };
}

// The first ratings release stored one vote per person per *day* (id user|date|key). Count only each
// person's latest vote per dish, so those older rows can't be counted twice.
function latestVotes(rows) {
  const latest = new Map();
  [...rows].sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0)).forEach((r) => latest.set(`${r.userId}|${r.key}`, r));
  return [...latest.values()];
}

function groupVotes(votes) {
  const byKey = new Map();
  votes.forEach((r) => {
    const g = byKey.get(r.key) || { key: r.key, dish: r.dish, sum: 0, count: 0 };
    g.dish = r.dish; g.sum += r.stars; g.count += 1;
    byKey.set(r.key, g);
  });
  return [...byKey.values()];
}

async function getRatings(userId) {
  const cols = await getCollections();

  if (cols) {
    try {
      const [groups, menus, mine] = await Promise.all([
        cols.ratings.aggregate([
          { $sort: { updatedAt: 1 } },
          { $group: { _id: { key: '$key', userId: '$userId' }, dish: { $last: '$dish' }, stars: { $last: '$stars' } } },
          { $group: { _id: '$_id.key', dish: { $last: '$dish' }, sum: { $sum: '$stars' }, count: { $sum: 1 } } }
        ]).toArray(),
        cols.menus.find({}, { projection: { _id: 0, date: 1, dishes: 1 } }).toArray(),
        userId ? cols.ratings.find({ userId }, { projection: { _id: 0, userId: 1, key: 1, dish: 1, stars: 1, updatedAt: 1 } }).toArray() : []
      ]);
      return buildRatingBoard(
        menus,
        groups.map((g) => ({ key: g._id, dish: g.dish, sum: g.sum, count: g.count })),
        latestVotes(mine).map(({ key, dish, stars }) => ({ key, dish, stars }))
      );
    } catch (err) {
      throw dbUnavailable(err);
    }
  }

  const votes = latestVotes(Object.values(localDb.ratings || {}));
  const mine = userId ? votes.filter((r) => r.userId === userId).map(({ key, dish, stars }) => ({ key, dish, stars })) : [];
  return buildRatingBoard(Object.values(localDb.menus || {}), groupVotes(votes), mine);
}

// stars 1-5 sets the vote, 0 withdraws it. The dish must have been on some menu.
async function saveRating({ userId, dish, stars }) {
  const key = dishKey(dish);
  const id = `${userId}|${key}`;
  const now = Date.now();
  const cols = await getCollections();

  if (cols) {
    try {
      const menus = await cols.menus.find({}, { projection: { _id: 0, date: 1, dishes: 1 } }).toArray();
      const known = dishCatalog(menus).get(key);
      if (!known) throw new Error('UNKNOWN_DISH');
      if (!stars) {
        await cols.ratings.deleteMany({ userId, key });
        return null;
      }
      const doc = { id, userId, dish: known.dish, key, stars, updatedAt: now };
      await cols.ratings.updateOne({ id }, { $set: doc }, { upsert: true });
      await cols.ratings.deleteMany({ userId, key, id: { $ne: id } });
      return doc;
    } catch (err) {
      if (err.message === 'UNKNOWN_DISH') throw err;
      throw dbUnavailable(err);
    }
  }

  if (!localDb.ratings) localDb.ratings = {};
  const known = dishCatalog(Object.values(localDb.menus || {})).get(key);
  if (!known) throw new Error('UNKNOWN_DISH');
  if (!stars) {
    Object.keys(localDb.ratings).forEach((k) => { const r = localDb.ratings[k]; if (r.userId === userId && r.key === key) delete localDb.ratings[k]; });
    saveLocalDb();
    return null;
  }
  Object.keys(localDb.ratings).forEach((k) => { const r = localDb.ratings[k]; if (r.userId === userId && r.key === key) delete localDb.ratings[k]; });
  localDb.ratings[id] = { id, userId, dish: known.dish, key, stars, updatedAt: now };
  saveLocalDb();
  return localDb.ratings[id];
}

module.exports = {
  todayVN,
  pingDb,
  getStateForDate,
  saveMenu,
  saveOrder,
  deleteOrder,
  savePerson,
  getRatings,
  saveRating,
  summarizeRatings,
  latestVotes
};
