'use strict';
/**
 * T-203 매입전환 서비스 (설계 3.6·3.7, R-127·R-128·R-130)
 *
 * 매입 한 건 만들기 = 기존 매입 등록 핸들러(POST /api/purchases)를 같은 트랜잭션에서 그대로 부른다(검증 규칙 복제 없음 — T-402 와 같은 방식).
 *   권한 표(lib/access.js)도 다시 거친다 → 직원이 보낸 요청이면 직원 권한으로, 매입의 created_by_staff_id 도 그대로 남는다.
 * 이중 매입 0 보장(마지막 방어선은 DB):
 *   ① Idempotency-Key(api_idempotency)  ② 회원별 advisory lock 'purchase-doc-convert:'+user  ③ 줄 FOR UPDATE
 *   ④ purchase_doc_conversion (line_id) ACTIVE 유일 · (user, trade_id) ACTIVE 유일 · purchase(purchase_doc_line_id) active 유일
 * 줄마다 SAVEPOINT — 한 줄 실패가 다른 줄을 되돌리지 않는다.
 */
const { bulkStore, makeBulkContext } = require('../excel-upload');
const engine = require('./engine');

const MAX_BATCH = 200;

// ---------------------------------------------------------------------------
// 같은 프로세스 안에서 기존 라우트 부르기 — 경로 변수(:id)도 넘긴다(excel-upload.invoke 는 params 가 없음)
// ---------------------------------------------------------------------------
function findRoute(app, method, pattern) {
  const m = method.toLowerCase();
  for (const layer of (app._router && app._router.stack) || []) {
    if (layer.route && layer.route.path === pattern && layer.route.methods[m]) {
      return layer.route.stack.filter((l) => !l.method || l.method === m).map((l) => l.handle);
    }
  }
  return null;
}

async function invokeRoute(cx, method, pattern, params, body) {
  const handlers = findRoute(cx.app, method, pattern);
  if (!handlers) throw new Error(`route not found ${method} ${pattern}`);
  const path = pattern.replace(/:([A-Za-z]+)/g, (_, k) => encodeURIComponent(String(params[k])));
  const parent = cx.req || { headers: {} };
  const headers = {
    'content-type': 'application/json',
    ...(cx.authorization ? { authorization: cx.authorization } : parent.headers.authorization ? { authorization: parent.headers.authorization } : {}),
  };
  const req = {
    method, url: path, originalUrl: path, path, baseUrl: '', body, query: {}, params: { ...params }, headers,
    ip: parent.ip, ips: parent.ips, socket: parent.socket, connection: parent.connection, protocol: parent.protocol,
    get(n) { return headers[String(n).toLowerCase()]; }, header(n) { return headers[String(n).toLowerCase()]; },
    purchaseDocConvert: true,
  };
  const res = {
    statusCode: 200, body: undefined, headersSent: false, locals: {},
    status(c) { this.statusCode = c; return this; }, set() { return this; }, setHeader() { return this; }, getHeader() { return undefined; }, type() { return this; },
    json(b) { this.body = b; this.headersSent = true; return this; }, send(b) { this.body = b; this.headersSent = true; return this; },
    sendStatus(c) { this.statusCode = c; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; },
  };
  const run = async () => {
    let passed = false;
    await cx.authorize(req, res, () => { passed = true; });
    if (!passed) return res;
    for (const h of handlers) {
      let nextCalled = false;
      // eslint-disable-next-line no-await-in-loop
      await h(req, res, () => { nextCalled = true; });
      if (res.headersSent || !nextCalled) break;
    }
    if (!res.headersSent) { res.statusCode = 500; res.body = { ok: false, message: '처리 결과가 없습니다.' }; }
    return res;
  };
  return bulkStore.run(cx.bulkCtx, run);
}

/** 바깥 트랜잭션 client 로 기존 핸들러를 돌릴 문맥 */
function withClient(cx, client) {
  if (!cx.bulkCtx || cx.bulkCtx.client !== client) cx.bulkCtx = makeBulkContext(client);
  return cx;
}

async function lockConvert(client, userId) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`purchase-doc-convert:${userId}`]);
}

const actorStaff = (cx) => (cx.actorKind === 'STAFF' ? cx.staffId : null);

/**
 * 줄 하나 → 매입 한 건 (SAVEPOINT 안). 바깥에서 줄은 이미 잠겨 있어야 한다.
 * @param a { line, trade|null, mode:'AUTO'|'MANUAL'|'FORCED', plan, tol, eventType, approveReason, diff, warnings }
 * @returns { result:'CONVERTED'|'ALREADY_CONVERTED'|'TRADE_TAKEN'|'PURCHASE_FAILED', purchase_id?, conversion_id?, code?, message?, detail? }
 */
async function convertOne(client, cx, a) {
  withClient(cx, client);
  const { line, trade, mode, plan } = a;
  const sp = `pdc_${line.id}_${Date.now() % 100000}`;
  // 이미 활성 전환이 있으면(다른 키·자동 전환과 겹침) 오류가 아니라 그 결과
  const act = await client.query(`SELECT id, purchase_id FROM purchase_doc_conversion WHERE line_id = $1 AND status = 'ACTIVE'`, [line.id]);
  if (act.rows[0]) return { result: 'ALREADY_CONVERTED', purchase_id: act.rows[0].purchase_id, conversion_id: Number(act.rows[0].id) };
  if (trade) {
    const tk = await client.query(
      `SELECT c.line_id, l.line_no, l.doc_id FROM purchase_doc_conversion c JOIN purchase_doc_line l ON l.id = c.line_id
        WHERE c.user_id = $1 AND c.trade_id = $2 AND c.status = 'ACTIVE'`,
      [cx.userId, trade.trade_id]
    );
    if (tk.rows[0]) return { result: 'TRADE_TAKEN', code: 'TRADE_TAKEN', message: `그 경락 건은 매입서 #${tk.rows[0].doc_id}-${tk.rows[0].line_no} 줄에 이미 쓰였습니다.` };
  }
  const doc = await client.query(`SELECT id, supplier_partner_id, doc_no FROM purchase_doc WHERE id = $1 AND user_id = $2`, [line.doc_id, cx.userId]);
  const d = doc.rows[0];
  await client.query(`SAVEPOINT ${sp}`);
  try {
    const body = {
      partner_id: d.supplier_partner_id,
      product_id: line.product_id,
      quantity: String(plan.quantity),
      unit_price: String(plan.unit_price),
      purchase_date: String(line.trade_date).slice(0, 10),
      memo: `매입서 #${line.doc_id}-${line.line_no}${trade ? ` · 경락 #${trade.trade_id}` : ''}`.slice(0, 200),
      source_name: (trade && trade.corp_name) || '가락시장 경매',
      payee: 'supplier',
    };
    const origin = line.origin_name || (trade && trade.origin_name) || null;
    if (origin) body.origin_region = String(origin).slice(0, 100);
    const r = await invokeRoute(cx, 'POST', '/api/purchases', {}, body);
    if (!(r.statusCode === 201 && r.body && r.body.ok)) {
      await client.query(`ROLLBACK TO SAVEPOINT ${sp}`);
      await client.query(`RELEASE SAVEPOINT ${sp}`);
      return { result: 'PURCHASE_FAILED', code: 'PURCHASE_FAILED', message: (r.body && r.body.message) || `매입 등록 실패(${r.statusCode})`,
        detail: { status: r.statusCode, code: r.body && r.body.code, field: r.body && r.body.field, message: r.body && r.body.message } };
    }
    const purchaseId = r.body.data.id;
    await client.query(`UPDATE purchase SET purchase_doc_line_id = $2 WHERE id = $1 AND user_id = $3`, [purchaseId, line.id, cx.userId]);
    const tot = await client.query(`SELECT total_amount, quantity, unit_price FROM purchase WHERE id = $1`, [purchaseId]);
    const warnings = [...new Set([...(a.warnings || []), ...(line.warning_flags || []).filter((w) => w !== 'BASE_REVISED')])];
    const conv = await client.query(
      `INSERT INTO purchase_doc_conversion (user_id, doc_id, line_id, trade_id, purchase_id, mode, status, match_result, match_score, doc_amount, purchase_total,
                                            amount_diff, price_diff, purchase_qty, purchase_unit_price, warning_flags, approve_reason, idempotency_key, actor_staff_id)
       VALUES ($1,$2,$3,$4,$5,$6,'ACTIVE',$7,$8,$9,$10, ($10::numeric - $9::numeric), $11, $12, $13, $14::text[], $15, $16, $17) RETURNING id, amount_diff`,
      [cx.userId, line.doc_id, line.id, trade ? trade.trade_id : null, purchaseId, mode, line.match_result || 'UNMATCHED', line.match_score ?? null, line.amount,
        tot.rows[0].total_amount, trade ? trade.price_diff : null, tot.rows[0].quantity, tot.rows[0].unit_price, warnings,
        a.approveReason || null, cx.idemKey || null, actorStaff(cx)]
    );
    const convId = Number(conv.rows[0].id);
    await client.query(
      `UPDATE purchase_doc_line SET status = 'CONVERTED', match_result = COALESCE(match_result, 'UNMATCHED'), product_id = $2,
              best_trade_id = COALESCE($3, best_trade_id), version = version + 1, updated_at = NOW() WHERE id = $1`,
      [line.id, line.product_id, trade ? trade.trade_id : null]
    );
    await client.query(
      `INSERT INTO purchase_match_event (user_id, doc_id, line_id, event_type, from_status, to_status, match_result, score, trade_id, purchase_id, conversion_id,
                                         reason, detail, actor_kind, actor_staff_id, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,'CONVERTED',$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15)`,
      [cx.userId, line.doc_id, line.id, a.eventType || 'CONVERT', line.status, line.match_result || null, line.match_score ?? null, trade ? trade.trade_id : null,
        purchaseId, convId, a.approveReason ? String(a.approveReason).slice(0, 200) : null,
        JSON.stringify({ mode, tolerance: a.tol ? engine.tolView(a.tol) : null, diff: a.diff || null, warnings,
          purchase: { quantity: tot.rows[0].quantity, unit_price: tot.rows[0].unit_price, total: tot.rows[0].total_amount, amount_diff: conv.rows[0].amount_diff, unit_kg: plan.unit_kg, line_kg: plan.line_kg } }),
        cx.actorKind, actorStaff(cx), cx.idemKey || null]
    );
    await client.query(`RELEASE SAVEPOINT ${sp}`);
    return { result: 'CONVERTED', purchase_id: purchaseId, conversion_id: convId, amount_diff: conv.rows[0].amount_diff, mode };
  } catch (err) {
    await client.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {});
    await client.query(`RELEASE SAVEPOINT ${sp}`).catch(() => {});
    if (err.code === '23505') {
      if (/trade_active/.test(err.constraint || err.message)) return { result: 'TRADE_TAKEN', code: 'TRADE_TAKEN', message: '그 경락 건은 다른 줄에 이미 쓰였습니다.' };
      const again = await client.query(`SELECT id, purchase_id FROM purchase_doc_conversion WHERE line_id = $1 AND status = 'ACTIVE'`, [line.id]);
      if (again.rows[0]) return { result: 'ALREADY_CONVERTED', purchase_id: again.rows[0].purchase_id, conversion_id: Number(again.rows[0].id) };
      return { result: 'ALREADY_CONVERTED' };
    }
    throw err;
  }
}

/** 줄 상세 재조회 — 후보 1위(best_trade_id) 를 줄 기준 비교값과 함께 */
async function bestCandidate(client, cx, line) {
  if (!line.best_trade_id) return null;
  const ev = await engine.evaluatePair(client, cx, line, line.best_trade_id);
  return ev.candidate ? { ...ev.candidate, tol: ev.tol } : null;
}

/**
 * R-127 단건·일괄 전환 — EXACT 이고 지금 다시 봐도 strict 통과 + 전환 가능한 줄만. 그 밖은 줄 결과 NEEDS_CONFIRM
 * @returns 응답 본문 data
 */
async function convertBatch(client, cx, lineIds) {
  withClient(cx, client);
  await lockConvert(client, cx.userId);
  const lines = await engine.lockLines(client, cx.userId, lineIds);
  const byId = new Map(lines.map((l) => [String(l.id), l]));
  const results = [];
  const docs = new Set();
  const productOf = await engine.resolveProductLinks(client, cx.userId);
  for (const id of lineIds) {
    const l = byId.get(String(id));
    if (!l) { results.push({ line_id: id, result: 'NOT_FOUND', code: 'NOT_FOUND', message: '줄을 찾을 수 없습니다.' }); continue; }
    if (l.doc_status === 'CANCELLED') { results.push({ line_id: id, result: 'LINE_NOT_CONVERTIBLE', code: 'DOC_CANCELLED', message: '취소된 매입서입니다.' }); continue; }
    if (l.status === 'CONVERTED') {
      // eslint-disable-next-line no-await-in-loop
      const a = await client.query(`SELECT id, purchase_id FROM purchase_doc_conversion WHERE line_id = $1 AND status = 'ACTIVE'`, [l.id]);
      results.push({ line_id: id, result: 'ALREADY_CONVERTED', purchase_id: a.rows[0] ? a.rows[0].purchase_id : null, conversion_id: a.rows[0] ? Number(a.rows[0].id) : null });
      continue;
    }
    if (l.status === 'REJECTED' || l.status === 'CANCELLED') { results.push({ line_id: id, result: 'LINE_NOT_CONVERTIBLE', code: 'LINE_NOT_CONVERTIBLE', message: '재대조를 먼저 하세요.' }); continue; }
    if (l.match_result !== 'EXACT' || l.status !== 'PENDING') {
      results.push({ line_id: id, result: 'NEEDS_CONFIRM', code: 'MATCH_NOT_EXACT', message: '부분일치 줄은 수동 확정(주인)으로 전환합니다.' });
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const c = await bestCandidate(client, cx, l);
    if (!c || !c.strict) { results.push({ line_id: id, result: 'NEEDS_CONFIRM', code: 'MATCH_NOT_EXACT', message: '대조 결과가 바뀌었습니다. 다시 대조하거나 수동 확정하세요.' }); continue; }
    let productId = l.product_id;
    if (!productId) { const link = productOf(l.item_key, l.grade_norm); productId = link ? link.product_id : null; }
    if (!productId) { results.push({ line_id: id, result: 'NO_PRODUCT_LINK', code: 'NO_PRODUCT_LINK', message: '판매툴 품목 연결이 없습니다(대조 설정 → 품목 연결).' }); continue; }
    if (!c.base_final) { results.push({ line_id: id, result: 'NEEDS_CONFIRM', code: 'BASE_NOT_FINAL', message: '그 날 확정 경락 데이터가 아직 없습니다(확정 수집 뒤 자동 재대조, 또는 주인 수동 확정).' }); continue; }
    if (c.source === 'MOCK' && !(String(process.env.ALLOW_MOCK_CONVERT || '').toLowerCase() === 'true')) {
      results.push({ line_id: id, result: 'NEEDS_CONFIRM', code: 'MOCK_SOURCE', message: '목업 경락으로는 매입 등록하지 않습니다.' }); continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const p = await client.query(`SELECT id, unit FROM product WHERE id = $1`, [productId]);
    // eslint-disable-next-line no-await-in-loop
    const plan = await engine.planPurchase(client, l, p.rows[0], c.tol);
    if (!plan.ok) { results.push({ line_id: id, result: 'NEEDS_CONFIRM', code: plan.reason, message: '단위 환산 차이가 허용 금액을 넘습니다. 수동 확정(주인)으로 전환하세요.' }); continue; }
    // eslint-disable-next-line no-await-in-loop
    const r = await convertOne(client, cx, { line: { ...l, product_id: productId }, trade: c, mode: 'MANUAL', plan, tol: c.tol, eventType: 'CONVERT', diff: engine.diffOf(l, c) });
    docs.add(String(l.doc_id));
    results.push({ line_id: id, ...r, amount_diff: r.amount_diff != null ? String(r.amount_diff) : undefined });
  }
  for (const d of docs) {
    // eslint-disable-next-line no-await-in-loop
    await client.query(`SELECT purchase_doc_recalc($1)`, [d]);
  }
  const converted = results.filter((r) => r.result === 'CONVERTED').length;
  const already = results.filter((r) => r.result === 'ALREADY_CONVERTED').length;
  return { results, summary: { converted, already, failed: results.length - converted - already } };
}

/**
 * R-128 수동 확정 (주인) — 허용오차 안(strict) = MANUAL, 밖·근거 없음 = FORCED(accept_diff + 사유 2자 이상)
 * @returns { status, body }
 */
async function confirmLine(client, cx, lineId, b) {
  withClient(cx, client);
  await lockConvert(client, cx.userId);
  const rows = await engine.lockLines(client, cx.userId, [lineId]);
  const l = rows[0];
  if (!l) return { status: 404, body: { ok: false, code: 'NOT_FOUND', message: '줄을 찾을 수 없습니다.' } };
  if (l.doc_status === 'CANCELLED') return { status: 409, body: { ok: false, code: 'DOC_CANCELLED', message: '취소된 매입서입니다.' } };
  if (l.status === 'CONVERTED') {
    const a = await client.query(`SELECT id, purchase_id FROM purchase_doc_conversion WHERE line_id = $1 AND status = 'ACTIVE'`, [l.id]);
    return { status: 200, body: { ok: true, data: { line_id: Number(l.id), result: 'ALREADY_CONVERTED', purchase_id: a.rows[0] ? a.rows[0].purchase_id : null } } };
  }
  if (!['PENDING', 'HOLD'].includes(l.status)) return { status: 409, body: { ok: false, code: 'LINE_NOT_CONVERTIBLE', message: '재대조를 먼저 하세요.' } };
  if (b.version != null && Number(b.version) !== Number(l.version)) {
    return { status: 409, body: { ok: false, code: 'VERSION_CONFLICT', message: '다른 사람이 이 줄을 먼저 바꿨습니다.', detail: { line: lineOut(l) } } };
  }
  const reason = b.reason != null ? String(b.reason).trim() : '';
  const tradeId = b.trade_id == null || b.trade_id === '' ? null : Number(b.trade_id);
  if (tradeId != null && !(Number.isInteger(tradeId) && tradeId > 0)) return { status: 400, body: { ok: false, code: 'VALIDATION', field: 'trade_id', message: '경락 건 번호가 올바르지 않습니다.' } };
  const productOf = await engine.resolveProductLinks(client, cx.userId);
  let productId = l.product_id;
  if (b.product_id != null) {
    const pr = await client.query(`SELECT id FROM product WHERE id = $1 AND (owner_user_id IS NULL OR owner_user_id = $2) AND NOT is_system`, [b.product_id, cx.userId]);
    if (!pr.rows[0]) return { status: 400, body: { ok: false, code: 'PRODUCT_NOT_FOUND', field: 'product_id', message: '품목을 찾을 수 없습니다.' } };
    productId = pr.rows[0].id;
  }
  if (!productId) { const link = productOf(l.item_key, l.grade_norm); productId = link ? link.product_id : null; }
  if (!productId) return { status: 400, body: { ok: false, code: 'NO_PRODUCT_LINK', field: 'product_id', message: '판매툴 품목 연결이 없습니다(대조 설정 → 품목 연결, 또는 product_id 지정).' } };
  const p = await client.query(`SELECT id, unit FROM product WHERE id = $1`, [productId]);

  let trade = null;
  let tol;
  let strict = false;
  let flags = [];
  if (tradeId) {
    const ev = await engine.evaluatePair(client, cx, l, tradeId);
    tol = ev.tol;
    if (!ev.candidate) {
      const ex = await client.query(`SELECT id FROM auction_trade WHERE id = $1`, [tradeId]);
      if (!ex.rows[0]) return { status: 404, body: { ok: false, code: 'NOT_FOUND', field: 'trade_id', message: '경락 건을 찾을 수 없습니다.' } };
      const tk = await client.query(
        `SELECT l.doc_id, l.line_no FROM purchase_doc_conversion c JOIN purchase_doc_line l ON l.id = c.line_id WHERE c.user_id = $1 AND c.trade_id = $2 AND c.status = 'ACTIVE'`,
        [cx.userId, tradeId]
      );
      if (tk.rows[0]) return { status: 409, body: { ok: false, code: 'TRADE_TAKEN', message: `그 경락 건은 매입서 #${tk.rows[0].doc_id}-${tk.rows[0].line_no} 줄에 이미 쓰였습니다.` } };
      return { status: 400, body: { ok: false, code: 'NOT_CANDIDATE', field: 'trade_id', message: '그 경락 건은 이 줄의 후보가 아닙니다(품목군·날짜 범위·법인 확인).' } };
    }
    trade = ev.candidate;
    strict = ev.candidate.strict;
    flags = ev.candidate.flags;
  } else {
    tol = engine.pickTolerance(await engine.loadTolerances(client, cx.userId), cx.userId, l.item_key);
  }
  const plan = await engine.planPurchase(client, l, p.rows[0], tol);
  const needForce = !tradeId || !strict || !plan.ok;
  const diff = trade ? engine.diffOf(l, trade) : null;
  if (needForce) {
    if (b.accept_diff !== true) {
      return { status: 400, body: { ok: false, code: 'DIFF_NOT_ACCEPTED', message: tradeId
        ? '허용오차를 넘는 차이가 있습니다. 차이를 확인했다면 accept_diff 와 사유를 함께 보내세요.'
        : '경락 근거 없이 등록하려면 accept_diff 와 사유를 함께 보내세요.',
      detail: { diff, flags, plan: { quantity: plan.quantity, unit_price: plan.unit_price, total: plan.total, amount_diff: plan.amount_diff, reason: plan.reason } } } };
    }
    if (reason.length < 2) return { status: 400, body: { ok: false, code: 'REASON_REQUIRED', field: 'reason', message: '사유를 2자 이상 입력하세요.' } };
  }
  if (reason.length > 200) return { status: 400, body: { ok: false, code: 'VALIDATION', field: 'reason', message: '사유는 200자 이내로 입력하세요.' } };
  const mode = needForce ? 'FORCED' : 'MANUAL';
  const warnings = [...new Set([...(flags || []).filter((f) => ['PRICE_OUT', 'PRICE_DIFF', 'QTY_OUT', 'QTY_DIFF', 'QTY_PARTIAL', 'UNIT_CONVERTED', 'GRADE_DIFF', 'DATE_DIFF', 'AMOUNT_CALC_DIFF', 'WEIGHT_UNKNOWN'].includes(f)),
    ...(plan.reason ? [plan.reason] : []), ...(tradeId ? [] : ['NO_BASE_TRADE'])])];
  const r = await convertOne(client, cx, { line: { ...l, product_id: productId }, trade, mode, plan, tol, eventType: mode === 'FORCED' ? 'FORCE_CONFIRM' : 'MANUAL_CONFIRM',
    approveReason: reason || null, diff, warnings });
  await client.query(`SELECT purchase_doc_recalc($1)`, [l.doc_id]);
  if (r.result === 'TRADE_TAKEN') return { status: 409, body: { ok: false, code: 'TRADE_TAKEN', message: r.message } };
  if (r.result === 'PURCHASE_FAILED') return { status: 422, body: { ok: false, code: 'PURCHASE_FAILED', message: r.message, detail: r.detail } };
  return { status: 200, body: { ok: true, data: { line_id: Number(l.id), result: r.result, mode, purchase_id: r.purchase_id, conversion_id: r.conversion_id,
    diff, amount_diff: r.amount_diff != null ? String(r.amount_diff) : null, warnings } } };
}

/**
 * R-130 전환 취소 (주인) — 기존 매입 취소 핸들러(POST /api/purchases/:id/cancel)를 그대로 부른다.
 *   트리거(027)가 전환·줄·헤더를 맞추고, app.pdoc_cancel_route='on' 이면 트리거 이력은 생략 → 여기서 CANCEL 이력 1건
 */
async function cancelLine(client, cx, lineId, b) {
  withClient(cx, client);
  await lockConvert(client, cx.userId);
  const rows = await engine.lockLines(client, cx.userId, [lineId]);
  const l = rows[0];
  if (!l) return { status: 404, body: { ok: false, code: 'NOT_FOUND', message: '줄을 찾을 수 없습니다.' } };
  const reason = b.reason != null ? String(b.reason).trim() : '';
  if (reason.length < 2) return { status: 400, body: { ok: false, code: 'REASON_REQUIRED', field: 'reason', message: '취소 사유를 2자 이상 입력하세요.' } };
  if (l.status !== 'CONVERTED') return { status: 409, body: { ok: false, code: 'NOT_CONVERTED', message: '매입 등록된 줄만 전환 취소할 수 있습니다.' } };
  const c = await client.query(`SELECT * FROM purchase_doc_conversion WHERE line_id = $1 AND status = 'ACTIVE'`, [l.id]);
  const conv = c.rows[0];
  if (!conv) return { status: 409, body: { ok: false, code: 'NOT_CONVERTED', message: '활성 전환 기록이 없습니다.' } };
  await client.query(`SELECT set_config('app.pdoc_cancel_route', 'on', true)`);
  const r = await invokeRoute(cx, 'POST', '/api/purchases/:id/cancel', { id: conv.purchase_id }, { reason: `매입서 전환 취소: ${reason}`.slice(0, 200) });
  await client.query(`SELECT set_config('app.pdoc_cancel_route', '', true)`);
  if (!(r.statusCode === 200 && r.body && r.body.ok)) {
    return { status: r.statusCode >= 400 ? r.statusCode : 409, body: { ok: false, code: (r.body && r.body.code) || 'PURCHASE_CANCEL_FAILED', message: (r.body && r.body.message) || '매입 취소에 실패했습니다.', detail: r.body && r.body.detail } };
  }
  await client.query(`UPDATE purchase_doc_conversion SET cancel_reason = $2, cancelled_by_staff_id = $3 WHERE id = $1`, [conv.id, reason.slice(0, 200), actorStaff(cx)]);
  await client.query(
    `INSERT INTO purchase_match_event (user_id, doc_id, line_id, event_type, from_status, to_status, trade_id, purchase_id, conversion_id, reason, detail, actor_kind, actor_staff_id, idempotency_key)
     VALUES ($1,$2,$3,'CANCEL','CONVERTED','CANCELLED',$4,$5,$6,$7,$8::jsonb,$9,$10,$11)`,
    [cx.userId, l.doc_id, l.id, conv.trade_id, conv.purchase_id, conv.id, reason.slice(0, 200), JSON.stringify({ purchase_cancel: r.body.data }), cx.actorKind, actorStaff(cx), cx.idemKey || null]
  );
  const st = await client.query(`SELECT l.status, d.status AS doc_status FROM purchase_doc_line l JOIN purchase_doc d ON d.id = l.doc_id WHERE l.id = $1`, [l.id]);
  return { status: 200, body: { ok: true, data: { line_id: Number(l.id), status: st.rows[0].status, doc_status: st.rows[0].doc_status, purchase_id: conv.purchase_id,
    conversion_id: Number(conv.id), purchase: r.body.data } } };
}

function lineOut(l) {
  return {
    id: Number(l.id), doc_id: Number(l.doc_id), line_no: l.line_no, status: l.status, version: l.version, match_result: l.match_result, match_score: l.match_score,
    trade_date: l.trade_date, item_name_raw: l.item_name_raw, item_key: l.item_key, grade_norm: l.grade_norm, unit_qty_kg: l.unit_qty_kg, qty: l.qty,
    unit_price: Number(l.unit_price), amount: Number(l.amount), reason_codes: l.reason_codes, warning_flags: l.warning_flags,
  };
}

module.exports = { convertOne, convertBatch, confirmLine, cancelLine, invokeRoute, lockConvert, withClient, lineOut, MAX_BATCH };
