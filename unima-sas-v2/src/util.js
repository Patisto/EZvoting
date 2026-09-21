class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function slugify(input) {
  return String(input)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'election';
}

// Trim, collapse whitespace, enforce length.
function cleanText(value, { min = 1, max = 200, field = 'Value' } = {}) {
  if (typeof value !== 'string') throw new HttpError(400, `${field} is required.`);
  const s = value.replace(/\s+/g, ' ').trim();
  if (s.length < min) throw new HttpError(400, min <= 1 ? `${field} is required.` : `${field} must be at least ${min} characters.`);
  if (s.length > max) throw new HttpError(400, `${field} must be at most ${max} characters.`);
  return s;
}

function optionalText(value, max, field) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return cleanText(String(value), { max, field });
}

function parseId(value, field = 'id') {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${field}.`);
  return n;
}

function cleanUrl(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const s = String(value).trim();
  if (s.length > 500) throw new HttpError(400, 'Photo URL is too long.');
  let u;
  try { u = new URL(s); } catch (_) { throw new HttpError(400, 'Photo URL must be a valid http(s) link.'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new HttpError(400, 'Photo URL must be a valid http(s) link.');
  return s;
}

function cleanUsername(value) {
  const s = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(s)) {
    throw new HttpError(400, 'Username must be 3-32 characters: letters, numbers, dot, dash or underscore.');
  }
  return s;
}

function cleanPassword(value) {
  const s = String(value || '');
  if (s.length < 8) throw new HttpError(400, 'Password must be at least 8 characters.');
  if (s.length > 100) throw new HttpError(400, 'Password is too long.');
  return s;
}

// Nominations are handled outside the system for now. Set ENABLE_NOMINATIONS=true to bring the old flow back.
const NOMINATIONS_ENABLED = process.env.ENABLE_NOMINATIONS === 'true';

// Registration number: letters, digits and / . _ - (spaces removed, upper-cased).
function normalizeReg(value) {
  return String(value ?? '').replace(/\s+/g, '').toUpperCase();
}

function cleanRegNumber(value) {
  const s = normalizeReg(value);
  if (!/^[A-Z0-9][A-Z0-9/._-]{2,29}$/.test(s)) {
    throw new HttpError(400, 'Enter a valid registration number (letters, numbers, / . - _ only).');
  }
  return s;
}

function cleanVoterPassword(value) {
  const s = String(value || '');
  if (s.length < 6) throw new HttpError(400, 'Password must be at least 6 characters.');
  if (s.length > 72) throw new HttpError(400, 'Password must be at most 72 characters.');
  return s;
}

// True once anything has been switched on (drafts stay hidden from the public).
function isStarted(e) {
  return !(e.nominations_state === 'pending' && e.voting_state === 'pending' && e.registration_state === 'pending');
}

// Where an election currently is, in one word (used by the public pages).
function phaseOf(e) {
  if (e.results_released) return 'results';
  if (e.voting_state === 'open') return 'voting';
  if (e.voting_state === 'closed') return 'voting_closed';
  if (e.registration_state === 'open') return 'registration';
  if (e.nominations_state === 'open') return 'nominations';
  if (e.registration_state === 'closed') return 'registration_closed';
  if (e.nominations_state === 'closed') return 'nominations_closed';
  return 'draft';
}

function publicElection(e) {
  return {
    slug: e.slug,
    name: e.name,
    description: e.description,
    nominations_state: e.nominations_state,
    registration_state: e.registration_state,
    voting_state: e.voting_state,
    results_released: e.results_released,
    public_nominations: e.public_nominations,
    phase: phaseOf(e),
  };
}

function adminElection(e) {
  return {
    id: e.id,
    slug: e.slug,
    name: e.name,
    description: e.description,
    nominations_state: e.nominations_state,
    registration_state: e.registration_state,
    voting_state: e.voting_state,
    results_released: e.results_released,
    public_nominations: e.public_nominations,
    nominations_enabled: NOMINATIONS_ENABLED,
    phase: phaseOf(e),
    created_at: e.created_at,
  };
}

function publicUser(u) {
  return { id: u.id, username: u.username, name: u.name, role: u.role, is_active: u.is_active };
}

module.exports = {
  HttpError, asyncHandler, slugify, cleanText, optionalText, parseId, cleanUrl,
  cleanUsername, cleanPassword, phaseOf, publicElection, adminElection, publicUser,
  NOMINATIONS_ENABLED, normalizeReg, cleanRegNumber, cleanVoterPassword, isStarted,
};
