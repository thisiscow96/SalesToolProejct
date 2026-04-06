/**
 * 운영/로컬: admin001 전용 — 2026-04-01 ~ 04-06 대량 플로우 샘플
 * - 출처(source_name): 모두 「한국청과」
 * - 매입 거래처·매출 거래처: 아래 SUPPLIERS / CUSTOMERS 풀을 순환
 * - 건수(각 약 100): 매입 100 · 매출(흑자+매입연결) 100 · 미수(전액/일부) 100 · 폐기 100
 *
 *   cd server && npm run seed-oper-april-flow-2026
 *   SAMPLE_AGENT_NO=admin001 (기본값)
 *
 * 중복 방지: 동일 마커의 첫 매입(purchase:0)이 있으면 전체 스킵
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const SEED_MARK = 'prod-april-flow-2026-v1';
const SOURCE_NAME = '한국청과';
const TARGET_AGENT_NO = process.env.SAMPLE_AGENT_NO || 'admin001';
const ROWS = 100;

const DAYS = ['2026-04-01', '2026-04-02', '2026-04-03', '2026-04-04', '2026-04-05', '2026-04-06'];

/** 매입 거래처(실제 상대·상호) — 필요 시 배열만 수정 */
const SUPPLIERS = [
  { name: '박도매', location: '가락 A동' },
  { name: '최청과', location: '가락 B동' },
  { name: '(주)가락신선', location: '서울' },
  { name: '김상회', location: '가락시장' },
  { name: '이농산', location: '경기' },
  { name: '정유통', location: '인천' },
  { name: '한샘식품', location: '부산' },
  { name: '오거래', location: '대구' },
  { name: '윤도매', location: '광주' },
  { name: '강수산', location: '수원' },
  { name: '서울청과', location: '서울' },
  { name: '경기농협', location: '용인' },
  { name: '인천유통', location: '인천' },
  { name: '부산청과', location: '부산' },
  { name: '대구도매', location: '대구' },
  { name: '광주청과', location: '광주' },
  { name: '수원상회', location: '수원' },
  { name: '안양도매', location: '안양' },
  { name: '성남식품', location: '성남' },
  { name: '용인농산', location: '용인' },
];

/** 매출 거래처 */
const CUSTOMERS = [
  { name: '오뚜기', location: '서울' },
  { name: '농심', location: '서울' },
  { name: 'CJ프레시웨이', location: '부천' },
  { name: '롯데마트', location: '서울' },
  { name: '이마트', location: '성남' },
  { name: '홈플러스', location: '수원' },
  { name: 'GS리테일', location: '서울' },
  { name: '신세계푸드', location: '용인' },
  { name: '풀무원', location: '이천' },
  { name: '동원F&B', location: '서울' },
  { name: '삼성웰스토리', location: '수원' },
  { name: '현대그린푸드', location: '안양' },
  { name: '아워홈', location: '안양' },
  { name: '아이마켓', location: '서울' },
  { name: '코웨이푸드', location: '인천' },
  { name: 'SPC삼립', location: '서울' },
  { name: '빙그레', location: '대구' },
  { name: '매일유업', location: '서울' },
  { name: '서울우유', location: '서울' },
  { name: '하림', location: '김제' },
];

const PRODUCT_SPECS = [
  { name: '운영샘플_홍고추', unit: '10kg', categoryLarge: '채소', categoryMid: '고추' },
  { name: '운영샘플_청양고추', unit: '10kg', categoryLarge: '채소', categoryMid: '고추' },
  { name: '운영샘플_대파', unit: '10kg', categoryLarge: '채소', categoryMid: '파' },
  { name: '운영샘플_양파', unit: '20kg', categoryLarge: '채소', categoryMid: '양파' },
  { name: '운영샘플_마늘', unit: '10kg', categoryLarge: '채소', categoryMid: '마늘' },
  { name: '운영샘플_감자', unit: '20kg', categoryLarge: '채소', categoryMid: '감자' },
  { name: '운영샘플_당근', unit: '10kg', categoryLarge: '채소', categoryMid: '당근' },
  { name: '운영샘플_배추', unit: '10kg', categoryLarge: '채소', categoryMid: '배추' },
  { name: '운영샘플_무', unit: '20kg', categoryLarge: '채소', categoryMid: '무' },
  { name: '운영샘플_상추', unit: '4kg', categoryLarge: '채소', categoryMid: '엽채' },
  { name: '운영샘플_깻잎', unit: '2kg', categoryLarge: '채소', categoryMid: '엽채' },
  { name: '운영샘플_오이', unit: '50입', categoryLarge: '채소', categoryMid: '오이' },
  { name: '운영샘플_가지', unit: '4kg', categoryLarge: '채소', categoryMid: '가지' },
  { name: '운영샘플_토마토', unit: '5kg', categoryLarge: '채소', categoryMid: '토마토' },
  { name: '운영샘플_방울토마토', unit: '2kg', categoryLarge: '채소', categoryMid: '토마토' },
  { name: '운영샘플_브로콜리', unit: '5kg', categoryLarge: '채소', categoryMid: '브로콜리' },
  { name: '운영샘플_양배추', unit: '10kg', categoryLarge: '채소', categoryMid: '양배추' },
  { name: '운영샘플_시금치', unit: '4kg', categoryLarge: '채소', categoryMid: '엽채' },
  { name: '운영샘플_콩나물', unit: '3.5kg', categoryLarge: '채소', categoryMid: '나물' },
  { name: '운영샘플_숙주', unit: '3kg', categoryLarge: '채소', categoryMid: '나물' },
  { name: '운영샘플_팽이버섯', unit: '2kg', categoryLarge: '버섯', categoryMid: '팽이' },
  { name: '운영샘플_새송이', unit: '2kg', categoryLarge: '버섯', categoryMid: '새송이' },
  { name: '운영샘플_사과', unit: '15kg', categoryLarge: '과일', categoryMid: '사과' },
  { name: '운영샘플_배', unit: '10kg', categoryLarge: '과일', categoryMid: '배' },
  { name: '운영샘플_포도', unit: '5kg', categoryLarge: '과일', categoryMid: '포도' },
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

function accountLine(name, location) {
  const n = name != null ? String(name).trim() : '';
  const l = location != null ? String(location).trim() : '';
  if (l && n) return `${n} · ${l}`;
  return l || n || '';
}

async function getUserWarehouseLabel(client, userId) {
  const u = await client.query(`SELECT name, agent_no FROM "user" WHERE id = $1`, [userId]);
  const r = u.rows[0];
  if (!r) return '내 창고';
  return `${r.name} (중매 ${r.agent_no})`;
}

async function upsertAccount(client, userId, { name, type, location }) {
  const found = await client.query(
    'SELECT id, name, location FROM account WHERE user_id = $1 AND name = $2 AND type = $3 LIMIT 1',
    [userId, name, type],
  );
  if (found.rows[0]) return found.rows[0];
  const ins = await client.query(
    `INSERT INTO account (user_id, name, type, location, memo)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, location`,
    [userId, name, type, location || null, `${SEED_MARK}:account`],
  );
  return ins.rows[0];
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

async function upsertInventoryDelta(client, userId, productId, delta) {
  const existing = await client.query(
    `SELECT quantity FROM inventory WHERE user_id = $1 AND product_id = $2 FOR UPDATE`,
    [userId, productId],
  );
  const cur = existing.rows[0] ? Number(existing.rows[0].quantity) : 0;
  const next = cur + delta;
  if (next < 0) {
    const e = new Error('재고가 부족합니다.');
    e.code = 'NEGATIVE_INVENTORY';
    throw e;
  }
  if (existing.rows[0]) {
    await client.query(
      `UPDATE inventory SET quantity = $1, updated_at = NOW() WHERE user_id = $2 AND product_id = $3`,
      [next, userId, productId],
    );
  } else {
    if (delta <= 0) {
      const e = new Error('재고가 부족합니다.');
      e.code = 'NEGATIVE_INVENTORY';
      throw e;
    }
    await client.query(`INSERT INTO inventory (user_id, product_id, quantity) VALUES ($1,$2,$3)`, [
      userId,
      productId,
      next,
    ]);
  }
}

async function insertTransfer(client, row) {
  await client.query(
    `INSERT INTO product_transfer (
       user_id, product_id, quantity, action_type, from_type, to_type,
       from_partner_id, to_partner_id, before_location, after_location,
       transferred_at, purchase_id, sale_id, disposal_id, refund_id, memo
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, COALESCE($11::timestamptz, NOW()), $12,$13,$14,$15,$16)`,
    [
      row.userId,
      row.productId,
      row.quantity,
      row.actionType,
      row.fromType,
      row.toType,
      row.fromPartnerId ?? null,
      row.toPartnerId ?? null,
      row.beforeLocation ?? null,
      row.afterLocation ?? null,
      row.transferredAt ?? null,
      row.purchaseId ?? null,
      row.saleId ?? null,
      row.disposalId ?? null,
      row.refundId ?? null,
      row.memo ?? null,
    ],
  );
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
      throw new Error(`대상 사용자(agent_no=${TARGET_AGENT_NO}) 없음. npm run seed-admin 후 실행하세요.`);
    }
    const userId = u.rows[0].id;
    const wh = await getUserWarehouseLabel(client, userId);

    const dup = await client.query(`SELECT id FROM purchase WHERE user_id = $1 AND memo = $2 LIMIT 1`, [
      userId,
      `${SEED_MARK}:purchase:0`,
    ]);
    if (dup.rows[0]) {
      await client.query('ROLLBACK');
      console.log(`[seed-oper-april-flow-2026] 이미 삽입됨. 스킵.`);
      return;
    }

    const supplierIds = [];
    for (const s of SUPPLIERS) {
      const row = await upsertAccount(client, userId, {
        name: s.name,
        type: 'supplier',
        location: s.location,
      });
      supplierIds.push(row.id);
    }
    const customerIds = [];
    for (const c of CUSTOMERS) {
      const row = await upsertAccount(client, userId, {
        name: c.name,
        type: 'customer',
        location: c.location,
      });
      customerIds.push(row.id);
    }

    const productIds = [];
    for (const p of PRODUCT_SPECS) {
      productIds.push(await upsertProduct(client, p.name, p.unit, p.categoryLarge, p.categoryMid));
    }

    for (let i = 0; i < ROWS; i += 1) {
      const dayStr = DAYS[i % DAYS.length];
      const supplier = SUPPLIERS[i % SUPPLIERS.length];
      const customer = CUSTOMERS[i % CUSTOMERS.length];
      const supplierId = supplierIds[i % supplierIds.length];
      const customerId = customerIds[i % customerIds.length];
      const productId = productIds[i % productIds.length];

      const qtyPur = 32 + (i % 11);
      const unitPur = 2600 + (i % 25) * 40;
      const totalPur = Math.round(qtyPur * unitPur * 100) / 100;

      const pur = await client.query(
        `INSERT INTO purchase (user_id, partner_id, product_id, quantity, unit_price, total_amount, purchase_date, memo, source_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         RETURNING id`,
        [
          userId,
          supplierId,
          productId,
          qtyPur,
          unitPur,
          totalPur,
          dayStr,
          `${SEED_MARK}:purchase:${i}`,
          SOURCE_NAME,
        ],
      );
      const purchaseId = pur.rows[0].id;

      await upsertInventoryDelta(client, userId, productId, qtyPur);
      await insertTransfer(client, {
        userId,
        productId,
        quantity: qtyPur,
        actionType: 'purchase',
        fromType: 'supplier',
        toType: 'inventory',
        fromPartnerId: supplierId,
        toPartnerId: null,
        beforeLocation: accountLine(supplier.name, supplier.location),
        afterLocation: wh,
        purchaseId,
        memo: `${SEED_MARK}:xfer-purchase:${i}`,
      });

      const qtySale = 18 + (i % 7);
      if (qtySale >= qtyPur) throw new Error(`행 ${i}: 매출 수량이 매입을 초과할 수 없습니다.`);
      const unitSale = Math.round((unitPur * 1.14 + (i % 5) * 15) * 100) / 100;
      const totalSale = Math.round(qtySale * unitSale * 100) / 100;
      const costAtSale = unitPur;

      let paymentStatus = 'unpaid';
      let paidAmount = 0;
      if (i % 3 === 1) {
        paymentStatus = 'partial';
        paidAmount = Math.round(totalSale * 0.38 * 100) / 100;
      } else if (i % 3 === 2) {
        paymentStatus = 'partial';
        paidAmount = Math.round(totalSale * 0.62 * 100) / 100;
      }

      const sale = await client.query(
        `INSERT INTO sale (user_id, partner_id, product_id, quantity, unit_price, cost_at_sale, total_amount, sale_date, payment_status, paid_amount, status, memo)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'active',$11)
         RETURNING id`,
        [
          userId,
          customerId,
          productId,
          qtySale,
          unitSale,
          costAtSale,
          totalSale,
          dayStr,
          paymentStatus,
          paidAmount,
          `${SEED_MARK}:sale:${i}`,
        ],
      );
      const saleId = sale.rows[0].id;

      await upsertInventoryDelta(client, userId, productId, -qtySale);
      await insertTransfer(client, {
        userId,
        productId,
        quantity: qtySale,
        actionType: 'sale',
        fromType: 'inventory',
        toType: 'customer',
        fromPartnerId: null,
        toPartnerId: customerId,
        beforeLocation: wh,
        afterLocation: accountLine(customer.name, customer.location),
        saleId,
        purchaseId,
        memo: `${SEED_MARK}:xfer-sale:${i}`,
      });

      await client.query(
        `INSERT INTO purchase_allocation (user_id, purchase_id, sale_id, quantity) VALUES ($1,$2,$3,$4)`,
        [userId, purchaseId, saleId, qtySale],
      );

      const qtyDisp = 2 + (i % 4);
      const rem = qtyPur - qtySale;
      if (qtyDisp > rem + 1e-9) {
        throw new Error(`행 ${i}: 폐기 수량이 잔여 재고를 초과합니다.`);
      }
      const dispDate = DAYS[(i + 2) % DAYS.length];

      await upsertInventoryDelta(client, userId, productId, -qtyDisp);
      const dIns = await client.query(
        `INSERT INTO disposal (user_id, product_id, quantity, disposal_date, reason, memo)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [userId, productId, qtyDisp, dispDate, '상품 변질', `${SEED_MARK}:disposal:${i}`],
      );
      const disposalId = dIns.rows[0].id;

      await insertTransfer(client, {
        userId,
        productId,
        quantity: qtyDisp,
        actionType: 'disposal',
        fromType: 'inventory',
        toType: 'disposal',
        fromPartnerId: null,
        toPartnerId: null,
        beforeLocation: wh,
        afterLocation: '폐기',
        disposalId,
        memo: `${SEED_MARK}:xfer-disposal:${i}`,
      });
    }

    await client.query('COMMIT');
    console.log('[seed-oper-april-flow-2026] 완료');
    console.log(`  user=${TARGET_AGENT_NO} · 출처=${SOURCE_NAME} · 기간 ${DAYS[0]} ~ ${DAYS[DAYS.length - 1]}`);
    console.log(`  매입 ${ROWS} · 매출+매입연결(흑자) ${ROWS} · 미수 매출 ${ROWS}(unpaid/partial) · 폐기 ${ROWS}`);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[seed-oper-april-flow-2026] 실패:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
