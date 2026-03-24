const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');

async function run() {
  const raw = (process.env.DATABASE_URL || '').trim();
  const useSsl = raw.includes('render.com');
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  });
  await client.connect();
  try {
    const count = await client.query('SELECT COUNT(*)::int AS cnt FROM "user"');
    console.log('user_count=', count.rows[0].cnt);

    const rows = await client.query(
      'SELECT id, name, email, agent_no, status, created_at FROM "user" ORDER BY id DESC LIMIT 5'
    );
    console.log('latest_users=');
    rows.rows.forEach((r) => {
      console.log(`- id=${r.id} name=${r.name} email=${r.email} agent_no=${r.agent_no} status=${r.status} created_at=${r.created_at.toISOString()}`);
    });
  } finally {
    await client.end();
  }
}

run().catch((e) => {
  console.error('check-users error:', e.message);
  process.exit(1);
});
