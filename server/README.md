# Vendora Support Hub API (MVP)

## What this is
Node/Express backend with Postgres schema that mirrors the Sheets structure.
Includes:
- Users, tickets, messages, config, logs, blacklist
- Gmail sync job (Google OAuth refresh token)
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
- Gmail sync requires Google OAuth client + refresh token.
- `config` keys used: `AI_PROMPT`, `KEYWORDS_RMA`, `KEYWORDS_FINANCE`, `KEYWORDS_LOGISTICS`, `KEYWORDS_SUPPORT`.
