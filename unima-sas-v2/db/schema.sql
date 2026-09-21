-- Idempotent schema: safe to run on every boot.

CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  username      TEXT NOT NULL,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('super_admin', 'facilitator')),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_username_key ON users (LOWER(username));

CREATE TABLE IF NOT EXISTS elections (
  id                 BIGSERIAL PRIMARY KEY,
  slug               TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  description        TEXT,
  nominations_state  TEXT NOT NULL DEFAULT 'pending' CHECK (nominations_state IN ('pending', 'open', 'closed')),
  voting_state       TEXT NOT NULL DEFAULT 'pending' CHECK (voting_state IN ('pending', 'open', 'closed')),
  results_released   BOOLEAN NOT NULL DEFAULT FALSE,
  public_nominations BOOLEAN NOT NULL DEFAULT TRUE,
  created_by         BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Voter registration phase (added in v2.1; the ALTER keeps existing databases working)
ALTER TABLE elections ADD COLUMN IF NOT EXISTS registration_state TEXT NOT NULL DEFAULT 'pending';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'elections_registration_state_check') THEN
    ALTER TABLE elections ADD CONSTRAINT elections_registration_state_check
      CHECK (registration_state IN ('pending', 'open', 'closed'));
  END IF;
END $$;

-- Registered voters. Ballots are NOT linked to voters (only has_voted is flipped), so votes stay secret.
CREATE TABLE IF NOT EXISTS voters (
  id            BIGSERIAL PRIMARY KEY,
  election_id   BIGINT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  reg_number    TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  has_voted     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (election_id, reg_number)
);
CREATE INDEX IF NOT EXISTS voters_election_status_idx ON voters (election_id, status);

CREATE TABLE IF NOT EXISTS election_facilitators (
  election_id BIGINT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (election_id, user_id)
);
CREATE INDEX IF NOT EXISTS election_facilitators_user_idx ON election_facilitators (user_id);

-- Optional split of every position into separate contests (e.g. Male / Female, Year 1 / Year 2)
CREATE TABLE IF NOT EXISTS election_groups (
  id          BIGSERIAL PRIMARY KEY,
  election_id BIGINT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  label       TEXT NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS election_groups_election_idx ON election_groups (election_id);

CREATE TABLE IF NOT EXISTS positions (
  id          BIGSERIAL PRIMARY KEY,
  election_id BIGINT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  sort_order  INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS positions_election_idx ON positions (election_id);

CREATE TABLE IF NOT EXISTS nomination_submissions (
  id          BIGSERIAL PRIMARY KEY,
  election_id BIGINT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS nomination_submissions_election_idx ON nomination_submissions (election_id);

CREATE TABLE IF NOT EXISTS nominations (
  id            BIGSERIAL PRIMARY KEY,
  election_id   BIGINT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  submission_id BIGINT REFERENCES nomination_submissions(id) ON DELETE CASCADE,
  position_id   BIGINT NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  group_id      BIGINT REFERENCES election_groups(id) ON DELETE CASCADE,
  nominee_name  TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS nominations_election_idx ON nominations (election_id, position_id);

CREATE TABLE IF NOT EXISTS candidates (
  id          BIGSERIAL PRIMARY KEY,
  election_id BIGINT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  position_id BIGINT NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  group_id    BIGINT REFERENCES election_groups(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  photo_url   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS candidates_election_idx ON candidates (election_id, position_id);

-- One ballot per voter per election (the unique constraint is what stops double voting)
CREATE TABLE IF NOT EXISTS ballots (
  id          BIGSERIAL PRIMARY KEY,
  election_id BIGINT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  voter_token TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (election_id, voter_token)
);

CREATE TABLE IF NOT EXISTS votes (
  id           BIGSERIAL PRIMARY KEY,
  ballot_id    BIGINT NOT NULL REFERENCES ballots(id) ON DELETE CASCADE,
  election_id  BIGINT NOT NULL REFERENCES elections(id) ON DELETE CASCADE,
  position_id  BIGINT NOT NULL REFERENCES positions(id) ON DELETE CASCADE,
  group_id     BIGINT REFERENCES election_groups(id) ON DELETE CASCADE,
  candidate_id BIGINT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS votes_one_per_slot ON votes (ballot_id, position_id, COALESCE(group_id, 0));
CREATE INDEX IF NOT EXISTS votes_candidate_idx ON votes (candidate_id);
CREATE INDEX IF NOT EXISTS votes_election_idx ON votes (election_id);
