// Regression: with MONGODB_URI set, a Mongo outage must surface as an error,
// never silently write to data/store.json (lost on Vercel), and must retry next call.
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/com_trua';
const storeFile = path.join(__dirname, '../data/store.json');
const before = fs.existsSync(storeFile) ? fs.readFileSync(storeFile, 'utf8') : null;
const db = require('../lib/db');
const unavailable = { message: 'Không kết nối được cơ sở dữ liệu, vui lòng thử lại.' };
(async () => {
  const quiet = console.error; console.error = () => {};
  try {
    await assert.rejects(db.saveOrder({ name: 'Minh Anh', dishes: ['Cá basa kho tộ'] }), unavailable);
    assert.equal(global._mongoClientPromise, null, 'Failed connection is not cached');
    await assert.rejects(db.getStateForDate(), unavailable);
    await assert.rejects(db.savePerson({ id: 'u1', name: 'Minh Anh' }), unavailable);
    await assert.rejects(db.getRatings('u1'), unavailable);
    await assert.rejects(db.saveRating({ userId: 'u1', dish: 'Cá basa kho tộ', stars: 5 }), unavailable);
    const after = fs.existsSync(storeFile) ? fs.readFileSync(storeFile, 'utf8') : null;
    assert.equal(after, before, 'store.json untouched while Mongo is configured');
  } finally { console.error = quiet; }
  console.log('PASS: Mongo outage surfaces an error, retries next call, never writes store.json.');
})().catch(err => { console.error(err); process.exit(1); });
