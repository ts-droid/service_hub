-- Vendora Support Hub - Postgres schema (MVP)

CREATE TABLE IF NOT EXISTS users (
  user_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  "group" TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'User',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tickets (
  ticket_id TEXT PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT NOT NULL,
  "group" TEXT NOT NULL,
  owner_email TEXT,
  sender_email TEXT NOT NULL,
  thread_id TEXT NOT NULL UNIQUE,
  last_message_at TIMESTAMPTZ NOT NULL,
  tags TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  message_id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(ticket_id) ON DELETE CASCADE,
  date TIMESTAMPTZ NOT NULL,
  "from" TEXT NOT NULL,
  "to" TEXT,
  subject TEXT,
  body TEXT,
  gmail_message_id TEXT,
  thread_id TEXT
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS logs (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ticket_id TEXT,
  user_email TEXT,
  action TEXT NOT NULL,
  details TEXT
);

CREATE TABLE IF NOT EXISTS blacklist (
  email TEXT PRIMARY KEY,
  blocked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tickets_group_status ON tickets("group", status);
CREATE INDEX IF NOT EXISTS idx_tickets_owner ON tickets(owner_email);
CREATE INDEX IF NOT EXISTS idx_messages_ticket ON messages(ticket_id);
