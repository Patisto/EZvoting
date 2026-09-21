const bcrypt = require('bcryptjs');
const { query } = require('./db');

// Creates the super account from env vars on first boot (only if no super admin exists yet).
async function ensureSuperAdmin() {
  const { rows } = await query("SELECT 1 FROM users WHERE role = 'super_admin' LIMIT 1");
  if (rows[0]) return;

  const username = (process.env.SUPER_ADMIN_USERNAME || '').trim().toLowerCase();
  const password = process.env.SUPER_ADMIN_PASSWORD || '';
  if (!username || password.length < 8) {
    console.warn('[bootstrap] No super admin exists. Set SUPER_ADMIN_USERNAME and SUPER_ADMIN_PASSWORD (8+ chars), or run `npm run create-super`.');
    return;
  }
  await query(
    "INSERT INTO users (username, name, password_hash, role) VALUES ($1, $2, $3, 'super_admin')",
    [username, process.env.SUPER_ADMIN_NAME || 'Super Admin', await bcrypt.hash(password, 12)]);
  console.log(`[bootstrap] Created super admin "${username}".`);
}

module.exports = { ensureSuperAdmin };
