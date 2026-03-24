const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const SEED_MARK = 'sample-seed-local-v1';
const TARGET_AGENT_NO = process.env.SAMPLE_AGENT_NO || 'admin001';

const PRODUCT_SPECS = [
  { name: '홍고추', qty: 10, unitPrice: 3200, unit: '10kg', categoryLarge: '채소', categoryMid: '고추' },
  { name: '청양고추', qty: 10, unitPrice: 3600, unit: '10kg', categoryLarge: '채소', categoryMid: '고추' },
  { name: '오이고추', qty: 10, unitPrice: 2800, unit: '10kg', categoryLarge: '채소', categoryMid: '고추' },
  { name: '꽈리고추', qty: 5, unitPrice: 3000, unit: '3kg', categoryLarge: '채소', categoryMid: '고추' },
  { name: '노랑 파프리카', qty: 5, unitPrice: 4200, unit: '10kg', categoryLarge: '채소', categoryMid: '파프리카' },
  { name: '초록 파프리카', qty: 5, unitPrice: 4100, unit: '10kg', categoryLarge: '채소', categoryMid: '파프리카' },
  { name: '빨강 파프리카', qty: 5, unitPrice: 4300, unit: '10kg', categoryLarge: '채소', categoryMid: '파프리카' },
];

async function upsertAccount(client, userId, { name, type, location }) {
  const found = await client.query(
    'SELECT id FROM account WHERE user_id = $1 AND name = $2 AND type = $3 LIMIT 1',
    [userId, name, type]
  );
  if (found.rows[0]) return found.rows[0].id;
  const ins = await client.query(
    `INSERT INTO account (user_id, name, type, location, memo)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [userId, name, type, location || null, `${SEED_MARK}:account`]
  );
  return ins.rows[0].id;
}

async function upsertProduct(client, name, unit, categoryLarge, categoryMid) {
  const found = await client.query('SELECT id FROM product WHERE name = $1 LIMIT 1', [name]);
  if (found.rows[0]) {
    await client.query(
      'UPDATE product SET unit = $1, category_large = $2, category_mid = $3, updated_at = NOW() WHERE id = $4',
      [unit || 'kg', categoryLarge || null, categoryMid || null, found.rows[0].id]
    );
    return found.rows[0].id;
  }
  const ins = await client.query(
    `INSERT INTO product (name, unit, memo)
     VALUES ($1, 'kg', $2)
     RETURNING id`,
    [name, `${SEED_MARK}:product`]
  );
  await client.query(
    'UPDATE product SET unit = $1, category_large = $2, category_mid = $3, updated_at = NOW() WHERE id = $4',
    [unit || 'kg', categoryLarge || null, categoryMid || null, ins.rows[0].id]
  );
  return ins.rows[0].id;
}

async function addInventory(client, userId, productId, deltaQty) {
  const ex = await client.query(
    'SELECT id, quantity FROM inventory WHERE user_id = $1 AND product_id = $2 FOR UPDATE',
    [userId, productId]
  );
  if (ex.rows[0]) {
    const next = Number(ex.rows[0].quantity) + Number(deltaQty);
    await client.query('UPDATE inventory SET quantity = $1, updated_at = NOW() WHERE id = $2', [next, ex.rows[0].id]);
  } else {
    await client.query(
      'INSERT INTO inventory (user_id, product_id, quantity) VALUES ($1, $2, $3)',
      [userId, productId, deltaQty]
    );
  }
}

async function run() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const u = await client.query(
      'SELECT id, name, agent_no FROM "user" WHERE agent_no = $1 AND status = $2 LIMIT 1',
      [TARGET_AGENT_NO, 'active']
    );
    if (!u.rows[0]) {
      throw new Error(`대상 사용자(agent_no=${TARGET_AGENT_NO})를 찾을 수 없습니다. 먼저 seed-admin 또는 회원가입을 수행하세요.`);
    }
    const userId = u.rows[0].id;
    const warehouseLabel = `${u.rows[0].name} (중매 ${u.rows[0].agent_no})`;

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

    const today = new Date().toISOString().slice(0, 10);

    for (let i = 0; i < PRODUCT_SPECS.length; i += 1) {
      const p = PRODUCT_SPECS[i];
      const productId = await upsertProduct(client, p.name, p.unit, p.categoryLarge, p.categoryMid);

      const pur = await client.query(
        `INSERT INTO purchase (user_id, partner_id, product_id, quantity, unit_price, total_amount, purchase_date, memo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          userId,
          supplierId,
          productId,
          p.qty,
          p.unitPrice,
          Number((p.qty * p.unitPrice).toFixed(2)),
          today,
          `${SEED_MARK}:purchase`,
        ]
      );

      await addInventory(client, userId, productId, p.qty);

      await client.query(
        `INSERT INTO product_transfer
        (user_id, product_id, quantity, action_type, from_type, to_type, from_partner_id, before_location, after_location, purchase_id, memo)
        VALUES
        ($1, $2, $3, 'purchase', 'supplier', 'inventory', $4, $5, $6, $7, $8)`,
        [userId, productId, p.qty, supplierId, '한국청과 · 가락시장', warehouseLabel, pur.rows[0].id, `${SEED_MARK}:transfer-purchase`]
      );

      // 판매 샘플 1건씩: 오뚜기/농심 교차
      const salePartnerId = i % 2 === 0 ? ottogiId : nongshimId;
      const salePartnerLabel = i % 2 === 0 ? '오뚜기 · 서울' : '농심 · 서울';
      const saleQty = Math.min(1, p.qty); // 재고 과감소 방지
      const saleUnitPrice = Number((p.unitPrice * 1.25).toFixed(2));
      const saleTotal = Number((saleQty * saleUnitPrice).toFixed(2));

      const sale = await client.query(
        `INSERT INTO sale (user_id, partner_id, product_id, quantity, unit_price, total_amount, sale_date, payment_status, paid_amount, status, memo)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'unpaid', 0, 'active', $8)
         RETURNING id`,
        [userId, salePartnerId, productId, saleQty, saleUnitPrice, saleTotal, today, `${SEED_MARK}:sale`]
      );

      await addInventory(client, userId, productId, -saleQty);

      await client.query(
        `INSERT INTO product_transfer
        (user_id, product_id, quantity, action_type, from_type, to_type, to_partner_id, before_location, after_location, sale_id, purchase_id, memo)
        VALUES
        ($1, $2, $3, 'sale', 'inventory', 'customer', $4, $5, $6, $7, $8, $9)`,
        [userId, productId, saleQty, salePartnerId, warehouseLabel, salePartnerLabel, sale.rows[0].id, pur.rows[0].id, `${SEED_MARK}:transfer-sale`]
      );

      await client.query(
        'INSERT INTO purchase_allocation (user_id, purchase_id, sale_id, quantity) VALUES ($1, $2, $3, $4)',
        [userId, pur.rows[0].id, sale.rows[0].id, saleQty]
      );
    }

    await client.query('COMMIT');

    const inv = await client.query(
      `SELECT p.name AS product_name, i.quantity
       FROM inventory i
       JOIN product p ON p.id = i.product_id
       WHERE i.user_id = $1 AND p.name = ANY($2::text[])
       ORDER BY p.name`,
      [u.rows[0].id, PRODUCT_SPECS.map((x) => x.name)]
    );
    console.log(`[sample-seed] 완료 user_id=${u.rows[0].id} agent_no=${TARGET_AGENT_NO}`);
    inv.rows.forEach((r) => console.log(`- ${r.product_name}: ${r.quantity}kg`));
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[sample-seed] 실패:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
