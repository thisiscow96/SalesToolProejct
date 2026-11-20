/**
 * 재고 기준 판매(선입선출 자동 배분) — T-205
 * - GET  /api/inventory/:productId/fifo-preview  저장 없이 배분·원가 미리보기(잠금 없음)
 * - POST /api/sales                              FIFO 판매 저장(items 1~20, 전부 아니면 전무)
 * - 매출 수량 정정(PATCH /api/sales/:id)에서 쓰는 도우미: prelockLotsForSale · adjustFifoSaleQty · assertFifoSaleDate
 *
 * 규칙(설계서 T-205_FIFO_설계.md):
 * - 유효 로트·판매 가능 수량은 뷰 inventory_lot_available(015)에서 읽는다(RULE-01).
 * - 배분 순서는 매입일·매입 id 오름차순, 판매일보다 늦은 매입은 쓰지 않는다(RULE-02).
 * - 부족하면 409 STOCK_SHORT, 아무것도 저장하지 않는다(RULE-04).
 * - 잠금 순서: 매입 행(id 오름차순) → 재고 행(product_id 오름차순) → 잠근 뒤 계산(RULE-14, T-103 8.1 공통 순서).
 * - 수량 계산은 DB NUMERIC 으로 한 문장에서 한다(RULE-15). JS 로 수량을 빼거나 더하지 않는다.
 */

const MAX_ITEMS = 20;
const MEMO_MAX = 500;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidYmd(s) {
  if (!YMD_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** API 오류 — { ok:false, code, message, detail } 로 응답(T-103 corrError 와 같은 모양) */
function fifoError(httpStatus, code, message, detail) {
  return Object.assign(new Error(message), { httpStatus, corrCode: code, detail: detail ?? undefined });
}

function sendFifoError(res, err, fallbackMessage) {
  if (err && err.httpStatus) {
    const body = { ok: false, code: err.corrCode, message: err.message };
    if (err.detail !== undefined) body.detail = err.detail;
    return res.status(err.httpStatus).json(body);
  }
  if (err && err.code === 'NEGATIVE_INVENTORY') {
    return res.status(409).json({ ok: false, code: 'STOCK_SHORT', message: '재고가 부족합니다. 다시 불러온 뒤 시도하세요.' });
  }
  console.error(fallbackMessage, err);
  // 500 은 DB 오류 문구를 그대로 내보내지 않는다(전환 API 와 같음)
  return res.status(500).json({ ok: false, message: fallbackMessage });
}

function readPositiveInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 && String(n) === String(v).trim() ? n : null;
}

function readQtyText(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? s : null;
}

function readPriceText(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? s : null;
}

/** 선택 필터: 매입처 id(RULE-05) — 비었으면 null, 잘못되면 throw */
function readFilters(src, fieldPrefix) {
  const out = { partnerId: null, sourceName: null };
  const pf = src?.partner_id_filter;
  if (pf !== undefined && pf !== null && pf !== '') {
    const n = readPositiveInt(pf);
    if (!n) throw fifoError(400, 'VALIDATION', '매입처 한정 값이 올바르지 않습니다.', { field: `${fieldPrefix}partner_id_filter` });
    out.partnerId = n;
  }
  const sf = src?.source_name_filter;
  if (sf !== undefined && sf !== null && String(sf).trim() !== '') {
    out.sourceName = String(sf).trim().slice(0, 200);
  }
  return out;
}

/**
 * FIFO 배분 계산(설계서 5.2 SQL) — 잠금은 호출하는 쪽 책임. 같은 트랜잭션 안의 앞 품목 결과도 본다.
 * 반환 rows: purchase_id, purchase_date(YYYY-MM-DD), unit_price(text), take(text), cost(text), partner_name, source_name
 * + took(text, 배분 합), enough(bool)
 */
async function pickFifoLots(client, { userId, productId, quantity, saleDate, partnerId = null, sourceName = null }) {
  const r = await client.query(
    `WITH a AS (
       SELECT v.*, SUM(v.available) OVER (ORDER BY v.purchase_date, v.purchase_id) - v.available AS before_av
       FROM inventory_lot_available v
       WHERE v.user_id = $1 AND v.product_id = $2 AND v.available > 0 AND v.purchase_date <= $4::date
         AND ($5::int IS NULL OR v.partner_id = $5::int)
         AND ($6::text IS NULL OR v.source_name = $6::text)
     ), p AS (
       SELECT a.purchase_id, a.purchase_date, a.unit_price, a.partner_id, a.source_name,
              LEAST(a.available, $3::numeric - a.before_av) AS take
       FROM a WHERE a.before_av < $3::numeric
     )
     SELECT p.purchase_id, to_char(p.purchase_date, 'YYYY-MM-DD') AS purchase_date,
            p.unit_price::text AS unit_price, p.take::text AS take,
            ROUND(p.take * p.unit_price, 2)::text AS cost,
            NULLIF(BTRIM(acc.name::text), '') AS partner_name,
            NULLIF(BTRIM(p.source_name::text), '') AS source_name
     FROM p
     LEFT JOIN account acc ON acc.id = p.partner_id AND acc.user_id = $1
     ORDER BY p.purchase_date, p.purchase_id`,
    [userId, productId, String(quantity), saleDate, partnerId, sourceName]
  );
  const s = await client.query(
    `SELECT COALESCE(SUM(t), 0)::text AS took, COALESCE(SUM(t), 0) >= $2::numeric AS enough
     FROM unnest($1::numeric[]) AS t`,
    [r.rows.map((x) => x.take), String(quantity)]
  );
  return { rows: r.rows, took: s.rows[0].took, enough: s.rows[0].enough };
}

/**
 * 판매 가능 요약(RULE-03): 재고·판매 가능(판매일·필터 기준)·매입 미연결 수량
 * unlinked = MAX(0, 재고 − 로트 합) — 반품으로 들어온 재고처럼 매입과 연결이 없는 수량
 */
async function stockSummary(client, { userId, productId, saleDate, partnerId = null, sourceName = null }) {
  const r = await client.query(
    `SELECT COALESCE(i.quantity, 0)::text AS inventory_qty,
            COALESCE(l.sellable, 0)::text AS sellable_qty,
            GREATEST(0, COALESCE(i.quantity, 0) - COALESCE(l.lot_total, 0))::text AS unlinked_qty
     FROM (SELECT 1) one
     LEFT JOIN inventory i ON i.user_id = $1 AND i.product_id = $2
     LEFT JOIN LATERAL (
       SELECT MAX(v.lot_total) AS lot_total,
              SUM(v.available) FILTER (
                WHERE v.purchase_date <= $3::date
                  AND ($4::int IS NULL OR v.partner_id = $4::int)
                  AND ($5::text IS NULL OR v.source_name = $5::text)
              ) AS sellable
       FROM inventory_lot_available v
       WHERE v.user_id = $1 AND v.product_id = $2
     ) l ON true`,
    [userId, productId, saleDate, partnerId, sourceName]
  );
  const x = r.rows[0];
  return { inventory_qty: Number(x.inventory_qty), sellable_qty: Number(x.sellable_qty), unlinked_qty: Number(x.unlinked_qty) };
}

/** 원가·이익 요약(RULE-08) — 금액은 DB 에서 계산한 2자리 값을 더한다 */
async function moneySummary(client, { quantity, unitPrice, costs, costQty }) {
  // 평균 원가는 배분된 수량(costQty, 기본 = 판매 수량)으로 나눈다 — 미리보기에서 재고가 모자랄 때도 로트 원가 평균이 맞게
  const r = await client.query(
    `WITH c AS (SELECT COALESCE(SUM(x), 0) AS cost FROM unnest($3::numeric[]) AS x),
          s AS (SELECT ROUND(ROUND($1::numeric, 3) * ROUND($2::numeric, 2), 2) AS amt, ROUND($4::numeric, 3) AS q, ROUND($2::numeric, 2) AS up)
     SELECT s.amt::text AS sale_amount, c.cost::text AS cost, (s.amt - c.cost)::text AS profit,
            CASE WHEN s.amt > 0 THEN ROUND((s.amt - c.cost) * 100 / s.amt, 1) END::text AS margin_pct,
            CASE WHEN s.q > 0 THEN ROUND(c.cost / s.q, 2) END::text AS avg_cost,
            (s.q > 0 AND s.up < c.cost / s.q) AS below_cost
     FROM s, c`,
    [String(quantity), String(unitPrice), costs, String(costQty ?? quantity)]
  );
  const x = r.rows[0];
  return {
    sale_amount: Number(x.sale_amount),
    cost: Number(x.cost),
    profit: Number(x.profit),
    margin_pct: x.margin_pct == null ? null : Number(x.margin_pct),
    avg_cost: x.avg_cost == null ? null : Number(x.avg_cost),
    below_cost: !!x.below_cost,
  };
}

function shortMessage(productName, sum) {
  let m = `${productName || '상품'} 재고가 부족합니다. 지금 팔 수 있는 수량은 ${sum.sellable_qty}입니다.`;
  if (sum.unlinked_qty > 0) {
    m += ` 반품으로 들어온 ${sum.unlinked_qty}은(는) 매입과 연결이 없어 자동 판매할 수 없습니다.`;
  }
  return m;
}

/** 이 회원의 유효 로트(잔량 > 0) 매입 행을 id 오름차순으로 잠근다 — 품목 전체를 한꺼번에(8장 5) */
async function lockLotsOfProducts(client, userId, productIds, extraPurchaseIds = []) {
  const ids = [...new Set(productIds)];
  const lots = await client.query(
    `SELECT purchase_id FROM inventory_lot_available WHERE user_id = $1 AND product_id = ANY($2::int[])`,
    [userId, ids]
  );
  const pids = [...new Set([...lots.rows.map((r) => r.purchase_id), ...extraPurchaseIds])].sort((a, b) => a - b);
  if (pids.length) {
    await client.query(`SELECT id FROM purchase WHERE user_id = $1 AND id = ANY($2::int[]) ORDER BY id FOR UPDATE`, [userId, pids]);
  }
  return pids;
}

async function lockInventory(client, userId, productIds) {
  const ids = [...new Set(productIds)].sort((a, b) => a - b);
  await client.query(
    `SELECT product_id FROM inventory WHERE user_id = $1 AND product_id = ANY($2::int[]) ORDER BY product_id FOR UPDATE`,
    [userId, ids]
  );
}

/**
 * 매출 수량 정정 전에 부르는 잠금(RULE-10·14): 그 매출 상품의 유효 로트 + 이미 배분된 매입을 id 순으로 먼저 잠근다.
 * 그 뒤 lockSaleForCorrection 이 같은 매입을 다시 잠가도(이미 가진 잠금) 순서가 "매입 → 매출 → 재고"로 유지된다.
 */
async function prelockLotsForSale(client, userId, saleId) {
  const s = await client.query(`SELECT product_id FROM sale WHERE id = $1 AND user_id = $2`, [saleId, userId]);
  if (!s.rows[0]) return;
  const al = await client.query(`SELECT DISTINCT purchase_id FROM purchase_allocation WHERE sale_id = $1 AND user_id = $2`, [saleId, userId]);
  await lockLotsOfProducts(client, userId, [s.rows[0].product_id], al.rows.map((r) => r.purchase_id));
}

/** 이 매출에 RULE-10(FIFO 수량 정정)을 쓸지 — fifo 로 만든 매출이거나 배분이 여러 행 */
async function usesFifoQtyRule(client, saleId, allocations) {
  if (allocations.length > 1) return true;
  const r = await client.query(`SELECT entry_mode FROM sale WHERE id = $1`, [saleId]);
  return r.rows[0]?.entry_mode === 'fifo';
}

/**
 * RULE-10 수량 정정: 줄이면 최근 로트(매입일·id 내림차순) 배분부터 줄이고 0 이 되면 행 삭제,
 * 늘리면 늘린 만큼 FIFO 로 추가 배분(이미 배분된 로트를 우선하지 않음). 재고 ±, 이동 이력 correction 을 배분 행마다.
 * 호출 전: prelockLotsForSale → lockSaleForCorrection 으로 매입·매출 잠금 완료. 여기서 재고를 잠근다.
 * h: { upsertInventoryDelta, insertTransfer, wh, custLoc, memo, partnerId(현재), saleDate(정정 후) }
 */
async function adjustFifoSaleQty(client, { userId, sale, newQty, delta, h }) {
  await lockInventory(client, userId, [sale.product_id]);
  const inc = await client.query(`SELECT $1::numeric > 0 AS inc`, [delta]);
  if (inc.rows[0].inc) {
    const pick = await pickFifoLots(client, { userId, productId: sale.product_id, quantity: delta, saleDate: h.saleDate });
    if (!pick.enough) {
      const sum = await stockSummary(client, { userId, productId: sale.product_id, saleDate: h.saleDate });
      const mx = await client.query(`SELECT ($1::numeric + $2::numeric)::text AS m`, [sale.quantity, String(sum.sellable_qty)]);
      throw fifoError(409, 'STOCK_SHORT', `재고가 부족합니다. 최대 ${Number(mx.rows[0].m)}까지 바꿀 수 있습니다.`, {
        max_qty: Number(mx.rows[0].m),
        sellable_qty: sum.sellable_qty,
        unlinked_qty: sum.unlinked_qty,
      });
    }
    for (const lot of pick.rows) {
      const up = await client.query(
        `UPDATE purchase_allocation SET quantity = quantity + $1::numeric
         WHERE id = (SELECT id FROM purchase_allocation WHERE sale_id = $2 AND purchase_id = $3 AND user_id = $4 ORDER BY id LIMIT 1)
         RETURNING id`,
        [lot.take, sale.id, lot.purchase_id, userId]
      );
      if (up.rowCount === 0) {
        await client.query(
          `INSERT INTO purchase_allocation (user_id, purchase_id, sale_id, quantity) VALUES ($1,$2,$3,$4::numeric)`,
          [userId, lot.purchase_id, sale.id, lot.take]
        );
      }
      await h.insertTransfer(client, {
        userId, productId: sale.product_id, quantity: lot.take, actionType: 'correction',
        fromType: 'inventory', toType: 'customer', toPartnerId: h.partnerId,
        beforeLocation: h.wh, afterLocation: h.custLoc, saleId: sale.id, purchaseId: lot.purchase_id, memo: h.memo,
      });
    }
    await h.upsertInventoryDelta(client, userId, sale.product_id, `-${delta}`);
  } else {
    const back = String(delta).replace(/^-/, '');
    const cut = await client.query(
      `WITH a AS (
         SELECT pa.id, pa.purchase_id, pa.quantity,
                SUM(pa.quantity) OVER (ORDER BY pu.purchase_date DESC, pu.id DESC, pa.id DESC) - pa.quantity AS before_new
         FROM purchase_allocation pa JOIN purchase pu ON pu.id = pa.purchase_id
         WHERE pa.sale_id = $1 AND pa.user_id = $2
       )
       SELECT id, purchase_id, LEAST(quantity, $3::numeric - before_new)::text AS cut,
              LEAST(quantity, $3::numeric - before_new) >= quantity AS whole
       FROM a WHERE before_new < $3::numeric ORDER BY before_new`,
      [sale.id, userId, back]
    );
    for (const c of cut.rows) {
      if (c.whole) {
        await client.query(`DELETE FROM purchase_allocation WHERE id = $1`, [c.id]);
      } else {
        await client.query(`UPDATE purchase_allocation SET quantity = quantity - $1::numeric WHERE id = $2`, [c.cut, c.id]);
      }
      await h.insertTransfer(client, {
        userId, productId: sale.product_id, quantity: c.cut, actionType: 'correction',
        fromType: 'customer', toType: 'inventory', fromPartnerId: sale.partner_id,
        beforeLocation: h.custLoc, afterLocation: h.wh, saleId: sale.id, purchaseId: c.purchase_id, memo: h.memo,
      });
    }
    await h.upsertInventoryDelta(client, userId, sale.product_id, back);
  }
  // 배분 합 = 매출 수량 확인(어긋나면 저장하지 않는다)
  const chk = await client.query(
    `SELECT COALESCE(SUM(quantity), 0) = $2::numeric AS ok FROM purchase_allocation WHERE sale_id = $1`,
    [sale.id, newQty]
  );
  if (!chk.rows[0].ok) throw new Error('FIFO 정정 배분 합이 매출 수량과 다릅니다.');
}

/**
 * RULE-11: FIFO 매출의 판매일은 배분된 로트의 가장 늦은 매입일보다 앞설 수 없다.
 * (전환 매출은 지금 규칙 그대로 — T-103 AC-24 가 전환 매출 판매일을 매입일 전날로 옮기는 것을 허용한다)
 */
async function assertFifoSaleDate(client, { userId, saleId, saleDate }) {
  const r = await client.query(
    `SELECT s.entry_mode, to_char(MAX(pu.purchase_date), 'YYYY-MM-DD') AS latest
     FROM sale s
     LEFT JOIN purchase_allocation pa ON pa.sale_id = s.id AND pa.user_id = s.user_id
     LEFT JOIN purchase pu ON pu.id = pa.purchase_id
     WHERE s.id = $1 AND s.user_id = $2
     GROUP BY s.entry_mode`,
    [saleId, userId]
  );
  const x = r.rows[0];
  if (!x || x.entry_mode !== 'fifo' || !x.latest) return;
  if (saleDate < x.latest) {
    throw fifoError(409, 'DATE_BEFORE_PURCHASE', `판매일은 이 매출에 배분된 매입의 가장 늦은 매입일(${x.latest}) 이후여야 합니다.`, {
      field: 'sale_date',
      min_sale_date: x.latest,
    });
  }
}

/**
 * 라우트 등록. deps: { pool, getUserId, kstToday, connectOr503, upsertInventoryDelta, insertTransfer,
 *   getUserWarehouseLabel, accountLocationLine, SALE_PARTNER_TYPES }
 * index.js 에서 위 함수·상수가 모두 정의된 뒤에 부른다.
 */
function registerFifoRoutes(app, deps) {
  const {
    pool, getUserId, kstToday, connectOr503, upsertInventoryDelta, insertTransfer,
    getUserWarehouseLabel, accountLocationLine, SALE_PARTNER_TYPES,
  } = deps;

  // ---------- 5.1 미리보기 ----------
  app.get('/api/inventory/:productId/fifo-preview', async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
    try {
      const productId = readPositiveInt(req.params.productId);
      if (!productId) throw fifoError(400, 'VALIDATION', '상품 ID가 올바르지 않습니다.', { field: 'productId' });
      const qty = readQtyText(req.query.quantity);
      if (!qty) throw fifoError(400, 'VALIDATION', '수량은 0보다 커야 합니다.', { field: 'quantity' });
      const priceRaw = req.query.unit_price;
      const price = priceRaw === undefined || priceRaw === '' ? '0' : readPriceText(priceRaw);
      if (price === null) throw fifoError(400, 'VALIDATION', '단가는 0 이상이어야 합니다.', { field: 'unit_price' });
      const saleDate = req.query.sale_date ? String(req.query.sale_date).trim() : kstToday();
      if (!isValidYmd(saleDate)) throw fifoError(400, 'VALIDATION', '날짜는 YYYY-MM-DD 형식으로 입력하세요.', { field: 'sale_date' });
      const f = readFilters(req.query, '');

      const pr = await pool.query(`SELECT id, name FROM product WHERE id = $1`, [productId]);
      if (!pr.rows[0]) throw fifoError(404, 'NOT_FOUND', '상품을 찾을 수 없습니다.');
      const client = await connectOr503(res);
      if (!client) return undefined;
      try {
        const n = (await client.query(`SELECT ROUND($1::numeric, 3)::text AS q, ROUND($2::numeric, 2)::text AS p`, [qty, price])).rows[0];
        if (!(Number(n.q) > 0)) throw fifoError(400, 'VALIDATION', '수량은 0보다 커야 합니다.', { field: 'quantity' });
        const sum = await stockSummary(client, { userId, productId, saleDate, partnerId: f.partnerId, sourceName: f.sourceName });
        const pick = await pickFifoLots(client, { userId, productId, quantity: n.q, saleDate, partnerId: f.partnerId, sourceName: f.sourceName });
        const money = await moneySummary(client, { quantity: n.q, unitPrice: n.p, costs: pick.rows.map((x) => x.cost), costQty: pick.took });
        const short = (await client.query(`SELECT GREATEST(0, $1::numeric - $2::numeric)::text AS s`, [n.q, pick.took])).rows[0].s;
        return res.json({
          ok: true,
          data: {
            product_id: productId,
            product_name: pr.rows[0].name,
            sale_date: saleDate,
            quantity: Number(n.q),
            unit_price: Number(n.p),
            ...sum,
            enough: !!pick.enough,
            short_qty: Number(short),
            allocations: pick.rows.map((x) => ({
              purchase_id: x.purchase_id,
              purchase_date: x.purchase_date,
              partner_name: x.partner_name,
              source_name: x.source_name,
              quantity: Number(x.take),
              unit_cost: Number(x.unit_price),
              cost: Number(x.cost),
            })),
            ...money,
          },
        });
      } finally {
        client.release();
      }
    } catch (err) {
      return sendFifoError(res, err, '판매 미리보기를 불러오지 못했습니다.');
    }
  });

  // ---------- 5.2 FIFO 판매 저장 ----------
  app.post('/api/sales', async (req, res) => {
    const userId = await getUserId(req);
    if (!userId) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
    const body = req.body || {};
    let partnerId;
    let saleDate;
    let memo;
    let items;
    try {
      partnerId = readPositiveInt(body.partner_id);
      if (!partnerId) throw fifoError(400, 'VALIDATION', '판매처를 선택하세요.', { field: 'partner_id' });
      saleDate = body.sale_date === undefined || body.sale_date === null || body.sale_date === '' ? kstToday() : String(body.sale_date).trim();
      if (!isValidYmd(saleDate)) throw fifoError(400, 'VALIDATION', '판매일은 YYYY-MM-DD 형식으로 입력하세요.', { field: 'sale_date' });
      memo = body.memo != null && String(body.memo).trim() ? String(body.memo).trim() : null;
      if (memo && memo.length > MEMO_MAX) throw fifoError(400, 'VALIDATION', `메모는 ${MEMO_MAX}자 이내로 입력하세요.`, { field: 'memo' });
      const raw = Array.isArray(body.items) ? body.items : null;
      if (!raw || raw.length === 0) throw fifoError(400, 'VALIDATION', '판매할 품목을 입력하세요.', { field: 'items' });
      if (raw.length > MAX_ITEMS) throw fifoError(400, 'VALIDATION', `한 번에 ${MAX_ITEMS}개 품목까지 판매할 수 있습니다.`, { field: 'items' });
      items = raw.map((it, i) => {
        const productId = readPositiveInt(it?.product_id);
        if (!productId) throw fifoError(400, 'VALIDATION', `${i + 1}번째 품목의 상품을 선택하세요.`, { field: `items[${i}].product_id` });
        const quantity = readQtyText(it?.quantity);
        if (!quantity) throw fifoError(400, 'VALIDATION', `${i + 1}번째 품목의 수량은 0보다 커야 합니다.`, { field: `items[${i}].quantity` });
        const unitPrice = readPriceText(it?.unit_price);
        if (unitPrice === null) throw fifoError(400, 'VALIDATION', `${i + 1}번째 품목의 단가는 0 이상이어야 합니다.`, { field: `items[${i}].unit_price` });
        return { productId, quantity, unitPrice, ...readFilters(it, `items[${i}].`) };
      });
    } catch (err) {
      return sendFifoError(res, err, '판매 저장에 실패했습니다.');
    }

    const client = await connectOr503(res);
    if (!client) return undefined;
    try {
      await client.query('BEGIN');
      // 판매처: 남의 것·없는 것은 404(존재를 알려 주지 않음), 판매 불가 유형은 400(전환과 같은 문구)
      const acc = await client.query(`SELECT id, type, name, location, address FROM account WHERE id = $1 AND user_id = $2`, [partnerId, userId]);
      const cust = acc.rows[0];
      if (!cust) throw fifoError(404, 'NOT_FOUND', '판매처를 찾을 수 없습니다.');
      if (!SALE_PARTNER_TYPES.has(cust.type)) throw fifoError(400, 'PARTNER_TYPE', '판매 가능한 거래처를 선택하세요.', { field: 'partner_id' });

      const productIds = [...new Set(items.map((it) => it.productId))];
      const pr = await client.query(`SELECT id, name FROM product WHERE id = ANY($1::int[])`, [productIds]);
      const names = new Map(pr.rows.map((r) => [r.id, r.name]));
      const missing = items.findIndex((it) => !names.has(it.productId));
      if (missing >= 0) throw fifoError(400, 'VALIDATION', '상품을 찾을 수 없습니다.', { field: `items[${missing}].product_id` });

      // RULE-14: ①② 모든 품목의 로트를 한꺼번에 id 순으로 잠금 → ③ 재고 product_id 순으로 잠금
      await lockLotsOfProducts(client, userId, productIds);
      await lockInventory(client, userId, productIds);

      const wh = await getUserWarehouseLabel(client, userId);
      const custLoc = accountLocationLine(cust);
      const created = [];
      for (let i = 0; i < items.length; i += 1) {
        const it = items[i];
        const n = (await client.query(
          `SELECT ROUND($1::numeric, 3)::text AS qty, ROUND($2::numeric, 2)::text AS price,
                  ROUND(ROUND($1::numeric, 3) * ROUND($2::numeric, 2), 2)::text AS total`,
          [it.quantity, it.unitPrice]
        )).rows[0];
        if (!(Number(n.qty) > 0)) throw fifoError(400, 'VALIDATION', `${i + 1}번째 품목의 수량은 0보다 커야 합니다.`, { field: `items[${i}].quantity` });
        // ④ 잠근 상태에서 계산 — 같은 트랜잭션의 앞 품목 배분·재고 감소가 반영된다
        const pick = await pickFifoLots(client, {
          userId, productId: it.productId, quantity: n.qty, saleDate, partnerId: it.partnerId, sourceName: it.sourceName,
        });
        if (!pick.enough) {
          const sum = await stockSummary(client, { userId, productId: it.productId, saleDate, partnerId: it.partnerId, sourceName: it.sourceName });
          throw fifoError(409, 'STOCK_SHORT', shortMessage(names.get(it.productId), sum), {
            item_index: i,
            product_id: it.productId,
            requested_qty: Number(n.qty),
            ...sum,
          });
        }
        // ⑤ 매출 1건 + 배분 N행 + 이동 N행 + 재고 감소
        const ins = await client.query(
          `INSERT INTO sale (user_id, partner_id, product_id, quantity, unit_price, total_amount, sale_date,
                             payment_status, paid_amount, status, memo, entry_mode)
           VALUES ($1,$2,$3,$4::numeric,$5::numeric,$6::numeric,$7::date,'unpaid',0,'active',$8,'fifo')
           RETURNING id`,
          [userId, partnerId, it.productId, n.qty, n.price, n.total, saleDate, memo]
        );
        const saleId = ins.rows[0].id;
        for (const lot of pick.rows) {
          await client.query(
            `INSERT INTO purchase_allocation (user_id, purchase_id, sale_id, quantity) VALUES ($1,$2,$3,$4::numeric)`,
            [userId, lot.purchase_id, saleId, lot.take]
          );
          await insertTransfer(client, {
            userId,
            productId: it.productId,
            quantity: lot.take,
            actionType: 'sale',
            fromType: 'inventory',
            toType: 'customer',
            fromPartnerId: null,
            toPartnerId: partnerId,
            beforeLocation: wh,
            afterLocation: custLoc,
            saleId,
            purchaseId: lot.purchase_id,
            memo,
          });
        }
        await upsertInventoryDelta(client, userId, it.productId, `-${n.qty}`);
        const money = await moneySummary(client, { quantity: n.qty, unitPrice: n.price, costs: pick.rows.map((x) => x.cost) });
        created.push({
          sale_id: saleId,
          product_id: it.productId,
          product_name: names.get(it.productId),
          quantity: Number(n.qty),
          unit_price: Number(n.price),
          total_amount: Number(n.total),
          cost: money.cost,
          profit: money.profit,
          margin_pct: money.margin_pct,
          avg_cost: money.avg_cost,
          below_cost: money.below_cost,
          allocations: pick.rows.map((x) => ({
            purchase_id: x.purchase_id,
            purchase_date: x.purchase_date,
            quantity: Number(x.take),
            unit_cost: Number(x.unit_price),
            cost: Number(x.cost),
          })),
        });
      }
      await client.query('COMMIT');
      return res.status(201).json({ ok: true, data: { partner_id: partnerId, sale_date: saleDate, sales: created } });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return sendFifoError(res, err, '판매 저장에 실패했습니다.');
    } finally {
      client.release();
    }
  });
}

module.exports = {
  registerFifoRoutes,
  pickFifoLots,
  stockSummary,
  prelockLotsForSale,
  usesFifoQtyRule,
  adjustFifoSaleQty,
  assertFifoSaleDate,
};
