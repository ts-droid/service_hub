#!/usr/bin/env node
const db = require('../src/db');

async function findSourceMessageDuplicates(client) {
  const res = await client.query(
    `WITH grouped AS (
       SELECT
         source_message_id,
         ARRAY_AGG(ticket_id ORDER BY created_at ASC, ticket_id ASC) AS ticket_ids
       FROM tickets
       WHERE source_message_id IS NOT NULL
       GROUP BY source_message_id
       HAVING COUNT(*) > 1
     )
     SELECT
       source_message_id,
       ticket_ids[1] AS keep_ticket_id,
       ticket_ids[2:array_length(ticket_ids, 1)] AS delete_ticket_ids
     FROM grouped`
  );
  return res.rows;
}

async function findHeuristicDuplicates(client) {
  const res = await client.query(
    `WITH first_messages AS (
       SELECT DISTINCT ON (m.ticket_id)
         m.ticket_id,
         COALESCE(m.body, '') AS first_body
       FROM messages m
       ORDER BY m.ticket_id, m.date ASC
     ),
     fingerprints AS (
       SELECT
         t.ticket_id,
         t.created_at,
         t."group",
         LOWER(COALESCE(t.sender_email, '')) AS sender_email_lc,
         LOWER(REGEXP_REPLACE(REGEXP_REPLACE(COALESCE(t.subject, ''), '^\\[[^\\]]+\\]\\s*', ''), '\\s+', ' ', 'g')) AS normalized_subject,
         md5(first_messages.first_body) AS body_hash,
         FLOOR(EXTRACT(EPOCH FROM t.created_at) / 900)::bigint AS bucket_15m
       FROM tickets t
       JOIN first_messages ON first_messages.ticket_id = t.ticket_id
       WHERE t.source_message_id IS NULL
         AND LENGTH(first_messages.first_body) >= 40
     ),
     grouped AS (
       SELECT
         sender_email_lc,
         "group",
         normalized_subject,
         body_hash,
         bucket_15m,
         ARRAY_AGG(ticket_id ORDER BY created_at ASC, ticket_id ASC) AS ticket_ids
       FROM fingerprints
       GROUP BY sender_email_lc, "group", normalized_subject, body_hash, bucket_15m
       HAVING COUNT(*) > 1
     )
     SELECT
       sender_email_lc,
       "group",
       normalized_subject,
       ticket_ids[1] AS keep_ticket_id,
       ticket_ids[2:array_length(ticket_ids, 1)] AS delete_ticket_ids
     FROM grouped`
  );
  return res.rows;
}

function collectDeletes(groups) {
  const keep = new Set();
  const del = new Set();
  for (const row of groups) {
    keep.add(row.keep_ticket_id);
    for (const id of row.delete_ticket_ids || []) del.add(id);
  }
  for (const id of keep) del.delete(id);
  return Array.from(del);
}

async function main() {
  const apply = process.argv.includes('--apply');
  const client = await db.pool.connect();
  try {
    await client.query('ALTER TABLE tickets ADD COLUMN IF NOT EXISTS source_message_id TEXT');
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS uq_tickets_source_message_id
      ON tickets(source_message_id)
      WHERE source_message_id IS NOT NULL`);

    const sourceMessageGroups = await findSourceMessageDuplicates(client);
    const heuristicGroups = await findHeuristicDuplicates(client);

    const toDelete = collectDeletes(sourceMessageGroups).concat(
      collectDeletes(heuristicGroups)
    );
    const uniqueToDelete = Array.from(new Set(toDelete));

    console.log(
      JSON.stringify(
        {
          source_message_duplicate_groups: sourceMessageGroups.length,
          heuristic_duplicate_groups: heuristicGroups.length,
          tickets_to_delete: uniqueToDelete.length
        },
        null,
        2
      )
    );

    if (!apply) {
      console.log('Dry run. Use --apply to delete duplicates.');
      return;
    }
    if (!uniqueToDelete.length) {
      console.log('No duplicates to delete.');
      return;
    }

    await client.query('BEGIN');
    const deleted = await client.query(
      'DELETE FROM tickets WHERE ticket_id = ANY($1::text[]) RETURNING ticket_id',
      [uniqueToDelete]
    );
    await client.query('COMMIT');
    console.log(`Deleted ${deleted.rowCount} duplicate tickets.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
    await db.pool.end();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
