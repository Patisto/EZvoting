const express = require('express');
const { query, tx } = require('../db');
const { authenticate, requireElectionAccess } = require('../auth');
const { loadStructure, loadCandidates, buildResults, nominationSummary } = require('../services');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const {
  HttpError, asyncHandler, cleanText, parseId, cleanUrl, adminElection,
  NOMINATIONS_ENABLED, normalizeReg,
} = require('../util');

const router = express.Router();
router.use(authenticate);

// Elections this user can manage (all of them for the super admin).
router.get('/elections', asyncHandler(async (req, res) => {
  const { rows } = req.user.role === 'super_admin'
    ? await query('SELECT * FROM elections ORDER BY created_at DESC')
    : await query(
      `SELECT e.* FROM elections e
         JOIN election_facilitators ef ON ef.election_id = e.id
        WHERE ef.user_id = $1 ORDER BY e.created_at DESC`, [req.user.id]);
  res.json({ elections: rows.map(adminElection) });
}));

const el = express.Router({ mergeParams: true });
router.use('/elections/:id', requireElectionAccess, el);

async function lockElection(c, id) {
  const { rows } = await c.query('SELECT * FROM elections WHERE id = $1 FOR UPDATE', [id]);
  return rows[0];
}

async function count(c, sql, params) {
  const { rows } = await c.query(sql, params);
  return rows[0].n;
}

// ─── Overview ────────────────────────────────────────────────

el.get('/', asyncHandler(async (req, res) => {
  const id = req.election.id;
  const [structure, candidates, counts] = await Promise.all([
    loadStructure({ query }, id),
    loadCandidates({ query }, id),
    query(
      `SELECT (SELECT COUNT(*) FROM nomination_submissions WHERE election_id = $1)::int AS submissions,
              (SELECT COUNT(*) FROM nominations WHERE election_id = $1)::int AS nominations,
              (SELECT COUNT(*) FROM ballots WHERE election_id = $1)::int AS ballots,
              (SELECT COUNT(*) FROM voters WHERE election_id = $1)::int AS voters,
              (SELECT COUNT(*) FROM voters WHERE election_id = $1 AND status = 'approved')::int AS voters_approved,
              (SELECT COUNT(*) FROM voters WHERE election_id = $1 AND status = 'pending')::int AS voters_pending,
              (SELECT COUNT(*) FROM voters WHERE election_id = $1 AND status = 'rejected')::int AS voters_rejected`, [id]),
  ]);
  res.json({ election: adminElection(req.election), ...structure, candidates, counts: counts.rows[0] });
}));

el.patch('/settings', asyncHandler(async (req, res) => {
  if (typeof req.body?.public_nominations !== 'boolean') throw new HttpError(400, 'public_nominations must be true or false.');
  const { rows } = await query(
    'UPDATE elections SET public_nominations = $2, updated_at = NOW() WHERE id = $1 RETURNING *',
    [req.election.id, req.body.public_nominations]);
  res.json({ election: adminElection(rows[0]) });
}));

// ─── Phase controls ──────────────────────────────────────────

el.post('/nominations/state', asyncHandler(async (req, res) => {
  const state = req.body?.state;
  if (state !== 'open' && state !== 'closed') throw new HttpError(400, 'state must be "open" or "closed".');

  const election = await tx(async (c) => {
    const cur = await lockElection(c, req.election.id);
    if (state === 'open') {
      if (!NOMINATIONS_ENABLED) throw new HttpError(409, 'Open nominations are switched off for now. Enter the successful candidates directly in the Candidates tab.');
      if (cur.voting_state !== 'pending') throw new HttpError(409, 'Nominations cannot be opened once voting has started.');
      if (cur.nominations_state === 'open') return cur;
      if (!(await count(c, 'SELECT COUNT(*)::int AS n FROM positions WHERE election_id = $1', [cur.id]))) {
        throw new HttpError(409, 'Add at least one position (Setup tab) before opening nominations.');
      }
    } else if (cur.nominations_state !== 'open') {
      throw new HttpError(409, 'Nominations are not open.');
    }
    const { rows } = await c.query(
      'UPDATE elections SET nominations_state = $2, updated_at = NOW() WHERE id = $1 RETURNING *', [cur.id, state]);
    return rows[0];
  });
  res.json({ election: adminElection(election) });
}));

el.post('/registration/state', asyncHandler(async (req, res) => {
  const state = req.body?.state;
  if (state !== 'open' && state !== 'closed') throw new HttpError(400, 'state must be "open" or "closed".');

  const election = await tx(async (c) => {
    const cur = await lockElection(c, req.election.id);
    if (state === 'open') {
      if (cur.voting_state !== 'pending') throw new HttpError(409, 'Registration cannot be reopened once voting has started.');
      if (cur.registration_state === 'open') return cur;
    } else if (cur.registration_state !== 'open') {
      throw new HttpError(409, 'Registration is not open.');
    }
    const { rows } = await c.query(
      'UPDATE elections SET registration_state = $2, updated_at = NOW() WHERE id = $1 RETURNING *', [cur.id, state]);
    return rows[0];
  });
  res.json({ election: adminElection(election) });
}));

el.post('/voting/state', asyncHandler(async (req, res) => {
  const state = req.body?.state;
  if (state !== 'open' && state !== 'closed') throw new HttpError(400, 'state must be "open" or "closed".');

  const election = await tx(async (c) => {
    const cur = await lockElection(c, req.election.id);
    if (state === 'open') {
      if (cur.voting_state === 'open') return cur;
      if (cur.nominations_state === 'open') throw new HttpError(409, 'Close nominations before opening voting.');
      if (cur.registration_state === 'open') throw new HttpError(409, 'Close registration before opening voting, so the voter list is final.');
      if (!(await count(c, "SELECT COUNT(*)::int AS n FROM voters WHERE election_id = $1 AND status = 'approved'", [cur.id]))) {
        throw new HttpError(409, 'Approve at least one voter (Voters tab) before opening voting.');
      }
      if (!(await count(c, 'SELECT COUNT(*)::int AS n FROM candidates WHERE election_id = $1', [cur.id]))) {
        throw new HttpError(409, 'Add at least one candidate (Candidates tab) before opening voting.');
      }
      const { rows } = await c.query(
        `UPDATE elections SET voting_state = 'open', results_released = FALSE, updated_at = NOW()
          WHERE id = $1 RETURNING *`, [cur.id]);
      return rows[0];
    }
    if (cur.voting_state !== 'open') throw new HttpError(409, 'Voting is not open.');
    const { rows } = await c.query(
      "UPDATE elections SET voting_state = 'closed', updated_at = NOW() WHERE id = $1 RETURNING *", [cur.id]);
    return rows[0];
  });
  res.json({ election: adminElection(election) });
}));

el.post('/results/release', asyncHandler(async (req, res) => {
  if (typeof req.body?.released !== 'boolean') throw new HttpError(400, 'released must be true or false.');
  const election = await tx(async (c) => {
    const cur = await lockElection(c, req.election.id);
    if (req.body.released && cur.voting_state !== 'closed') {
      throw new HttpError(409, 'Close voting before releasing results.');
    }
    const { rows } = await c.query(
      'UPDATE elections SET results_released = $2, updated_at = NOW() WHERE id = $1 RETURNING *',
      [cur.id, req.body.released]);
    return rows[0];
  });
  res.json({ election: adminElection(election) });
}));

// ─── Voting profile: groups & positions ──────────────────────

// Replace-in-place list sync. Items with an id are renamed/reordered; items without one are added;
// anything missing from the list is removed. Adding/removing is only allowed when `allowStructure`.
async function syncItems(c, { table, col, electionId, items, allowStructure, lockedMessage }) {
  const existing = (await c.query(`SELECT id FROM ${table} WHERE election_id = $1`, [electionId])).rows;
  const existingIds = new Set(existing.map((r) => r.id));

  for (const it of items) {
    if (it.id && !existingIds.has(it.id)) throw new HttpError(400, 'Unknown item in list.');
  }
  const keep = new Set(items.filter((i) => i.id).map((i) => i.id));
  const removed = existing.filter((r) => !keep.has(r.id));
  const added = items.filter((i) => !i.id);

  if ((removed.length || added.length) && !allowStructure) throw new HttpError(409, lockedMessage);

  if (removed.length) {
    await c.query(`DELETE FROM ${table} WHERE election_id = $1 AND id = ANY($2::bigint[])`,
      [electionId, removed.map((r) => r.id)]);
  }
  let order = 0;
  for (const it of items) {
    if (it.id) {
      await c.query(`UPDATE ${table} SET ${col} = $1, sort_order = $2 WHERE id = $3 AND election_id = $4`,
        [it.label, order, it.id, electionId]);
    } else {
      await c.query(`INSERT INTO ${table} (election_id, ${col}, sort_order) VALUES ($1, $2, $3)`,
        [electionId, it.label, order]);
    }
    order++;
  }
}

function parseItems(list, { labelKey, max, field }) {
  if (!Array.isArray(list)) throw new HttpError(400, `${field} must be a list.`);
  if (list.length > max) throw new HttpError(400, `At most ${max} items allowed.`);
  const seen = new Set();
  return list.map((raw) => {
    const label = cleanText(raw?.[labelKey], { max: 80, field });
    const key = label.toLowerCase();
    if (seen.has(key)) throw new HttpError(400, `Duplicate entry: "${label}".`);
    seen.add(key);
    return { id: raw?.id ? parseId(raw.id) : null, label };
  });
}

el.put('/groups', asyncHandler(async (req, res) => {
  const items = parseItems(req.body?.groups, { labelKey: 'label', max: 12, field: 'Group name' });
  await tx(async (c) => {
    const cur = await lockElection(c, req.election.id);
    await syncItems(c, {
      table: 'election_groups', col: 'label', electionId: cur.id, items,
      allowStructure: cur.nominations_state === 'pending' && cur.voting_state === 'pending',
      lockedMessage: 'Groups can only be added or removed before nominations open. You can still rename them.',
    });
  });
  res.json({ ...(await loadStructure({ query }, req.election.id)) });
}));

el.put('/positions', asyncHandler(async (req, res) => {
  const items = parseItems(req.body?.positions, { labelKey: 'title', max: 60, field: 'Position title' });
  await tx(async (c) => {
    const cur = await lockElection(c, req.election.id);
    await syncItems(c, {
      table: 'positions', col: 'title', electionId: cur.id, items,
      allowStructure: cur.voting_state === 'pending',
      lockedMessage: 'Positions can only be added or removed before voting opens. You can still rename and reorder them.',
    });
  });
  res.json({ ...(await loadStructure({ query }, req.election.id)) });
}));

// ─── Nominations ─────────────────────────────────────────────

el.get('/nominations', asyncHandler(async (req, res) => {
  res.json({ summary: await nominationSummary({ query }, req.election.id) });
}));

// ─── Candidates ──────────────────────────────────────────────

// Validates slot + duplicate rules and inserts one candidate. `cur` is the locked election row.
async function insertCandidate(c, cur, { positionId, groupId, name, photo }) {
  const pos = await c.query('SELECT 1 FROM positions WHERE id = $1 AND election_id = $2', [positionId, cur.id]);
  if (!pos.rows[0]) throw new HttpError(400, 'Unknown position.');

  const groupCount = await count(c, 'SELECT COUNT(*)::int AS n FROM election_groups WHERE election_id = $1', [cur.id]);
  if (groupCount) {
    if (!groupId) throw new HttpError(400, 'Choose a group for this candidate.');
    const g = await c.query('SELECT 1 FROM election_groups WHERE id = $1 AND election_id = $2', [groupId, cur.id]);
    if (!g.rows[0]) throw new HttpError(400, 'Unknown group.');
  } else if (groupId) {
    throw new HttpError(400, 'This election has no groups.');
  }

  const dupe = await c.query(
    `SELECT 1 FROM candidates WHERE election_id = $1 AND position_id = $2
        AND group_id IS NOT DISTINCT FROM $3 AND LOWER(name) = LOWER($4)`,
    [cur.id, positionId, groupId, name]);
  if (dupe.rows[0]) throw new HttpError(409, `${name} is already a candidate for this position.`);

  const { rows } = await c.query(
    `INSERT INTO candidates (election_id, position_id, group_id, name, photo_url)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, position_id, group_id, name, photo_url`,
    [cur.id, positionId, groupId, name, photo]);
  return rows[0];
}

el.post('/candidates', asyncHandler(async (req, res) => {
  const name = cleanText(req.body?.name, { max: 80, field: 'Candidate name' });
  const photo = cleanUrl(req.body?.photo_url);
  const positionId = parseId(req.body?.position_id, 'position');
  const groupId = req.body?.group_id ? parseId(req.body.group_id, 'group') : null;

  const candidate = await tx(async (c) => {
    const cur = await lockElection(c, req.election.id);
    if (cur.voting_state !== 'pending') throw new HttpError(409, 'Candidates are locked once voting has opened.');
    return insertCandidate(c, cur, { positionId, groupId, name, photo });
  });
  res.status(201).json({ candidate });
}));

// Several candidates for one position/group in one go. All-or-nothing: one bad line adds nobody.
el.post('/candidates/bulk', asyncHandler(async (req, res) => {
  const positionId = parseId(req.body?.position_id, 'position');
  const groupId = req.body?.group_id ? parseId(req.body.group_id, 'group') : null;
  const list = req.body?.candidates;
  if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'Enter at least one candidate.');
  if (list.length > 100) throw new HttpError(400, 'At most 100 candidates at a time.');

  const items = list.map((raw) => ({
    name: cleanText(raw?.name, { max: 80, field: 'Candidate name' }),
    photo: cleanUrl(raw?.photo_url),
  }));
  const names = new Set();
  for (const it of items) {
    const k = it.name.toLowerCase();
    if (names.has(k)) throw new HttpError(400, `"${it.name}" appears twice in your list.`);
    names.add(k);
  }

  const candidates = await tx(async (c) => {
    const cur = await lockElection(c, req.election.id);
    if (cur.voting_state !== 'pending') throw new HttpError(409, 'Candidates are locked once voting has opened.');
    const out = [];
    for (const it of items) out.push(await insertCandidate(c, cur, { positionId, groupId, name: it.name, photo: it.photo }));
    return out;
  });
  res.status(201).json({ candidates });
}));

// Fixing a typo or swapping a photo is always allowed.
el.patch('/candidates/:cid', asyncHandler(async (req, res) => {
  const cid = parseId(req.params.cid, 'candidate');
  const name = cleanText(req.body?.name, { max: 80, field: 'Candidate name' });
  const photo = cleanUrl(req.body?.photo_url);
  const { rows } = await query(
    `UPDATE candidates SET name = $3, photo_url = $4 WHERE id = $1 AND election_id = $2
     RETURNING id, position_id, group_id, name, photo_url`, [cid, req.election.id, name, photo]);
  if (!rows[0]) throw new HttpError(404, 'Candidate not found.');
  res.json({ candidate: rows[0] });
}));

el.delete('/candidates/:cid', asyncHandler(async (req, res) => {
  const cid = parseId(req.params.cid, 'candidate');
  await tx(async (c) => {
    const cur = await lockElection(c, req.election.id);
    if (cur.voting_state !== 'pending') throw new HttpError(409, 'Candidates are locked once voting has opened.');
    const { rowCount } = await c.query('DELETE FROM candidates WHERE id = $1 AND election_id = $2', [cid, cur.id]);
    if (!rowCount) throw new HttpError(404, 'Candidate not found.');
  });
  res.json({ ok: true });
}));

// ─── Voters ──────────────────────────────────────────────────

const VOTER_COLS = 'id, reg_number, status, has_voted, created_at';
const PW_CHARS = 'abcdefghjkmnpqrstuvwxyz23456789';

function assertVoterListOpen(election) {
  if (election.voting_state === 'closed') throw new HttpError(409, 'Voting has closed, so the voter list is locked.');
}

el.get('/voters', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT ${VOTER_COLS} FROM voters WHERE election_id = $1 ORDER BY reg_number`, [req.election.id]);
  res.json({ voters: rows });
}));

el.patch('/voters/:vid', asyncHandler(async (req, res) => {
  assertVoterListOpen(req.election);
  const vid = parseId(req.params.vid, 'voter');
  const status = req.body?.status;
  if (status !== 'approved' && status !== 'rejected') throw new HttpError(400, 'status must be "approved" or "rejected".');

  const { rows } = await query(
    `UPDATE voters SET status = $3::text
      WHERE id = $1 AND election_id = $2 AND NOT ($3::text = 'rejected' AND has_voted)
      RETURNING ${VOTER_COLS}`, [vid, req.election.id, status]);
  if (!rows[0]) {
    const exists = await query('SELECT has_voted FROM voters WHERE id = $1 AND election_id = $2', [vid, req.election.id]);
    if (exists.rows[0]?.has_voted) throw new HttpError(409, 'This voter has already voted, so they cannot be rejected.');
    throw new HttpError(404, 'Voter not found.');
  }
  res.json({ voter: rows[0] });
}));

// scope "all_pending" approves everyone still waiting; scope "list" acts on the reg numbers you send.
el.post('/voters/bulk', asyncHandler(async (req, res) => {
  assertVoterListOpen(req.election);
  const action = req.body?.action;
  const scope = req.body?.scope;
  if (action !== 'approve' && action !== 'reject') throw new HttpError(400, 'action must be "approve" or "reject".');
  const status = action === 'approve' ? 'approved' : 'rejected';
  const id = req.election.id;

  if (scope === 'all_pending') {
    if (action !== 'approve') throw new HttpError(400, 'Only approving works on all pending voters.');
    const r = await query("UPDATE voters SET status = 'approved' WHERE election_id = $1 AND status = 'pending'", [id]);
    return res.json({ updated: r.rowCount, not_found: [], skipped_voted: [] });
  }
  if (scope !== 'list') throw new HttpError(400, 'scope must be "all_pending" or "list".');

  const raw = req.body?.reg_numbers;
  if (!Array.isArray(raw) || !raw.length) throw new HttpError(400, 'Paste at least one registration number.');
  if (raw.length > 20000) throw new HttpError(400, 'Too many registration numbers at once.');
  const regs = [...new Set(raw.map((r) => normalizeReg(r).slice(0, 40)).filter(Boolean))];

  const found = await query(
    'SELECT reg_number, has_voted FROM voters WHERE election_id = $1 AND reg_number = ANY($2::text[])', [id, regs]);
  const foundSet = new Set(found.rows.map((r) => r.reg_number));
  const votedSet = new Set(found.rows.filter((r) => r.has_voted).map((r) => r.reg_number));
  const targets = regs.filter((r) => foundSet.has(r) && !(action === 'reject' && votedSet.has(r)));

  let updated = 0;
  if (targets.length) {
    const r = await query(
      'UPDATE voters SET status = $3 WHERE election_id = $1 AND reg_number = ANY($2::text[])', [id, targets, status]);
    updated = r.rowCount;
  }
  res.json({
    updated,
    not_found: regs.filter((r) => !foundSet.has(r)),
    skipped_voted: action === 'reject' ? regs.filter((r) => votedSet.has(r)) : [],
  });
}));

// Forgotten password: generates a new one, shown once to the facilitator to pass on to the voter.
el.post('/voters/:vid/reset-password', asyncHandler(async (req, res) => {
  assertVoterListOpen(req.election);
  const vid = parseId(req.params.vid, 'voter');
  const bytes = crypto.randomBytes(8);
  const password = Array.from(bytes, (b) => PW_CHARS[b % PW_CHARS.length]).join('');
  const { rows } = await query(
    'UPDATE voters SET password_hash = $3 WHERE id = $1 AND election_id = $2 RETURNING reg_number',
    [vid, req.election.id, await bcrypt.hash(password, 10)]);
  if (!rows[0]) throw new HttpError(404, 'Voter not found.');
  res.json({ reg_number: rows[0].reg_number, password });
}));

// ─── Results & export ────────────────────────────────────────

el.get('/results', asyncHandler(async (req, res) => {
  res.json({ results: await buildResults({ query }, req.election.id) });
}));

el.get('/export', asyncHandler(async (req, res) => {
  const id = req.election.id;
  const [structure, results, summary, rawNoms, rawVotes] = await Promise.all([
    loadStructure({ query }, id),
    buildResults({ query }, id),
    nominationSummary({ query }, id),
    query('SELECT id, submission_id, position_id, group_id, nominee_name, created_at FROM nominations WHERE election_id = $1 ORDER BY id', [id]),
    query('SELECT id, ballot_id, position_id, group_id, candidate_id, created_at FROM votes WHERE election_id = $1 ORDER BY id', [id]),
  ]);
  res.json({
    exported_at: new Date().toISOString(),
    election: adminElection(req.election),
    ...structure,
    results,
    nomination_summary: summary,
    nominations: rawNoms.rows,
    votes: rawVotes.rows,
  });
}));

const { resultsPdf, votersPdf } = require('../pdf');

// Results PDF — one page per position, winner 🏆 / loser 🚲 next to the vote count.
el.get('/results/pdf', asyncHandler(async (req, res) => {
  const results = await buildResults({ query }, req.election.id);
  resultsPdf(res, req.election, results);
}));

// Registered voters PDF — full list with status and voted flag.
el.get('/voters/pdf', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT ${VOTER_COLS} FROM voters WHERE election_id = $1 ORDER BY reg_number`, [req.election.id]);
  votersPdf(res, req.election, rows);
}));

module.exports = router;
