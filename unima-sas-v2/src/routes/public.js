const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const { query, tx } = require('../db');
const { signVoterToken, authenticateVoter } = require('../auth');
const { loadStructure, loadCandidates, buildResults, nominationSummary } = require('../services');
const {
  HttpError, asyncHandler, cleanText, parseId, publicElection, isStarted,
  normalizeReg, cleanRegNumber, cleanVoterPassword, NOMINATIONS_ENABLED,
} = require('../util');

const router = express.Router();

// Campus Wi-Fi puts many students behind one IP, so this is deliberately generous: it only stops floods.
const writeLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.RATE_PUBLIC_WRITES_PER_MIN) || 240,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please wait a moment and try again.' },
});

// Register / log-in attempts. Also generous because of shared campus IPs.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.RATE_VOTER_AUTH_PER_15MIN) || 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' },
});

// Compared against when the reg number isn't registered, so response time doesn't reveal who registered.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
const BCRYPT_COST = 10;

const voterView = (v) => ({ reg_number: v.reg_number, status: v.status, has_voted: v.has_voted });

router.get('/config', (req, res) => {
  res.json({ brand: process.env.BRAND_NAME || 'Elections' });
});

// Elections that have started (drafts stay hidden).
async function findElection(db, slug, { lock } = {}) {
  const { rows } = await db.query(
    `SELECT * FROM elections WHERE slug = $1 ${lock ? 'FOR SHARE' : ''}`, [String(slug).slice(0, 100)]);
  const e = rows[0];
  if (!e || !isStarted(e)) {
    throw new HttpError(404, 'Election not found.');
  }
  return e;
}

router.get('/elections', asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM elections
      WHERE NOT (nominations_state = 'pending' AND voting_state = 'pending' AND registration_state = 'pending')
      ORDER BY updated_at DESC`);
  res.json({ elections: rows.map(publicElection) });
}));

router.get('/elections/:slug', asyncHandler(async (req, res) => {
  const e = await findElection({ query }, req.params.slug);
  const [structure, subs] = await Promise.all([
    loadStructure({ query }, e.id),
    query('SELECT COUNT(*)::int AS n FROM nomination_submissions WHERE election_id = $1', [e.id]),
  ]);
  const candidates = e.voting_state !== 'pending' ? await loadCandidates({ query }, e.id) : [];
  res.json({ election: publicElection(e), ...structure, candidates, submission_count: subs.rows[0].n });
}));

// ─── Nominations ─────────────────────────────────────────────

router.get('/elections/:slug/nominations', asyncHandler(async (req, res) => {
  if (!NOMINATIONS_ENABLED) throw new HttpError(403, 'Nominations are not handled here.');
  const e = await findElection({ query }, req.params.slug);
  if (!e.public_nominations || e.nominations_state === 'pending') {
    throw new HttpError(403, 'Nominations are not public for this election.');
  }
  res.json({ summary: await nominationSummary({ query }, e.id) });
}));

router.post('/elections/:slug/nominations', writeLimiter, asyncHandler(async (req, res) => {
  if (!NOMINATIONS_ENABLED) throw new HttpError(403, 'Nominations are not handled here.');
  const list = req.body?.nominations;
  if (!Array.isArray(list) || !list.length) throw new HttpError(400, 'Please fill in at least one name.');
  if (list.length > 200) throw new HttpError(400, 'Too many nominations in one submission.');

  const count = await tx(async (c) => {
    const e = await findElection(c, req.params.slug, { lock: true });
    if (e.nominations_state !== 'open') throw new HttpError(403, 'Nominations are not open.');

    const { groups, positions } = await loadStructure(c, e.id);
    const positionIds = new Set(positions.map((p) => p.id));
    const groupIds = new Set(groups.map((g) => g.id));

    const rows = list.map((n) => {
      const positionId = parseId(n?.position_id, 'position');
      const groupId = n?.group_id ? parseId(n.group_id, 'group') : null;
      if (!positionIds.has(positionId)) throw new HttpError(400, 'Unknown position.');
      if (groups.length ? !groupIds.has(groupId) : groupId !== null) throw new HttpError(400, 'Invalid group.');
      return { positionId, groupId, name: cleanText(n?.nominee_name, { min: 2, max: 80, field: 'Nominee name' }) };
    });

    const sub = await c.query('INSERT INTO nomination_submissions (election_id) VALUES ($1) RETURNING id', [e.id]);
    const values = [];
    const params = [e.id, sub.rows[0].id];
    rows.forEach((r, i) => {
      values.push(`($1, $2, $${i * 3 + 3}, $${i * 3 + 4}, $${i * 3 + 5})`);
      params.push(r.positionId, r.groupId, r.name);
    });
    await c.query(
      `INSERT INTO nominations (election_id, submission_id, position_id, group_id, nominee_name)
       VALUES ${values.join(', ')}`, params);

    const total = await c.query('SELECT COUNT(*)::int AS n FROM nomination_submissions WHERE election_id = $1', [e.id]);
    return total.rows[0].n;
  });

  res.status(201).json({ message: 'Nominations submitted.', submission_count: count });
}));

// ─── Voter registration & login ──────────────────────────────

router.post('/elections/:slug/register', authLimiter, asyncHandler(async (req, res) => {
  const reg = cleanRegNumber(req.body?.reg_number);
  const password = cleanVoterPassword(req.body?.password);
  const hash = await bcrypt.hash(password, BCRYPT_COST);

  await tx(async (c) => {
    // FOR SHARE: closing registration (which updates this row) waits for in-flight sign-ups to finish.
    const e = await findElection(c, req.params.slug, { lock: true });
    if (e.registration_state !== 'open') throw new HttpError(403, 'Registration is not open.');
    const r = await c.query(
      `INSERT INTO voters (election_id, reg_number, password_hash) VALUES ($1, $2, $3)
       ON CONFLICT (election_id, reg_number) DO NOTHING RETURNING id`, [e.id, reg, hash]);
    if (!r.rows[0]) {
      throw new HttpError(409, 'This registration number is already registered. Log in instead, or ask the elections committee to reset your password.');
    }
  });
  res.status(201).json({ message: 'Registered.', reg_number: reg });
}));

router.post('/elections/:slug/voter-login', authLimiter, asyncHandler(async (req, res) => {
  const e = await findElection({ query }, req.params.slug);
  const reg = normalizeReg(req.body?.reg_number).slice(0, 40);
  const password = String(req.body?.password || '').slice(0, 100);

  const { rows } = await query('SELECT * FROM voters WHERE election_id = $1 AND reg_number = $2', [e.id, reg]);
  const v = rows[0];
  const ok = await bcrypt.compare(password, v ? v.password_hash : DUMMY_HASH);
  if (!v || !ok) throw new HttpError(401, 'Incorrect registration number or password.');

  res.json({ token: signVoterToken(v), voter: voterView(v) });
}));

// Current status of the logged-in voter (approval / already voted).
router.get('/elections/:slug/me', authenticateVoter, asyncHandler(async (req, res) => {
  const e = await findElection({ query }, req.params.slug);
  if (req.voter.election_id !== e.id) throw new HttpError(401, 'Please log in again.');
  res.json({ voter: voterView(req.voter) });
}));

// ─── Voting ──────────────────────────────────────────────────

router.post('/elections/:slug/vote', writeLimiter, authenticateVoter, asyncHandler(async (req, res) => {
  const { votes } = req.body || {};
  if (!Array.isArray(votes) || !votes.length || votes.length > 500) throw new HttpError(400, 'Select at least one candidate.');

  await tx(async (c) => {
    // FOR SHARE: a facilitator closing voting (which updates this row) waits for in-flight ballots to finish.
    const e = await findElection(c, req.params.slug, { lock: true });
    if (req.voter.election_id !== e.id) throw new HttpError(403, 'This login belongs to a different election.');
    if (e.voting_state !== 'open') throw new HttpError(403, 'Voting is not open.');

    // Row lock on the voter: concurrent submits from the same voter run one after the other.
    const vr = await c.query('SELECT status, has_voted FROM voters WHERE id = $1 FOR UPDATE', [req.voter.id]);
    const voter = vr.rows[0];
    if (!voter || voter.status !== 'approved') {
      throw new HttpError(403, 'Your registration has not been approved, so you cannot vote.');
    }
    if (voter.has_voted) throw new HttpError(409, 'You have already voted.');

    const cands = await c.query('SELECT id, position_id, group_id FROM candidates WHERE election_id = $1', [e.id]);
    const byId = new Map(cands.rows.map((r) => [r.id, r]));

    const seen = new Set();
    const picks = votes.map((v) => {
      const positionId = parseId(v?.position_id, 'position');
      const groupId = v?.group_id ? parseId(v.group_id, 'group') : null;
      const candidateId = parseId(v?.candidate_id, 'candidate');
      const cand = byId.get(candidateId);
      if (!cand || cand.position_id !== positionId || (cand.group_id ?? null) !== groupId) {
        throw new HttpError(400, 'One of your selections is invalid. Please refresh and try again.');
      }
      const slot = `${positionId}:${groupId || 0}`;
      if (seen.has(slot)) throw new HttpError(400, 'Only one choice per category is allowed.');
      seen.add(slot);
      return { positionId, groupId, candidateId };
    });

    // The ballot is deliberately not linked to the voter, so votes stay secret.
    const ballot = await c.query(
      'INSERT INTO ballots (election_id, voter_token) VALUES ($1, $2) RETURNING id',
      [e.id, 'b_' + crypto.randomBytes(16).toString('hex')]);

    const values = [];
    const params = [ballot.rows[0].id, e.id];
    picks.forEach((p, i) => {
      values.push(`($1, $2, $${i * 3 + 3}, $${i * 3 + 4}, $${i * 3 + 5})`);
      params.push(p.positionId, p.groupId, p.candidateId);
    });
    await c.query(
      `INSERT INTO votes (ballot_id, election_id, position_id, group_id, candidate_id)
       VALUES ${values.join(', ')}`, params);
    await c.query('UPDATE voters SET has_voted = TRUE WHERE id = $1', [req.voter.id]);
  });

  res.status(201).json({ message: 'Vote recorded.' });
}));

// ─── Results ─────────────────────────────────────────────────

router.get('/elections/:slug/results', asyncHandler(async (req, res) => {
  const e = await findElection({ query }, req.params.slug);
  if (!e.results_released) return res.json({ released: false });
  res.json({ released: true, results: await buildResults({ query }, e.id) });
}));

module.exports = router;
