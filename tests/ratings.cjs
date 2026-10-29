// Dish ratings API on the in-memory local store: never touches Mongo or data/store.json.
process.env.MONGODB_URI = '';
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const storeFile = path.join(__dirname, '../data/store.json');
const realWrite = fs.writeFileSync;
fs.writeFileSync = (file, ...rest) => { if (path.resolve(String(file)) !== storeFile) realWrite(file, ...rest); };
const db = require('../lib/db');
const app = require('../api/index');

(async () => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const post = (url, body) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const ratings = async (date) => (await fetch(`${base}/api/ratings?date=${date}`)).json();
  const date = '2026-01-05', dish = 'Tôm rang lá chanh';
  try {
    await post('/api/order', { date, name: 'An', dishes: [dish, 'Lạc rang'], forUser: 'u1', createdBy: 'u1' });
    await post('/api/order', { date, name: 'Bình', dishes: [dish], forUser: 'u2', createdBy: 'u2' });
    await post('/api/order', { date, name: 'Chi', dishes: ['Lạc rang'], createdBy: 'u3' });

    assert.equal((await post('/api/rating', { userId: 'u1', date, dish, stars: 5 })).status, 200);
    let data = await ratings(date);
    let stat = data.stats.find(s => s.dish === dish);
    assert.deepEqual([stat.avg, stat.count, stat.recommended], [5, 1, false], 'one vote is never recommended');
    assert.deepEqual(data.day, [{ userId: 'u1', dish, stars: 5 }]);

    // Re-rating replaces, and names match after whitespace/case normalization.
    assert.equal((await post('/api/rating', { userId: 'u1', date, dish: '  tôm rang   lá chanh ', stars: 4 })).status, 200);
    assert.equal((await post('/api/rating', { userId: 'u2', date, dish, stars: 5 })).status, 200);
    stat = (await ratings(date)).stats.find(s => s.key === 'tôm rang lá chanh');
    assert.deepEqual([stat.avg, stat.count, stat.recommended], [4.5, 2, true]);

    // Ordered without forUser (ordered for themselves under their own id) still counts as their order.
    assert.equal((await post('/api/rating', { userId: 'u3', date, dish: 'Lạc rang', stars: 2 })).status, 200);
    data = await ratings(date);
    assert.equal(data.stats[0].dish, dish, 'best score first');

    assert.equal((await post('/api/rating', { userId: 'u2', date, dish: 'Lạc rang', stars: 5 })).status, 403, 'only own dishes');
    assert.equal((await post('/api/rating', { userId: 'u9', date, dish, stars: 5 })).status, 403, 'no order, no rating');
    assert.equal((await post('/api/rating', { userId: 'u1', date, dish, stars: 6 })).status, 400);
    assert.equal((await post('/api/rating', { userId: 'u1', date, dish, stars: 4.5 })).status, 400);
    assert.equal((await post('/api/rating', { userId: 'u1', date: '2999-01-01', dish, stars: 5 })).status, 400, 'no rating the future');

    // 0 clears a rating.
    assert.equal((await post('/api/rating', { userId: 'u3', date, dish: 'Lạc rang', stars: 0 })).status, 200);
    data = await ratings(date);
    assert.equal(data.stats.some(s => s.dish === 'Lạc rang'), false);
    assert.equal(data.day.length, 2);

    // A lone 5-star doesn't outrank a dish many people rated 4.6.
    const ranked = db.summarizeRatings([
      { key: 'a', dish: 'A', sum: 5, count: 1 },
      { key: 'b', dish: 'B', sum: 46, count: 10 },
      { key: 'c', dish: 'C', sum: 20, count: 10 }
    ]);
    assert.deepEqual(ranked.map(s => s.key), ['b', 'a', 'c']);
  } finally {
    server.close();
    fs.writeFileSync = realWrite;
  }
  console.log('PASS: rate own dishes, re-rate/clear, name normalization, validation, recommended needs 2+ votes, shrunk ranking.');
})().catch(err => { console.error(err); process.exit(1); });
