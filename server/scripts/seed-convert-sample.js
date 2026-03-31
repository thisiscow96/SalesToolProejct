/**
 * 매출 전환(매입→매출) 테스트용 매입 1건 생성 — 잔여 수량 전부(할당 없음)
 * - 운영(Render Shell) 또는 로컬에서 DATABASE_URL 로 실행
 * - 중복 방지: 동일 마커 memo 가진 매입이 있으면 스킵
 *
 *   cd server && SAMPLE_AGENT_NO=admin001 npm run seed-convert-sample
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const SEED_MARK = 'prod-convert-sample-v1';
const TARGET_AGENT_NO = process.env.SAMPLE_AGENT_NO || 'admin001';

function getPoolConfig() {
  const raw = process.env.DATABASE_URL && process.env.DATABASE_URL.trim();
  if (raw && (raw.startsWith('postgres://') || raw.startsWith('postgresql://'))) {
    const u = new URL(raw);
    const database = (u.pathname || '/').slice(1).replace(/\?.*$/, '');
    const needSsl =
      process.env.NODE_ENV === 'production' ||
      (u.hostname && u.hostname.includes('render.com')) ||
      (u.searchParams && u.searchParams.get('sslmode'));
    return {
      host: u.hostname,
      port: u.port ? Number(u.port) : 5432,
      user: u.username || undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      database: database || undefined,
      ssl: needSsl ? { rejectUnauthorized: false } : undefined,
    };
  }
  return { connectionString: process.env.DATABASE_URL };
}

async function upsertAccount(client, userId, { name, type, location }) {
  const found = await client.query(
    'SELECT id FROM account WHERE user_id = $1 AND name = $2 AND type = $3 LIMIT 1',
    [userId, name, type],
  );
  if (found.rows[0]) return found.rows[0].id;
  const ins = await client.query(
    `INSERT INTO account (user_id, name, type, location, memo)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [userId, name, type, location || null, `${SEED_MARK}:account`],
  );
  return ins.rows[0].id;
}

async function upsertProduct(client, name, unit) {
  const found = await client.query('SELECT id FROM product WHERE name = $1 LIMIT 1', [name]);
  if (found.rows[0]) return found.rows[0].id;
  const ins = await client.query(
    `INSERT INTO product (name, unit, memo) VALUES ($1, $2, $3) RETURNING id`,
    [name, unit || 'kg', `${SEED_MARK}:product`],
  );
  return ins.rows[0].id;
}

async function addInventory(client, userId, productId, deltaQty) {
  const ex = await client.query(
    'SELECT id, quantity FROM inventory WHERE user_id = $1 AND product_id = $2 FOR UPDATE',
    [userId, productId],
  );
  if (ex.rows[0]) {
    const next = Number(ex.rows[0].quantity) + Number(deltaQty);
    await client.query('UPDATE inventory SET quantity = $1, updated_at = NOW() WHERE id = $2', [next, ex.rows[0].id]);
  } else {
    await client.query(
      'INSERT INTO inventory (user_id, product_id, quantity) VALUES ($1, $2, $3)',
      [userId, productId, deltaQty],
    );
  }
}

async function run() {
  const pool = new Pool(getPoolConfig());
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const u = await client.query(
      'SELECT id, name, agent_no FROM "user" WHERE agent_no = $1 AND status = $2 LIMIT 1',
      [TARGET_AGENT_NO, 'active'],
    );
    if (!u.rows[0]) {
      throw new Error(`대상 사용자(agent_no=${TARGET_AGENT_NO}) 없음. seed-admin 또는 회원가입 후 실행하세요.`);
    }
    const userId = u.rows[0].id;
    const warehouseLabel = `${u.rows[0].name} (중매 ${u.rows[0].agent_no})`;

    const dup = await client.query(
      `SELECT id FROM purchase WHERE user_id = $1 AND memo = $2 LIMIT 1`,
      [userId, `${SEED_MARK}:purchase`],
    );
    if (dup.rows[0]) {
      await client.query('ROLLBACK');
      console.log(`[seed-convert-sample] 이미 존재함 (purchase_id=${dup.rows[0].id}). 스킵.`);
      return;
    }

    const supplierId = await upsertAccount(client, userId, {
      name: '매출전환용매입처',
      type: 'supplier',
      location: '샘플',
    });

    const productId = await upsertProduct(client, '매출전환용상품', 'kg');
    const today = new Date().toISOString().slice(0, 10);
    const qty = 50;
    const unitPrice = 3000;
    const totalAmount = qty * unitPrice;

    const pur = await client.query(
      `INSERT INTO purchase (user_id, partner_id, product_id, quantity, unit_price, total_amount, purchase_date, memo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [userId, supplierId, productId, qty, unitPrice, totalAmount, today, `${SEED_MARK}:purchase`],
    );

    await addInventory(client, userId, productId, qty);
    await client.query(
      `INSERT INTO product_transfer
       (user_id, product_id, quantity, action_type, from_type, to_type, from_partner_id, before_location, after_location, purchase_id, memo)
       VALUES ($1, $2, $3, 'purchase', 'supplier', 'inventory', $4, $5, $6, $7, $8)`,
      [
        userId,
        productId,
        qty,
        supplierId,
        '매출전환용매입처 · 샘플',
        warehouseLabel,
        pur.rows[0].id,
        `${SEED_MARK}:transfer-purchase`,
      ],
    );

    await client.query('COMMIT');
    console.log('[seed-convert-sample] 완료');
    console.log(`  purchase_id=${pur.rows[0].id} 잔여=${qty} (할당 없음) → 매입정보에서 선택 매출 전환 테스트 가능`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[seed-convert-sample] 실패:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
