# Vendora Support Hub API (MVP)

## What this is
Node/Express backend with Postgres schema that mirrors the Sheets structure.
Includes:
- Users, tickets, messages, config, logs, blacklist
- Gmail sync job (per-user Google OAuth token)
- Gemini reply helper

## Local run
1. `cp .env.example .env` and fill in values
2. Create database and run schema

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

3. Install and run

```bash
npm install
npm run dev
```

## Railway setup (summary)
1. Create a new Railway project
2. Add Postgres plugin
3. Add a Node service pointing to this `server/` directory
4. Set environment variables from `.env.example` in Railway (do not commit or store `DATABASE_URL` in the repo)
5. Run schema once in Railway shell:

```bash
psql "$DATABASE_URL" -f db/schema.sql
```

6. Run seed data (config defaults):

```bash
psql "$DATABASE_URL" -f db/seed.sql
```

6. Add a Railway cron to hit `POST /jobs/gmail-sync` with `x-job-token: JOB_TOKEN`

## Auth (MVP)
Google OAuth login with cookie session:
- `GET /auth/google` to login
- Cookie `vendora_session` stores JWT (7 days)

## Endpoints (MVP)
- `GET /health`
- `GET /groups`
- `POST /users/register`
- `GET /tickets?group=&status=`
- `GET /tickets/:id`
- `POST /tickets/:id/reply`
- `POST /tickets/:id/move`
- `POST /tickets/:id/block`
- `POST /tickets/:id/status`
- `POST /ai/gemini`
- `GET /admin/users`
- `DELETE /admin/users/:email`
- `GET /admin/blacklist`
- `DELETE /admin/blacklist/:email`
- `POST /admin/config`
- `POST /jobs/gmail-sync`

## Notes
- Gmail sync and sending replies use per-user OAuth tokens captured at Google login (`gmail.readonly` + `gmail.send`).
- Existing users should log out and sign in again once to grant the Gmail scopes.
- Sync reads incoming mail across connected mailbox folders (not only shared group aliases).
- Replies try to send from group mailbox by ticket group:
  - `SUPPORT -> support@vendora.se`
  - `RMA -> rma@vendora.se`
  - `FINANCE -> invoice@vendora.se`
  - `LOGISTICS -> logistics@vendora.se`
  - `MARKETING -> marketing@vendora.se`
  - `SALES -> sales@vendora.se`
- Group-from addresses require Gmail Send-As/delegation on the user's account; otherwise system falls back to the user's own email.
- Optional env overrides:
  - `GROUP_MAIL_SUPPORT`, `GROUP_MAIL_RMA`, `GROUP_MAIL_FINANCE`, `GROUP_MAIL_LOGISTICS`, `GROUP_MAIL_MARKETING`, `GROUP_MAIL_SALES`
- `config` keys used: `AI_PROMPT`, `KEYWORDS_RMA`, `KEYWORDS_FINANCE`, `KEYWORDS_LOGISTICS`, `KEYWORDS_SUPPORT`.

## Import data from CSV
1. Export each sheet to CSV and place files in a folder (default: `server/csv`).
2. Filenames must match:
   - `Users.csv`
   - `Tickets.csv`
   - `Messages.csv`
   - `Config.csv`
   - `Logs.csv`
   - `Blacklist.csv`
3. Run:

```bash
export DATABASE_URL="postgresql://..."
export CSV_DIR="/path/to/csv"
node scripts/import_csv.js
```

The importer truncates existing tables before inserting fresh data.
