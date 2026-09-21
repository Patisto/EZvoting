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
  const cands = await db.query(
    `SELECT c.id, c.position_id, c.group_id, c.name, c.photo_url, COUNT(v.id)::int AS votes
       FROM candidates c LEFT JOIN votes v ON v.candidate_id = c.id
      WHERE c.election_id = $1
      GROUP BY c.id`, [electionId]);
  const ballots = await db.query('SELECT COUNT(*)::int AS n FROM ballots WHERE election_id = $1', [electionId]);

  const slotGroups = groups.length ? groups : [{ id: null, label: null }];
  return {
    total_ballots: ballots.rows[0].n,
    positions: positions.map((p) => ({
      id: p.id,
      title: p.title,
      slots: slotGroups.map((g) => ({
        group_id: g.id,
        group_label: g.label,
        candidates: cands.rows
          .filter((c) => c.position_id === p.id && (c.group_id ?? null) === g.id)
          .sort((a, b) => b.votes - a.votes || a.name.localeCompare(b.name))
          .map(({ id, name, photo_url, votes }) => ({ id, name, photo_url, votes })),
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
