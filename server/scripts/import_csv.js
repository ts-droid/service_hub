const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
const CSV_DIR = process.env.CSV_DIR || path.resolve(process.cwd(), 'csv');

if (!DATABASE_URL) throw new Error('DATABASE_URL missing');

const HEADERS = {
  users: ["user_id","name","email","group","role","active","created_at"],
  tickets: ["ticket_id","created_at","updated_at","subject","status","priority","group","owner_email","sender_email","thread_id","last_message_at","tags"],
  messages: ["message_id","ticket_id","date","from","to","subject","body","gmail_message_id","thread_id"],
  config: ["key","value"],
  logs: ["timestamp", "ticket_id", "user_email", "action", "details"],
  blacklist: ["email", "blocked_at"]
};

const FILES = {
  users: 'Users.csv',
  tickets: 'Tickets.csv',
  messages: 'Messages.csv',
  config: 'Config.csv',
  logs: 'Logs.csv',
  blacklist: 'Blacklist.csv'
};

function parseCSV(content) {
  const rows = [];
  let row = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = content[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === ',' && !inQuotes) {
      row.push(cur);
      cur = '';
      continue;
    }

    if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (ch === '\r' && next === '\n') i++;
      row.push(cur);
      rows.push(row);
      row = [];
      cur = '';
      continue;
    }

    cur += ch;
  }

  if (cur.length || row.length) {
    row.push(cur);
    rows.push(row);
  }

  return rows;
}

function toBoolean(v) {
  if (v === true || v === false) return v;
  const s = String(v || '').toLowerCase().trim();
  if (s === 'true' || s === '1' || s === 'yes') return true;
  if (s === 'false' || s === '0' || s === 'no') return false;
  return null;
}

function toTimestamp(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (!s) return null;
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.toISOString();
  return s;
}

function coerceRow(table, rowObj) {
  if (table === 'users') {
    return { ...rowObj, active: toBoolean(rowObj.active) };
  }
  if (['tickets','messages','logs','blacklist'].includes(table)) {
    const out = { ...rowObj };
    for (const k of Object.keys(out)) {
      if (k.endsWith('_at') || k === 'date' || k === 'timestamp' || k === 'created_at' || k === 'updated_at' || k === 'last_message_at' || k === 'blocked_at') {
        out[k] = toTimestamp(out[k]);
      }
    }
    return out;
  }
  return rowObj;
}

function rowsToObjects(table, rows) {
  if (!rows.length) return [];
  const headers = rows[0].map(h => String(h || '').trim());
  const useHeaders = headers.every(Boolean) ? headers : HEADERS[table];

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.length === 0) continue;
    const obj = {};
    useHeaders.forEach((h, idx) => { obj[h] = r[idx] !== undefined ? r[idx] : null; });
    out.push(coerceRow(table, obj));
  }
  return out;
}

async function truncateAll(client) {
  await client.query('TRUNCATE TABLE messages, tickets, users, config, logs, blacklist RESTART IDENTITY');
}

async function insertRows(client, table, headers, rows) {
  if (!rows.length) return;
  const cols = headers.map(h => `"${h}"`).join(',');
  for (const r of rows) {
    const values = headers.map(h => (r[h] === '' ? null : r[h]));
    const params = values.map((_, i) => `$${i + 1}`).join(',');
    const sql = `INSERT INTO ${table} (${cols}) VALUES (${params})`;
    await client.query(sql, values);
  }
}

async function run() {
  const pool = new Pool({ connectionString: DATABASE_URL, ssl: process.env.PGSSLMODE === 'require' ? { rejectUnauthorized: false } : false });
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await truncateAll(client);

    for (const [table, file] of Object.entries(FILES)) {
      const filePath = path.join(CSV_DIR, file);
      if (!fs.existsSync(filePath)) {
        console.log(`Skipping ${file} (not found)`);
        continue;
      }
      const content = fs.readFileSync(filePath, 'utf8');
      const rows = parseCSV(content);
      const objects = rowsToObjects(table, rows);
      await insertRows(client, table, HEADERS[table], objects);
      console.log(`${file}: ${objects.length} rows imported`);
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
