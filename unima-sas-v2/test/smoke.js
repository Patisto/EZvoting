// End-to-end API smoke test. Run the server first, then:
//   BASE=http://localhost:3000 SUPER_USER=patrick SUPER_PASS=... node test/smoke.js
// WARNING: creates (and deletes) an election called "Smoke Test Election" plus two facilitators.
// Nominations are switched off by default, so this covers: setup -> candidates -> registration -> approval -> voting -> results.
const BASE = process.env.BASE || 'http://localhost:3000';
const SUPER_USER = process.env.SUPER_USER || 'patrick';
const SUPER_PASS = process.env.SUPER_PASS || 'supersecret1';

let passed = 0, failed = 0;
function ok(cond, name) { if (cond) { passed++; console.log('  ✓', name); } else { failed++; console.log('  ✗', name); } }

async function call(method, path, { token, body } = {}) {
  const res = await fetch(BASE + '/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null; try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
}

(async () => {
  const suffix = Date.now().toString(36);
  const M = (id) => `/manage/elections/${id}`;

  console.log('Auth');
  let r = await call('POST', '/auth/login', { body: { username: SUPER_USER, password: 'wrong' } });
  ok(r.status === 401, 'wrong password rejected');
  r = await call('POST', '/auth/login', { body: { username: SUPER_USER, password: SUPER_PASS } });
  ok(r.status === 200 && r.data.user.role === 'super_admin', 'super login');
  const S = r.data.token;

  console.log('Super: facilitators & election');
  r = await call('POST', '/super/facilitators', { token: S, body: { name: 'Grace Phiri', username: 'grace' + suffix, password: 'short' } });
  ok(r.status === 400, 'short password rejected');
  r = await call('POST', '/super/facilitators', { token: S, body: { name: 'Grace Phiri', username: 'grace' + suffix, password: 'gracepass123' } });
  ok(r.status === 201, 'facilitator A created');
  const facA = r.data.facilitator;
  r = await call('POST', '/super/facilitators', { token: S, body: { name: 'Other Person', username: 'other' + suffix, password: 'otherpass123' } });
  const facB = r.data.facilitator;

  r = await call('POST', '/super/elections', { token: S, body: { name: 'Smoke Test Election', description: 'test', facilitator_ids: [facA.id] } });
  ok(r.status === 201, 'election created');
  const E = r.data.election;
  r = await call('POST', '/auth/login', { body: { username: 'grace' + suffix, password: 'gracepass123' } });
  const A = r.data.token;
  r = await call('POST', '/auth/login', { body: { username: 'other' + suffix, password: 'otherpass123' } });
  const B = r.data.token;

  console.log('Permissions');
  r = await call('GET', '/super/elections', { token: A });
  ok(r.status === 403, 'facilitator cannot use super routes');
  r = await call('GET', `${M(E.id)}/voters`, { token: B });
  ok(r.status === 403, 'unassigned facilitator blocked from voters');
  r = await call('GET', `/public/elections/${E.slug}`);
  ok(r.status === 404, 'draft election hidden from public');

  console.log('Setup');
  r = await call('PUT', `${M(E.id)}/positions`, { token: A, body: { positions: [{ title: 'Most Dedicated' }, { title: 'Golden Voice' }] } });
  ok(r.status === 200 && r.data.positions.length === 2, 'positions saved');
  const [P1, P2] = r.data.positions;
  r = await call('PUT', `${M(E.id)}/groups`, { token: A, body: { groups: [{ label: 'Male' }, { label: 'Female' }] } });
  const [GM, GF] = r.data.groups;

  console.log('Nominations are switched off');
  r = await call('POST', `${M(E.id)}/nominations/state`, { token: A, body: { state: 'open' } });
  ok(r.status === 409, 'cannot open nominations');
  ok(r.data.election === undefined, 'nominations stay closed');

  console.log('Candidates (entered directly)');
  const add = (p, g, name, photo) => call('POST', `${M(E.id)}/candidates`, { token: A, body: { position_id: p, group_id: g, name, photo_url: photo } });
  r = await add(P1.id, null, 'X'); ok(r.status === 400, 'group required for candidate');
  r = await add(P1.id, GM.id, 'John Banda', 'javascript:alert(1)'); ok(r.status === 400, 'non-http photo URL rejected');
  r = await add(P1.id, GM.id, 'John Banda', 'https://example.com/j.jpg'); ok(r.status === 201, 'candidate added');
  const cJohn = r.data.candidate;
  r = await add(P1.id, GM.id, 'john banda'); ok(r.status === 409, 'duplicate candidate rejected');
  r = await call('POST', `${M(E.id)}/candidates/bulk`, { token: A, body: { position_id: P1.id, group_id: GM.id, candidates: [{ name: 'Peter Zulu' }, { name: 'peter zulu' }] } });
  ok(r.status === 400, 'bulk: duplicate inside list rejected');
  r = await call('POST', `${M(E.id)}/candidates/bulk`, { token: A, body: { position_id: P1.id, group_id: GM.id, candidates: [{ name: 'Peter Zulu' }, { name: 'John Banda' }] } });
  ok(r.status === 409, 'bulk: clash with existing candidate rejected');
  r = await call('GET', M(E.id), { token: A });
  ok(r.data.candidates.length === 1, 'bulk is all-or-nothing (nobody added)');
  r = await call('POST', `${M(E.id)}/candidates/bulk`, { token: A, body: { position_id: P1.id, group_id: GM.id, candidates: [{ name: 'Peter Zulu' }, { name: 'Sam Mwale', photo_url: 'https://example.com/s.jpg' }] } });
  ok(r.status === 201 && r.data.candidates.length === 2, 'bulk add works');
  const cPeter = r.data.candidates[0];
  r = await add(P1.id, GF.id, 'Grace Phiri'); const cGrace = r.data.candidate;
  r = await add(P2.id, GM.id, 'Mwai Manja'); const cMwai = r.data.candidate;

  console.log('Registration');
  const reg = (body) => call('POST', `/public/elections/${E.slug}/register`, { body });
  r = await reg({ reg_number: 'BIS/01/22/001', password: 'secret1' });
  ok(r.status === 404, 'election still hidden before registration opens');
  r = await call('POST', `${M(E.id)}/voting/state`, { token: A, body: { state: 'open' } });
  ok(r.status === 409, 'cannot open voting before anyone is approved');
  r = await call('POST', `${M(E.id)}/registration/state`, { token: A, body: { state: 'closed' } });
  ok(r.status === 409, 'cannot close registration that is not open');
  r = await call('POST', `${M(E.id)}/registration/state`, { token: A, body: { state: 'open' } });
  ok(r.status === 200 && r.data.election.phase === 'registration', 'registration opened');
  r = await call('GET', `/public/elections/${E.slug}`);
  ok(r.status === 200 && r.data.election.phase === 'registration', 'election now public, in registration phase');

  r = await reg({ reg_number: 'ab', password: 'secret1' }); ok(r.status === 400, 'invalid reg number rejected');
  r = await reg({ reg_number: 'BIS/01/22/001', password: '123' }); ok(r.status === 400, 'short voter password rejected');
  r = await reg({ reg_number: 'bis/01/22/001', password: 'secret1' }); ok(r.status === 201 && r.data.reg_number === 'BIS/01/22/001', 'voter 1 registered (reg normalised)');
  r = await reg({ reg_number: ' BIS/01/22/001 ', password: 'other-pass' }); ok(r.status === 409, 'duplicate reg number rejected');
  const regs = ['BIS/01/22/002', 'BIS/01/22/003', 'BIS/01/22/004', 'BIS/01/22/005', 'BIS/01/22/006'];
  for (const x of regs) { r = await reg({ reg_number: x, password: 'secret1' }); ok(r.status === 201, `registered ${x}`); }

  const login = (rn, pw) => call('POST', `/public/elections/${E.slug}/voter-login`, { body: { reg_number: rn, password: pw } });
  r = await login('BIS/01/22/001', 'wrong'); ok(r.status === 401, 'wrong voter password rejected');
  r = await login('NOPE/00/00/000', 'secret1'); ok(r.status === 401, 'unknown reg number rejected');
  r = await login('bis/01/22/001', 'secret1'); ok(r.status === 200 && r.data.voter.status === 'pending', 'voter login works, status pending');
  const V1 = r.data.token;

  r = await call('POST', `${M(E.id)}/voting/state`, { token: A, body: { state: 'open' } });
  ok(r.status === 409, 'cannot open voting while registration is open');
  r = await call('POST', `${M(E.id)}/registration/state`, { token: A, body: { state: 'closed' } });
  ok(r.status === 200, 'registration closed');
  r = await reg({ reg_number: 'BIS/01/22/099', password: 'secret1' }); ok(r.status === 403, 'cannot register after close');
  r = await call('POST', `${M(E.id)}/voting/state`, { token: A, body: { state: 'open' } });
  ok(r.status === 409, 'cannot open voting with zero approved voters');

  console.log('Voter approval');
  r = await call('GET', `${M(E.id)}/voters`, { token: A });
  ok(r.status === 200 && r.data.voters.length === 6 && r.data.voters.every((v) => v.status === 'pending'), 'voter list: 6 pending');
  ok(!('password_hash' in r.data.voters[0]), 'password hashes never exposed');
  const byReg = Object.fromEntries(r.data.voters.map((v) => [v.reg_number, v]));
  r = await call('PATCH', `${M(E.id)}/voters/${byReg['BIS/01/22/001'].id}`, { token: A, body: { status: 'approved' } });
  ok(r.status === 200 && r.data.voter.status === 'approved', 'single approve');
  r = await call('PATCH', `${M(E.id)}/voters/${byReg['BIS/01/22/001'].id}`, { token: A, body: { status: 'maybe' } });
  ok(r.status === 400, 'bad status rejected');
  r = await call('POST', `${M(E.id)}/voters/bulk`, { token: A, body: { action: 'reject', scope: 'list', reg_numbers: ['bis/01/22/006', 'GHOST/1/1/1'] } });
  ok(r.status === 200 && r.data.updated === 1 && r.data.not_found.join() === 'GHOST/1/1/1', 'reject from list (reports unknown numbers)');
  r = await call('POST', `${M(E.id)}/voters/bulk`, { token: A, body: { action: 'approve', scope: 'list', reg_numbers: ['BIS/01/22/002'] } });
  ok(r.status === 200 && r.data.updated === 1, 'approve from list');
  r = await call('POST', `${M(E.id)}/voters/bulk`, { token: A, body: { action: 'approve', scope: 'all_pending' } });
  ok(r.status === 200 && r.data.updated === 3, 'approve all pending (3 left; rejected one untouched)');
  r = await call('GET', M(E.id), { token: A });
  ok(r.data.counts.voters_approved === 5 && r.data.counts.voters_rejected === 1, 'counts: 5 approved, 1 rejected');

  r = await call('POST', `${M(E.id)}/voters/${byReg['BIS/01/22/005'].id}/reset-password`, { token: A });
  ok(r.status === 200 && r.data.password.length === 8, 'password reset returns a new password');
  const newPw = r.data.password;
  r = await login('BIS/01/22/005', 'secret1'); ok(r.status === 401, 'old password stops working');
  r = await login('BIS/01/22/005', newPw); ok(r.status === 200, 'new password works');
  const V5 = r.data.token;

  console.log('Voting');
  const vote = (tok, votes) => call('POST', `/public/elections/${E.slug}/vote`, { token: tok, body: { votes } });
  r = await vote(V1, [{ position_id: P1.id, group_id: GM.id, candidate_id: cJohn.id }]);
  ok(r.status === 403, 'cannot vote before voting opens');
  r = await call('POST', `${M(E.id)}/voting/state`, { token: A, body: { state: 'open' } });
  ok(r.status === 200 && r.data.election.voting_state === 'open', 'voting opened');
  r = await call('POST', `${M(E.id)}/registration/state`, { token: A, body: { state: 'open' } });
  ok(r.status === 409, 'cannot reopen registration after voting started');
  r = await add(P2.id, GF.id, 'Late Entry'); ok(r.status === 409, 'candidates locked once voting opens');

  r = await call('POST', `/public/elections/${E.slug}/vote`, { body: { votes: [{ position_id: P1.id, group_id: GM.id, candidate_id: cJohn.id }] } });
  ok(r.status === 401, 'vote without login rejected');
  r = await vote(A, [{ position_id: P1.id, group_id: GM.id, candidate_id: cJohn.id }]);
  ok(r.status === 401, 'a staff token is not a voter token');
  const staffAsVoter = await call('GET', `${M(E.id)}`, { token: V1 });
  ok(staffAsVoter.status === 401, 'a voter token is not a staff token');

  r = await vote(V1, [
    { position_id: P1.id, group_id: GM.id, candidate_id: cJohn.id },
    { position_id: P1.id, group_id: GF.id, candidate_id: cGrace.id },
    { position_id: P2.id, group_id: GM.id, candidate_id: cMwai.id },
  ]);
  ok(r.status === 201, 'voter 1 ballot accepted');
  r = await vote(V1, [{ position_id: P1.id, group_id: GM.id, candidate_id: cPeter.id }]);
  ok(r.status === 409, 'second ballot from same voter rejected');
  r = await login('BIS/01/22/001', 'secret1'); ok(r.data.voter.has_voted === true, 'login shows has_voted');
  const V1b = r.data.token;
  r = await vote(V1b, [{ position_id: P1.id, group_id: GM.id, candidate_id: cPeter.id }]);
  ok(r.status === 409, 'logging in again does not allow a second vote');

  r = await login('BIS/01/22/002', 'secret1'); const V2 = r.data.token;
  r = await vote(V2, [{ position_id: P1.id, group_id: GM.id, candidate_id: cGrace.id }]);
  ok(r.status === 400, 'candidate/slot mismatch rejected');
  r = await vote(V2, [{ position_id: P1.id, group_id: GM.id, candidate_id: cJohn.id }, { position_id: P1.id, group_id: GM.id, candidate_id: cPeter.id }]);
  ok(r.status === 400, 'two picks in one slot rejected');
  r = await vote(V2, [{ position_id: P1.id, group_id: GM.id, candidate_id: cPeter.id }]);
  ok(r.status === 201, 'voter 2 partial ballot accepted');

  r = await login('BIS/01/22/006', 'secret1'); const V6 = r.data.token;
  r = await vote(V6, [{ position_id: P1.id, group_id: GM.id, candidate_id: cJohn.id }]);
  ok(r.status === 403, 'rejected voter cannot vote');

  const race = await Promise.all([1, 2, 3, 4, 5].map(() => vote(V5, [{ position_id: P1.id, group_id: GM.id, candidate_id: cJohn.id }])));
  ok(race.filter((x) => x.status === 201).length === 1, 'concurrent double-submit: exactly one accepted');

  r = await call('PATCH', `${M(E.id)}/voters/${byReg['BIS/01/22/001'].id}`, { token: A, body: { status: 'rejected' } });
  ok(r.status === 409, 'cannot reject a voter who already voted');
  r = await call('POST', `${M(E.id)}/voters/bulk`, { token: A, body: { action: 'reject', scope: 'list', reg_numbers: ['BIS/01/22/001'] } });
  ok(r.status === 200 && r.data.updated === 0 && r.data.skipped_voted.length === 1, 'bulk reject skips voters who already voted');

  console.log('Results');
  r = await call('GET', `/public/elections/${E.slug}/results`);
  ok(r.data.released === false, 'results hidden while voting');
  r = await call('POST', `${M(E.id)}/results/release`, { token: A, body: { released: true } });
  ok(r.status === 409, 'cannot release while voting open');
  r = await call('POST', `${M(E.id)}/voting/state`, { token: A, body: { state: 'closed' } });
  ok(r.status === 200, 'voting closed');
  r = await login('BIS/01/22/003', 'secret1'); const V3 = r.data.token;
  r = await vote(V3, [{ position_id: P1.id, group_id: GM.id, candidate_id: cJohn.id }]);
  ok(r.status === 403, 'cannot vote after close');
  r = await call('PATCH', `${M(E.id)}/voters/${byReg['BIS/01/22/003'].id}`, { token: A, body: { status: 'rejected' } });
  ok(r.status === 409, 'voter list locked after voting closes');
  r = await call('POST', `${M(E.id)}/results/release`, { token: A, body: { released: true } });
  ok(r.status === 200, 'results released');
  r = await call('GET', `/public/elections/${E.slug}/results`);
  const slotM = r.data.results.positions[0].slots[0];
  ok(r.data.released && r.data.results.total_ballots === 3, '3 ballots counted');
  ok(slotM.candidates[0].name === 'John Banda' && slotM.candidates[0].votes === 2, 'John has 2 votes in Male slot');
  ok(slotM.candidates.find((c) => c.name === 'Peter Zulu').votes === 1, 'Peter has 1 vote');
  r = await call('GET', `${M(E.id)}/export`, { token: A });
  ok(r.status === 200 && r.data.votes.length === 5, 'export contains 5 votes');
  ok(!JSON.stringify(r.data).includes('BIS/01/22/001'), 'export contains no voter identities');

  console.log('Cleanup');
  r = await call('DELETE', `/super/elections/${E.id}`, { token: S, body: { confirm_name: 'Smoke Test Election' } });
  ok(r.status === 200, 'election deleted');
  r = await call('PATCH', `/super/facilitators/${facA.id}`, { token: S, body: { is_active: false } });
  r = await call('GET', '/manage/elections', { token: A });
  ok(r.status === 401, 'disabled facilitator loses access immediately');
  await call('DELETE', `/super/facilitators/${facA.id}`, { token: S });
  await call('DELETE', `/super/facilitators/${facB.id}`, { token: S });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
