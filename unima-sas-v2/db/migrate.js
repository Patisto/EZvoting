require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(sql);
}

module.exports = { migrate };

if (require.main === module) {
  migrate()
    .then(() => { console.log('Schema is up to date.'); return pool.end(); })
    .catch((err) => { console.error('Migration failed:', err.message); process.exit(1); });
}
