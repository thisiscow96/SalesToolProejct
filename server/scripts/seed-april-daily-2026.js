/**
 * 운영/로컬: admin001 전용 2026-04-01 ~ 04-06 일자별 매입·매출 샘플
 * - purchase_date / sale_date 를 각 날짜로 두고, 매입→매출(할당)까지 동일 패턴으로 삽입
 * - 중복 방지: 첫 날짜(04-01) 매입 memo 가 이미 있으면 전체 스킵
 *
 *   cd server && npm run seed-april-daily-2026
 *   SAMPLE_AGENT_NO=admin001 (기본값)
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const SEED_MARK = 'prod-april-daily-2026-v1';
const TARGET_AGENT_NO = process.env.SAMPLE_AGENT_NO || 'admin001';

const DAYS = ['2026-04-01', '2026-04-02', '2026-04-03', '2026-04-04', '2026-04-05', '2026-04-06'];

const PRODUCT_SPECS = [
  { name: '샘플_홍고추', unit: '10kg', categoryLarge: '채소', categoryMid: '고추' },
  { name: '샘플_청양고추', unit: '10kg', categoryLarge: '채소', categoryMid: '고추' },
];

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

async function upsertProduct(client, name, unit, categoryLarge, categoryMid) {
  const found = await client.query('SELECT id FROM product WHERE name = $1 LIMIT 1', [name]);
  if (found.rows[0]) {
    await client.query(
      'UPDATE product SET unit = $1, category_large = $2, category_mid = $3, updated_at = NOW() WHERE id = $4',
      [unit || 'kg', categoryLarge || null, categoryMid || null, found.rows[0].id],
    );
    return found.rows[0].id;
  }
  const ins = await client.query(
    `INSERT INTO product (name, unit, memo) VALUES ($1, $2, $3) RETURNING id`,
    [name, unit || 'kg', `${SEED_MARK}:product`],
  );
  await client.query(
    'UPDATE product SET category_large = $1, category_mid = $2, updated_at = NOW() WHERE id = $3',
    [categoryLarge || null, categoryMid || null, ins.rows[0].id],
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
    await client.query('INSERT INTO inventory (user_id, product_id, quantity) VALUES ($1, $2, $3)', [
      userId,
      productId,
      deltaQty,
    ]);
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
      throw new Error(`대상 사용자(agent_no=${TARGET_AGENT_NO}) 없음. seed-admin 후 실행하세요.`);
    }
    const userId = u.rows[0].id;
    const warehouseLabel = `${u.rows[0].name} (중매 ${u.rows[0].agent_no})`;

    const dup = await client.query(`SELECT id FROM purchase WHERE user_id = $1 AND memo = $2 LIMIT 1`, [
      userId,
      `${SEED_MARK}:purchase:${DAYS[0]}`,
    ]);
    if (dup.rows[0]) {
      await client.query('ROLLBACK');
      console.log(`[seed-april-daily-2026] 이미 삽입됨 (purchase 기준). 스킵.`);
      return;
    }

    const supplierId = await upsertAccount(client, userId, {
      name: '한국청과',
      type: 'supplier',
      location: '가락시장',
    });
    const ottogiId = await upsertAccount(client, userId, {
      name: '오뚜기',
      type: 'customer',
      location: '서울',
    });
    const nongshimId = await upsertAccount(client, userId, {
      name: '농심',
      type: 'customer',
      location: '서울',
    });

    const productIds = [];
    for (const p of PRODUCT_SPECS) {
      productIds.push(await upsertProduct(client, p.name, p.unit, p.categoryLarge, p.categoryMid));
    }

    for (let di = 0; di < DAYS.length; di += 1) {
      const dayStr = DAYS[di];
      const productId = productIds[di % productIds.length];
      const purchaseQty = 8 + di;
      const unitPrice = 3000 + di * 150;
      const totalPurchase = Number((purchaseQty * unitPrice).toFixed(2));

      const pur = await client.query(
        `INSERT INTO purchase (user_id, partner_id, product_id, quantity, unit_price, total_amount, purchase_date, memo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          userId,
          supplierId,
          productId,
          purchaseQty,
          unitPrice,
          totalPurchase,
          dayStr,
          `${SEED_MARK}:purchase:${dayStr}`,
        ],
      );

      await addInventory(client, userId, productId, purchaseQty);

      await client.query(
        `INSERT INTO product_transfer
        (user_id, product_id, quantity, action_type, from_type, to_type, from_partner_id, before_location, after_location, purchase_id, memo)
        VALUES ($1, $2, $3, 'purchase', 'supplier', 'inventory', $4, $5, $6, $7, $8)`,
        [
          userId,
          productId,
          purchaseQty,
          supplierId,
          '한국청과 · 가락시장',
          warehouseLabel,
          pur.rows[0].id,
          `${SEED_MARK}:transfer-purchase:${dayStr}`,
        ],
      );

      const salePartnerId = di % 2 === 0 ? ottogiId : nongshimId;
      const salePartnerLabel = di % 2 === 0 ? '오뚜기 · 서울' : '농심 · 서울';
      const saleQty = Math.min(3 + (di % 2), purchaseQty);
      const saleUnitPrice = Number((unitPrice * 1.22).toFixed(2));
      const saleTotal = Number((saleQty * saleUnitPrice).toFixed(2));

      const sale = await client.query(
        `INSERT INTO sale (user_id, partner_id, product_id, quantity, unit_price, total_amount, sale_date, payment_status, paid_amount, status, memo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'unpaid', 0, 'active', $8)
         RETURNING id`,
        [userId, salePartnerId, productId, saleQty, saleUnitPrice, saleTotal, dayStr, `${SEED_MARK}:sale:${dayStr}`],
      );

      await addInventory(client, userId, productId, -saleQty);

      await client.query(
        `INSERT INTO product_transfer
        (user_id, product_id, quantity, action_type, from_type, to_type, to_partner_id, before_location, after_location, sale_id, purchase_id, memo)
        VALUES ($1, $2, $3, 'sale', 'inventory', 'customer', $4, $5, $6, $7, $8, $9)`,
        [
          userId,
          productId,
          saleQty,
          salePartnerId,
          warehouseLabel,
          salePartnerLabel,
          sale.rows[0].id,
          pur.rows[0].id,
          `${SEED_MARK}:transfer-sale:${dayStr}`,
        ],
      );

      await client.query('INSERT INTO purchase_allocation (user_id, purchase_id, sale_id, quantity) VALUES ($1, $2, $3, $4)', [
        userId,
        pur.rows[0].id,
        sale.rows[0].id,
        saleQty,
      ]);
    }

    await client.query('COMMIT');
    console.log('[seed-april-daily-2026] 완료');
    console.log(`  user=${TARGET_AGENT_NO} (${DAYS[0]} ~ ${DAYS[DAYS.length - 1]}) 매입·매출 ${DAYS.length}일분`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[seed-april-daily-2026] 실패:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
