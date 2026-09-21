const { Pool, types } = require('pg');

// BIGINT (oid 20) comes back as a string by default; ids here never exceed 2^53.
types.setTypeParser(20, (v) => parseInt(v, 10));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
  idleTimeoutMillis: 30000,       // release idle connections before Neon suspends the compute
  connectionTimeoutMillis: 15000, // first query after scale-to-zero can take a few seconds
  keepAlive: true,
});

// Neon can drop idle connections; without this handler that would crash the process.
pool.on('error', (err) => console.error('[pg] idle client error:', err.message));

const query = (text, params) => pool.query(text, params);

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, tx };
