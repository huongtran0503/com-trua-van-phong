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
  const board = async (user = '') => (await fetch(`${base}/api/ratings?user=${encodeURIComponent(user)}`)).json();
  const entry = (data, key) => data.dishes.find(d => d.key === key);
  const dish = 'Tôm rang lá chanh', key = 'tôm rang lá chanh';
  try {
    // Two menus a week apart; the second one spells the dish with extra spaces.
    await post('/api/menu', { date: '2026-01-05', dishes: [dish, 'Lạc rang'] });
    await post('/api/menu', { date: '2026-01-12', dishes: ['  Tôm rang  lá chanh', 'Cá basa kho tộ'] });

    let data = await board();
    let tom = entry(data, key);
    assert.deepEqual([tom.served, tom.lastDate, tom.count], [2, '2026-01-12', 0], 'dishes are unique across menus');
    assert.ok(entry(data, 'lạc rang') && entry(data, 'cá basa kho tộ'), 'unrated dishes are listed too');

    // No order needed to vote.
    assert.equal((await post('/api/rating', { userId: 'u1', dish, stars: 5 })).status, 200);
    data = await board('u1');
    tom = entry(data, key);
    assert.deepEqual([tom.avg, tom.count, tom.recommended], [5, 1, false], 'one vote is never recommended');
    assert.deepEqual(data.mine, [{ key, dish: tom.dish, stars: 5 }]);
    assert.equal(data.dishes[0].key, key, 'rated dishes come first');

    // One vote per person per dish: re-voting (any spelling) replaces it instead of adding.
    assert.equal((await post('/api/rating', { userId: 'u1', dish: ' tôm RANG lá chanh ', stars: 4 })).status, 200);
    assert.equal((await post('/api/rating', { userId: 'u2', dish, stars: 5 })).status, 200);
    tom = entry(await board(), key);
    assert.deepEqual([tom.avg, tom.count, tom.recommended], [4.5, 2, true]);

    assert.equal((await post('/api/rating', { userId: 'u3', dish: 'Lạc rang', stars: 2 })).status, 200);
    assert.equal((await board()).dishes[0].key, key, 'best score first');

    assert.equal((await post('/api/rating', { userId: 'u1', dish: 'Phở bò', stars: 5 })).status, 404, 'only dishes that were on a menu');
    assert.equal((await post('/api/rating', { userId: 'u1', dish, stars: 6 })).status, 400);
    assert.equal((await post('/api/rating', { userId: 'u1', dish, stars: 4.5 })).status, 400);
    assert.equal((await post('/api/rating', { dish, stars: 4 })).status, 400);

    // 0 withdraws a vote.
    assert.equal((await post('/api/rating', { userId: 'u3', dish: 'Lạc rang', stars: 0 })).status, 200);
    assert.equal(entry(await board(), 'lạc rang').count, 0);
    assert.deepEqual((await board('u3')).mine, []);

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
  console.log('PASS: vote without ordering, one vote per person per dish, unique dishes across menus, validation, recommended needs 2+ votes, shrunk ranking.');
})().catch(err => { console.error(err); process.exit(1); });
