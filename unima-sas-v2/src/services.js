// Shared queries. `db` can be the pool or a transaction client.

async function loadStructure(db, electionId) {
  const groups = await db.query(
    'SELECT id, label FROM election_groups WHERE election_id = $1 ORDER BY sort_order, id', [electionId]);
  const positions = await db.query(
    'SELECT id, title FROM positions WHERE election_id = $1 ORDER BY sort_order, id', [electionId]);
  return { groups: groups.rows, positions: positions.rows };
}

async function loadCandidates(db, electionId) {
  const { rows } = await db.query(
    `SELECT id, position_id, group_id, name, photo_url
       FROM candidates WHERE election_id = $1
      ORDER BY position_id, group_id NULLS FIRST, name`, [electionId]);
  return rows;
}

// positions -> slots (one per group, or a single slot when the election has no groups) -> candidates with vote counts
async function buildResults(db, electionId) {
  const { groups, positions } = await loadStructure(db, electionId);
  const election = await db.query('SELECT runoff_state, runoff_slots FROM elections WHERE id = $1', [electionId]);
  const runoffState = election.rows[0]?.runoff_state || 'pending';
  const runoffSlots = election.rows[0]?.runoff_slots || [];
  const cands = await db.query(
    `SELECT c.id, c.position_id, c.group_id, c.name, c.photo_url,
            COUNT(v.id) FILTER (WHERE b.round = 'initial')::int AS initial_votes,
            COUNT(v.id) FILTER (WHERE b.round = 'runoff')::int AS runoff_votes
       FROM candidates c LEFT JOIN votes v ON v.candidate_id = c.id
       LEFT JOIN ballots b ON b.id = v.ballot_id
      WHERE c.election_id = $1
      GROUP BY c.id`, [electionId]);
  const ballots = await db.query('SELECT COUNT(*)::int AS n FROM ballots WHERE election_id = $1', [electionId]);

  const slotGroups = groups.length ? groups : [{ id: null, label: null }];
  return {
    total_ballots: ballots.rows[0].n,
    runoff_state: runoffState,
    runoff_slots: runoffSlots,
    positions: positions.map((p) => ({
      id: p.id,
      title: p.title,
      slots: slotGroups.map((g) => ({
        group_id: g.id,
        group_label: g.label,
        runoff_pending: runoffState === 'open' && runoffSlots.some((s) => s.position_id === p.id && (s.group_id ?? null) === g.id),
        candidates: cands.rows
          .filter((c) => c.position_id === p.id && (c.group_id ?? null) === g.id)
          .map(({ id, name, photo_url, initial_votes, runoff_votes }) => {
            const slot = runoffSlots.find((s) => s.position_id === p.id && (s.group_id ?? null) === g.id);
            const useRunoff = runoffState === 'closed' && slot;
            return { id, name, photo_url, votes: useRunoff ? runoff_votes : initial_votes };
          })
          .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name)),
      })),
    })),
  };
}

// Nominations grouped by slot, with the same name (case-insensitive) counted together.
async function nominationSummary(db, electionId) {
  const { rows } = await db.query(
    `SELECT position_id, group_id, MIN(nominee_name) AS name, COUNT(*)::int AS count
       FROM nominations WHERE election_id = $1
      GROUP BY position_id, group_id, LOWER(nominee_name)
      ORDER BY position_id, group_id NULLS FIRST, count DESC, MIN(nominee_name)`, [electionId]);
  return rows;
}

module.exports = { loadStructure, loadCandidates, buildResults, nominationSummary };
