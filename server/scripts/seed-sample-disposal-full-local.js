const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const TARGET_AGENT_NO = process.env.SAMPLE_AGENT_NO || 'admin001';
const SEED_MARK = 'sample-seed-local-v1';

async function run() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await client.query('SELECT id, name, agent_no FROM "user" WHERE agent_no = $1 LIMIT 1', [TARGET_AGENT_NO]);
    if (!u.rows[0]) throw new Error('sample user not found');
    const userId = u.rows[0].id;
    const warehouseLabel = `${u.rows[0].name} (중매 ${u.rows[0].agent_no})`;

    const targets = await client.query(
      `SELECT DISTINCT product_id
       FROM sale
       WHERE user_id = $1 AND memo LIKE $2
       ORDER BY product_id
       LIMIT 2`,
      [userId, `${SEED_MARK}:sale%`]
    );

    let created = 0;
    for (const row of targets.rows) {
      const productId = row.product_id;
      const inv = await client.query(
        'SELECT id, quantity FROM inventory WHERE user_id = $1 AND product_id = $2 FOR UPDATE',
        [userId, productId]
      );
      const qty = Number(inv.rows[0]?.quantity || 0);
      if (!(qty > 0)) continue;

      await client.query('UPDATE inventory SET quantity = 0, updated_at = NOW() WHERE id = $1', [inv.rows[0].id]);
      const d = await client.query(
        `INSERT INTO disposal (user_id, product_id, quantity, disposal_date, reason, memo)
         VALUES ($1,$2,$3,$4,$5,$6)
         RETURNING id`,
        [userId, productId, qty, new Date().toISOString().slice(0, 10), '상품 폐기', `${SEED_MARK}:disposal-full`]
      );
      await client.query(
        `INSERT INTO product_transfer
        (user_id, product_id, quantity, action_type, from_type, to_type, before_location, after_location, disposal_id, memo)
        VALUES
        ($1,$2,$3,'disposal','inventory','disposal',$4,'폐기',$5,$6)`,
        [userId, productId, qty, warehouseLabel, d.rows[0].id, `${SEED_MARK}:transfer-disposal-full`]
      );
      created += 1;
    }

    await client.query('COMMIT');
    console.log(`[sample-disposal-full] completed. created=${created}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[sample-disposal-full] failed:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
