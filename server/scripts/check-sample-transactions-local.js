const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Client } = require('pg');

const SEED_MARK = 'sample-seed-local-v1';
const TARGET_AGENT_NO = process.env.SAMPLE_AGENT_NO || 'admin001';

async function run() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const u = await client.query('SELECT id FROM "user" WHERE agent_no = $1 LIMIT 1', [TARGET_AGENT_NO]);
    if (!u.rows[0]) throw new Error('user not found');
    const userId = u.rows[0].id;

    const summary = await client.query(
      `SELECT
        (SELECT COUNT(*) FROM sale WHERE user_id = $1 AND memo LIKE $2) AS sales,
        (SELECT COUNT(*) FROM payment WHERE user_id = $1 AND memo LIKE $3) AS payments,
        (SELECT COUNT(*) FROM refund WHERE user_id = $1 AND memo LIKE $4) AS refunds,
        (SELECT COUNT(*) FROM disposal WHERE user_id = $1 AND memo LIKE $5) AS disposals`,
      [userId, `${SEED_MARK}:sale%`, `${SEED_MARK}:payment%`, `${SEED_MARK}:refund%`, `${SEED_MARK}:disposal%`]
    );
    console.log('sample_summary=', summary.rows[0]);

    const payStatus = await client.query(
      `SELECT payment_status, COUNT(*)::int AS cnt
       FROM sale
       WHERE user_id = $1 AND memo LIKE $2
       GROUP BY payment_status
       ORDER BY payment_status`,
      [userId, `${SEED_MARK}:sale%`]
    );
    console.log('sale_payment_status=');
    payStatus.rows.forEach((r) => console.log(`- ${r.payment_status}: ${r.cnt}`));
  } finally {
    await client.end();
  }
}

run().catch((e) => {
  console.error('check-sample-transactions-local error:', e.message);
  process.exit(1);
});
