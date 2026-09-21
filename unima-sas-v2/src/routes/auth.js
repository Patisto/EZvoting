const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { query } = require('../db');
const { signToken, authenticate } = require('../auth');
const { HttpError, asyncHandler, cleanPassword, publicUser } = require('../util');

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in a few minutes.' },
});

// Compared against when the username doesn't exist, so response time doesn't reveal valid usernames.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

router.post('/login', loginLimiter, asyncHandler(async (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase();
  const password = String(req.body?.password || '').slice(0, 200);

  const { rows } = await query('SELECT * FROM users WHERE LOWER(username) = $1', [username]);
  const user = rows[0];
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok || !user.is_active) throw new HttpError(401, 'Incorrect username or password.');

  res.json({ token: signToken(user), user: publicUser(user) });
}));

router.get('/me', authenticate, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

router.post('/change-password', authenticate, asyncHandler(async (req, res) => {
  const current = String(req.body?.current_password || '');
  const next = cleanPassword(req.body?.new_password);

  const { rows } = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.id]);
  if (!(await bcrypt.compare(current, rows[0].password_hash))) {
    throw new HttpError(400, 'Current password is incorrect.');
  }
  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.id, await bcrypt.hash(next, 12)]);
  res.json({ ok: true });
}));

module.exports = router;
