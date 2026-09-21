# UNIMA SAS Elections (configurable)

One app that can run **any number of elections** (society awards, class reps, committee posts…).
Node/Express + Neon Postgres, plain HTML/CSS/JS frontend served by the same server.
It replaces the old `backend/`, `frontend/` and `sas-voting/` folders.

## Who does what

| Role | Can do |
|---|---|
| **Super admin** (you) | Create elections (name + description), create facilitator accounts, assign facilitators to elections, reset passwords / disable accounts, delete elections |
| **Facilitator** | For the elections they're assigned to: set up positions & groups, enter the successful candidates, open/close voter registration, download and approve the voter list, open/close voting, release results |
| **Voter** | Registers with **reg number + password** and later logs in to vote, all at `/e/<election-slug>` |

Election flow: **Setup → Candidates entered → Registration open → Registration closed → Voters checked & approved → Voting open → Voting closed → Results released**

Nominations are handled outside the system, so the *Nominations* tab and phase card are blurred and switched off. Set `ENABLE_NOMINATIONS=true` to bring the old open-nominations flow back.

### Voter registration & approval
1. **Open registration** (Overview or Voters tab) and share the link `/e/<election-slug>`. Students enter their reg number and a password (typed twice, with a "written it down" tick-box, because there is no email recovery).
2. **Close registration**, then open the **Voters** tab and **Download list (CSV)** to check the reg numbers against the student records.
3. **Reject** the invalid ones (per row, or paste a list under *Reject from list…*), then **Approve all pending** (or *Approve from list…*).
4. Forgotten password? **Reset password** on the voter's row gives you a new one to pass on.
5. Voting can only open once registration is closed and at least one voter is approved. Only approved voters can vote.

**Exports:** the **Voters** tab has *Download PDF* (full list) and *Download list (CSV)*. The **Results** tab has *Download PDF* (one page per position, winners 🏆 / losers 🚲 beside the vote count), *Download data (JSON)* and a live refresh.

Ballots are not linked to voters (only a "has voted" flag is set), so votes stay secret. Rejected voters who already voted can't be rejected, and the voter list locks when voting closes.

### The "voting profile"
- **Positions** – e.g. Most Dedicated, Golden Voice (add / rename / reorder)
- **Groups** (optional) – split each position into separate contests, e.g. Male / Female or Year 1 / Year 2. No groups = one winner per position.
- **Candidates** – name + optional photo link, per position/group. In the Candidates tab each candidate has its own **Photo link** field; for several at once, paste one per line (`Name | photo link`). Locked once voting opens (typo/photo fixes still allowed).

## Run locally

```bash
cp .env.example .env      # fill in DATABASE_URL (Neon), JWT_SECRET, SUPER_ADMIN_*
npm install
npm start                 # creates tables + the super account on first boot
```
Open http://localhost:3000 — staff log in at `/login`.

**Neon:** create a project, copy the **pooled** connection string (host contains `-pooler`) into `DATABASE_URL`.
Tables are created automatically on every boot (`db/schema.sql` is idempotent), or run `npm run migrate`.

Forgot the super password? `npm run create-super -- <username> <new-password>`

## Deploy (Render, one web service — no separate Netlify frontend needed)

- Build command: `npm install` · Start command: `npm start`
- Environment: `DATABASE_URL`, `JWT_SECRET`, `SUPER_ADMIN_USERNAME`, `SUPER_ADMIN_PASSWORD`, `BRAND_NAME`, `NODE_ENV=production`
- Health check path: `/health`

## Test

With the server running: `BASE=http://localhost:3000 SUPER_USER=<u> SUPER_PASS=<p> node test/smoke.js`
(creates and removes a throwaway election; 82 checks covering permissions, phase rules, registration/approval, and double-vote protection).

## Notes
- Old admin keys were hardcoded in browser JS (anyone could read them). They're gone; access is now real logins with hashed passwords and expiring tokens.
- Old Supabase data isn't migrated. The old service-role/anon keys are no longer used, so rotate them in Supabase.
- **One vote per registered voter:** each voter has a reg number + password and a `has_voted` flag that is locked in the same transaction as the ballot, so double voting isn't possible even with concurrent requests. Whether a reg number really belongs to the person registering is decided by your scrutiny step, so check the CSV carefully before approving.
- Voter sessions last 4 hours and live in the browser tab (sessionStorage), so they end when the tab is closed.
