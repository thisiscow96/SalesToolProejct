const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const SEED_MARK = 'sample-seed-local-v1';
const TARGET_AGENT_NO = process.env.SAMPLE_AGENT_NO || 'admin001';

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

async function syncSalePaymentStatus(client, saleId) {
  await client.query(
    `UPDATE sale
     SET payment_status =
       CASE
         WHEN paid_amount >= total_amount THEN 'paid'::payment_status
         WHEN paid_amount > 0 THEN 'partial'::payment_status
         ELSE 'unpaid'::payment_status
       END,
       updated_at = NOW()
     WHERE id = $1`,
    [saleId]
  );
}

async function upsertInventoryDelta(client, userId, productId, delta) {
  const ex = await client.query(
    'SELECT id, quantity FROM inventory WHERE user_id = $1 AND product_id = $2 FOR UPDATE',
    [userId, productId]
  );
  if (!ex.rows[0]) {
    if (delta < 0) throw new Error(`재고 부족(product_id=${productId})`);
    await client.query('INSERT INTO inventory (user_id, product_id, quantity) VALUES ($1,$2,$3)', [userId, productId, delta]);
    return;
  }
  const next = Number(ex.rows[0].quantity) + Number(delta);
  if (next < 0) throw new Error(`재고 부족(product_id=${productId})`);
  await client.query('UPDATE inventory SET quantity = $1, updated_at = NOW() WHERE id = $2', [next, ex.rows[0].id]);
}

async function insertTransfer(client, row) {
  await client.query(
    `INSERT INTO product_transfer (
       user_id, product_id, quantity, action_type, from_type, to_type,
       from_partner_id, to_partner_id, before_location, after_location,
       transferred_at, purchase_id, sale_id, disposal_id, refund_id, memo
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW(),$11,$12,$13,$14,$15)`,
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
      row.purchaseId ?? null,
      row.saleId ?? null,
      row.disposalId ?? null,
      row.refundId ?? null,
      row.memo ?? null,
    ]
  );
}

async function run() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const userQ = await client.query(
      'SELECT id, name, agent_no FROM "user" WHERE agent_no = $1 AND status = $2 LIMIT 1',
      [TARGET_AGENT_NO, 'active']
    );
    if (!userQ.rows[0]) throw new Error(`대상 사용자(${TARGET_AGENT_NO}) 없음`);
    const userId = userQ.rows[0].id;
    const warehouseLabel = `${userQ.rows[0].name} (중매 ${userQ.rows[0].agent_no})`;

    const seeded = await client.query(
      'SELECT COUNT(*)::int AS cnt FROM payment WHERE user_id = $1 AND memo LIKE $2',
      [userId, `${SEED_MARK}:payment%`]
    );
    if (seeded.rows[0].cnt > 0) {
      await client.query('ROLLBACK');
      console.log('[sample-transactions] 이미 생성됨(중복 방지).');
      return;
    }

    const sales = await client.query(
      `SELECT s.id, s.partner_id, s.product_id, s.quantity, s.total_amount, s.paid_amount,
              a.name AS partner_name, a.location
       FROM sale s
       JOIN account a ON a.id = s.partner_id
       WHERE s.user_id = $1 AND s.memo LIKE $2
       ORDER BY s.id`,
      [userId, `${SEED_MARK}:sale%`]
    );
    if (sales.rowCount < 3) throw new Error('샘플 매출이 부족합니다. seed-sample-local 먼저 실행하세요.');

    const payDate = new Date();
    // 1) 첫 매출: 전액 수금
    {
      const s = sales.rows[0];
      const amount = round2(Number(s.total_amount) - Number(s.paid_amount));
      const p = await client.query(
        `INSERT INTO payment (user_id, partner_id, amount, paid_at, entry_kind, memo)
         VALUES ($1,$2,$3,$4,'receive',$5)
         RETURNING id`,
        [userId, s.partner_id, amount, payDate, `${SEED_MARK}:payment-full`]
      );
      await client.query(
        'INSERT INTO payment_allocation (payment_id, sale_id, amount) VALUES ($1,$2,$3)',
        [p.rows[0].id, s.id, amount]
      );
      await client.query('UPDATE sale SET paid_amount = paid_amount + $1, updated_at = NOW() WHERE id = $2', [amount, s.id]);
      await syncSalePaymentStatus(client, s.id);
    }
    // 2) 둘째 매출: 반액 수금(부분)
    {
      const s = sales.rows[1];
      const remain = round2(Number(s.total_amount) - Number(s.paid_amount));
      const amount = round2(remain / 2);
      const p = await client.query(
        `INSERT INTO payment (user_id, partner_id, amount, paid_at, entry_kind, memo)
         VALUES ($1,$2,$3,$4,'receive',$5)
         RETURNING id`,
        [userId, s.partner_id, amount, payDate, `${SEED_MARK}:payment-partial`]
      );
      await client.query(
        'INSERT INTO payment_allocation (payment_id, sale_id, amount) VALUES ($1,$2,$3)',
        [p.rows[0].id, s.id, amount]
      );
      await client.query('UPDATE sale SET paid_amount = paid_amount + $1, updated_at = NOW() WHERE id = $2', [amount, s.id]);
      await syncSalePaymentStatus(client, s.id);
    }

    // 3) 첫 매출 일부 환불 (반품 입고 + 환불금 기록)
    {
      const s = sales.rows[0];
      const refundQty = Number(s.quantity) >= 0.5 ? 0.5 : Number(s.quantity) / 2;
      const refundAmount = round2((refundQty / Number(s.quantity)) * Number(s.total_amount));
      await upsertInventoryDelta(client, userId, s.product_id, refundQty);
      const rf = await client.query(
        `INSERT INTO refund (user_id, sale_id, quantity, refund_amount, reason, refunded_at, memo)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id`,
        [userId, s.id, refundQty, refundAmount, '샘플 환불', new Date().toISOString().slice(0, 10), `${SEED_MARK}:refund`]
      );
      await insertTransfer(client, {
        userId,
        productId: s.product_id,
        quantity: refundQty,
        actionType: 'refund',
        fromType: 'customer',
        toType: 'inventory',
        fromPartnerId: s.partner_id,
        beforeLocation: `${s.partner_name}${s.location ? ` · ${s.location}` : ''}`,
        afterLocation: warehouseLabel,
        saleId: s.id,
        refundId: rf.rows[0].id,
        memo: `${SEED_MARK}:transfer-refund`,
      });
      await client.query(
        `INSERT INTO payment (user_id, partner_id, amount, paid_at, entry_kind, memo)
         VALUES ($1,$2,$3,$4,'refund',$5)`,
        [userId, s.partner_id, refundAmount, payDate, `${SEED_MARK}:payment-refund`]
      );
      await client.query('UPDATE sale SET paid_amount = GREATEST(0, paid_amount - $1), updated_at = NOW() WHERE id = $2', [refundAmount, s.id]);
      await syncSalePaymentStatus(client, s.id);
    }

    // 4) 폐기 샘플 2건 (정책: 부분 폐기 X, 해당 상품 현재 재고 전량 폐기)
    {
      const targets = sales.rows.slice(0, 2);
      for (const t of targets) {
        const inv = await client.query(
          'SELECT quantity FROM inventory WHERE user_id = $1 AND product_id = $2 FOR UPDATE',
          [userId, t.product_id]
        );
        const qty = Number(inv.rows[0]?.quantity || 0);
        if (!(qty > 0)) continue;
        await upsertInventoryDelta(client, userId, t.product_id, -qty);
        const d = await client.query(
          `INSERT INTO disposal (user_id, product_id, quantity, disposal_date, reason, memo)
           VALUES ($1,$2,$3,$4,$5,$6)
           RETURNING id`,
          [userId, t.product_id, qty, new Date().toISOString().slice(0, 10), '상품 폐기', `${SEED_MARK}:disposal`]
        );
        await insertTransfer(client, {
          userId,
          productId: t.product_id,
          quantity: qty,
          actionType: 'disposal',
          fromType: 'inventory',
          toType: 'disposal',
          beforeLocation: warehouseLabel,
          afterLocation: '폐기',
          disposalId: d.rows[0].id,
          memo: `${SEED_MARK}:transfer-disposal`,
        });
      }
    }

    await client.query('COMMIT');

    const stats = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM sale WHERE user_id = $1 AND memo LIKE $2) AS sale_cnt,
         (SELECT COUNT(*) FROM payment WHERE user_id = $1 AND memo LIKE $3) AS payment_cnt,
         (SELECT COUNT(*) FROM refund WHERE user_id = $1 AND memo LIKE $4) AS refund_cnt,
         (SELECT COUNT(*) FROM disposal WHERE user_id = $1 AND memo LIKE $5) AS disposal_cnt`,
      [userId, `${SEED_MARK}:sale%`, `${SEED_MARK}:payment%`, `${SEED_MARK}:refund%`, `${SEED_MARK}:disposal%`]
    );
    console.log('[sample-transactions] 완료', stats.rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[sample-transactions] 실패:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

run();
