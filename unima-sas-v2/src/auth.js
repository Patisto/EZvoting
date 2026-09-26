const jwt = require('jsonwebtoken');
const { query } = require('./db');
const { HttpError, asyncHandler, parseId } = require('./util');

function secret() {
  return process.env.JWT_SECRET;
}

// Voter tokens use a different signing key, so a voter token can never pass as a staff token (or vice versa).
const voterSecret = () => process.env.JWT_SECRET + ':voter';

function signVoterToken(voter) {
  return jwt.sign({ sub: voter.id, eid: voter.election_id }, voterSecret(), { expiresIn: '4h' });
}

const authenticateVoter = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new HttpError(401, 'Please log in.');

  let payload;
  try {
    payload = jwt.verify(token, voterSecret());
  } catch (_) {
    throw new HttpError(401, 'Session expired. Please log in again.');
  }
  const { rows } = await query(
    'SELECT id, election_id, reg_number, status, has_voted, runoff_has_voted FROM voters WHERE id = $1', [payload.sub]);
  if (!rows[0]) throw new HttpError(401, 'Please log in again.');
  req.voter = rows[0];
  next();
});

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, secret(), { expiresIn: '12h' });
}

// Verifies the bearer token and re-loads the user, so deactivating an account takes effect immediately.
const authenticate = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) throw new HttpError(401, 'Please log in.');

  let payload;
  try {
    payload = jwt.verify(token, secret());
  } catch (_) {
    throw new HttpError(401, 'Session expired. Please log in again.');
  }

  const { rows } = await query('SELECT id, username, name, role, is_active FROM users WHERE id = $1', [payload.sub]);
  const user = rows[0];
  if (!user || !user.is_active) throw new HttpError(401, 'This account is not active.');
  req.user = user;
  next();
});

function requireSuper(req, res, next) {
  if (req.user.role !== 'super_admin') return next(new HttpError(403, 'Super admin access required.'));
  next();
}

// For /elections/:id/* routes: super admin, or a facilitator assigned to that election.
const requireElectionAccess = asyncHandler(async (req, res, next) => {
  const id = parseId(req.params.id, 'election id');
  const { rows } = await query('SELECT * FROM elections WHERE id = $1', [id]);
  const election = rows[0];
  if (!election) throw new HttpError(404, 'Election not found.');

  if (req.user.role !== 'super_admin') {
    const a = await query('SELECT 1 FROM election_facilitators WHERE election_id = $1 AND user_id = $2', [id, req.user.id]);
    if (!a.rows[0]) throw new HttpError(403, 'You are not assigned to this election.');
  }
  req.election = election;
  next();
});

module.exports = { signToken, authenticate, requireSuper, requireElectionAccess, signVoterToken, authenticateVoter };
