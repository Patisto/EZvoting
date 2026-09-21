const express = require('express');
const bcrypt = require('bcryptjs');
const { query, tx } = require('../db');
const { authenticate, requireSuper } = require('../auth');
const {
  HttpError, asyncHandler, slugify, cleanText, optionalText, parseId,
  cleanUsername, cleanPassword, adminElection, publicUser,
} = require('../util');

const router = express.Router();
router.use(authenticate, requireSuper);

// ─── Elections ───────────────────────────────────────────────

const ELECTIONS_SQL = `
  SELECT e.*,
         COALESCE(json_agg(json_build_object('id', u.id, 'name', u.name, 'username', u.username) ORDER BY u.name)
                  FILTER (WHERE u.id IS NOT NULL), '[]') AS facilitators
    FROM elections e
    LEFT JOIN election_facilitators ef ON ef.election_id = e.id
    LEFT JOIN users u ON u.id = ef.user_id
   %WHERE%
   GROUP BY e.id
   ORDER BY e.created_at DESC`;

async function fetchElections(db, id) {
  const sql = ELECTIONS_SQL.replace('%WHERE%', id ? 'WHERE e.id = $1' : '');
  const { rows } = await db.query(sql, id ? [id] : []);
  return rows.map((e) => ({ ...adminElection(e), facilitators: e.facilitators }));
}

async function validFacilitatorIds(db, ids) {
  if (ids === undefined || ids === null) return [];
  if (!Array.isArray(ids)) throw new HttpError(400, 'facilitator_ids must be a list.');
  const clean = [...new Set(ids.map((i) => parseId(i, 'facilitator id')))];
  if (!clean.length) return [];
  const { rows } = await db.query(
    "SELECT id FROM users WHERE id = ANY($1::bigint[]) AND role = 'facilitator'", [clean]);
  if (rows.length !== clean.length) throw new HttpError(400, 'One or more facilitators do not exist.');
  return clean;
}

router.get('/elections', asyncHandler(async (req, res) => {
  res.json({ elections: await fetchElections({ query }) });
}));

router.post('/elections', asyncHandler(async (req, res) => {
  const name = cleanText(req.body?.name, { max: 120, field: 'Election name' });
  const description = optionalText(req.body?.description, 500, 'Description');

  const id = await tx(async (c) => {
    const facilitatorIds = await validFacilitatorIds(c, req.body?.facilitator_ids);

    // Unique, readable slug: sas-awards-2026, sas-awards-2026-2, ...
    const base = slugify(name);
    let slug = base;
    for (let n = 2; ; n++) {
      const taken = await c.query('SELECT 1 FROM elections WHERE slug = $1', [slug]);
      if (!taken.rows[0]) break;
      slug = `${base}-${n}`;
    }

    const { rows } = await c.query(
      'INSERT INTO elections (slug, name, description, created_by) VALUES ($1, $2, $3, $4) RETURNING id',
      [slug, name, description, req.user.id]);
    for (const uid of facilitatorIds) {
      await c.query('INSERT INTO election_facilitators (election_id, user_id) VALUES ($1, $2)', [rows[0].id, uid]);
    }
    return rows[0].id;
  });

  const [election] = await fetchElections({ query }, id);
  res.status(201).json({ election });
}));

router.patch('/elections/:id', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const name = cleanText(req.body?.name, { max: 120, field: 'Election name' });
  const description = optionalText(req.body?.description, 500, 'Description');
  const { rowCount } = await query(
    'UPDATE elections SET name = $2, description = $3, updated_at = NOW() WHERE id = $1', [id, name, description]);
  if (!rowCount) throw new HttpError(404, 'Election not found.');
  const [election] = await fetchElections({ query }, id);
  res.json({ election });
}));

router.put('/elections/:id/facilitators', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  await tx(async (c) => {
    const exists = await c.query('SELECT 1 FROM elections WHERE id = $1 FOR UPDATE', [id]);
    if (!exists.rows[0]) throw new HttpError(404, 'Election not found.');
    const ids = await validFacilitatorIds(c, req.body?.facilitator_ids);
    await c.query('DELETE FROM election_facilitators WHERE election_id = $1', [id]);
    for (const uid of ids) {
      await c.query('INSERT INTO election_facilitators (election_id, user_id) VALUES ($1, $2)', [id, uid]);
    }
  });
  const [election] = await fetchElections({ query }, id);
  res.json({ election });
}));

router.delete('/elections/:id', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await query('SELECT name FROM elections WHERE id = $1', [id]);
  if (!rows[0]) throw new HttpError(404, 'Election not found.');
  if (req.body?.confirm_name !== rows[0].name) {
    throw new HttpError(400, 'Type the election name exactly to confirm deletion.');
  }
  await query('DELETE FROM elections WHERE id = $1', [id]); // cascades to everything under it
  res.json({ ok: true });
}));

// ─── Facilitators ────────────────────────────────────────────

async function fetchFacilitators(db, id) {
  const { rows } = await db.query(
    `SELECT u.id, u.username, u.name, u.role, u.is_active, u.created_at,
            COALESCE(json_agg(json_build_object('id', e.id, 'name', e.name) ORDER BY e.name)
                     FILTER (WHERE e.id IS NOT NULL), '[]') AS elections
       FROM users u
       LEFT JOIN election_facilitators ef ON ef.user_id = u.id
       LEFT JOIN elections e ON e.id = ef.election_id
      WHERE u.role = 'facilitator' ${id ? 'AND u.id = $1' : ''}
      GROUP BY u.id
      ORDER BY u.name`, id ? [id] : []);
  return rows.map((u) => ({ ...publicUser(u), created_at: u.created_at, elections: u.elections }));
}

router.get('/facilitators', asyncHandler(async (req, res) => {
  res.json({ facilitators: await fetchFacilitators({ query }) });
}));

router.post('/facilitators', asyncHandler(async (req, res) => {
  const name = cleanText(req.body?.name, { max: 80, field: 'Name' });
  const username = cleanUsername(req.body?.username);
  const password = cleanPassword(req.body?.password);
  const hash = await bcrypt.hash(password, 12);

  const id = await tx(async (c) => {
    const taken = await c.query('SELECT 1 FROM users WHERE LOWER(username) = $1', [username]);
    if (taken.rows[0]) throw new HttpError(409, 'That username is already taken.');

    let electionIds = [];
    if (Array.isArray(req.body?.election_ids) && req.body.election_ids.length) {
      electionIds = [...new Set(req.body.election_ids.map((i) => parseId(i, 'election id')))];
      const found = await c.query('SELECT id FROM elections WHERE id = ANY($1::bigint[])', [electionIds]);
      if (found.rows.length !== electionIds.length) throw new HttpError(400, 'One or more elections do not exist.');
    }

    const { rows } = await c.query(
      "INSERT INTO users (username, name, password_hash, role) VALUES ($1, $2, $3, 'facilitator') RETURNING id",
      [username, name, hash]);
    for (const eid of electionIds) {
      await c.query('INSERT INTO election_facilitators (election_id, user_id) VALUES ($1, $2)', [eid, rows[0].id]);
    }
    return rows[0].id;
  });

  const [facilitator] = await fetchFacilitators({ query }, id);
  res.status(201).json({ facilitator });
}));

router.patch('/facilitators/:id', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const { rows } = await query("SELECT id FROM users WHERE id = $1 AND role = 'facilitator'", [id]);
  if (!rows[0]) throw new HttpError(404, 'Facilitator not found.');

  if (req.body?.name !== undefined) {
    await query('UPDATE users SET name = $2 WHERE id = $1', [id, cleanText(req.body.name, { max: 80, field: 'Name' })]);
  }
  if (req.body?.password !== undefined) {
    const hash = await bcrypt.hash(cleanPassword(req.body.password), 12);
    await query('UPDATE users SET password_hash = $2 WHERE id = $1', [id, hash]);
  }
  if (req.body?.is_active !== undefined) {
    await query('UPDATE users SET is_active = $2 WHERE id = $1', [id, !!req.body.is_active]);
  }
  const [facilitator] = await fetchFacilitators({ query }, id);
  res.json({ facilitator });
}));

router.delete('/facilitators/:id', asyncHandler(async (req, res) => {
  const id = parseId(req.params.id);
  const { rowCount } = await query("DELETE FROM users WHERE id = $1 AND role = 'facilitator'", [id]);
  if (!rowCount) throw new HttpError(404, 'Facilitator not found.');
  res.json({ ok: true });
}));

module.exports = router;
