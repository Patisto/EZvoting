// Create the super account, or reset its password:
//   npm run create-super -- <username> <password> ["Full Name"]
require('dotenv').config();
const bcrypt = require('bcryptjs');
const { pool } = require('../src/db');
const { migrate } = require('./migrate');

async function main() {
  const [username, password, name] = process.argv.slice(2);
  if (!username || !password || password.length < 8) {
    console.error('Usage: npm run create-super -- <username> <password (8+ chars)> ["Full Name"]');
    process.exit(1);
  }
  await migrate();
  const hash = await bcrypt.hash(password, 12);
  const { rows } = await pool.query('SELECT id FROM users WHERE LOWER(username) = LOWER($1)', [username]);
  if (rows[0]) {
    await pool.query(
      "UPDATE users SET password_hash = $2, role = 'super_admin', is_active = TRUE WHERE id = $1",
      [rows[0].id, hash]
    );
    console.log(`Updated ${username} (password reset, role super_admin).`);
  } else {
    await pool.query(
      "INSERT INTO users (username, name, password_hash, role) VALUES ($1, $2, $3, 'super_admin')",
      [username.toLowerCase(), name || 'Super Admin', hash]
    );
    console.log(`Created super account "${username}".`);
  }
  await pool.end();
}

main().catch((err) => { console.error(err.message); process.exit(1); });
