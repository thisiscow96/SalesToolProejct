'use strict';
/**
 * T-203 매입서 업로드·대조·매입전환 라우트 (설계 4.3·4.4, R-116~R-131)
 *  - 저장 + 대조 + 자동 전환은 한 트랜잭션(저장만 되고 대조가 빠진 매입서가 생기지 않게). 자동 전환 실패 줄은 줄 결과로만 남는다(SAVEPOINT).
 *  - 쓰기 R-118(화면 입력)·R-127·R-128·R-130·R-131 은 Idempotency-Key 필수.
 *  - 남의 매입서·줄 id 는 404(존재 숨김). :id·:lineId 는 양의 정수만.
 *  - 교착(40P01)·직렬화 실패(40001)는 전체 ROLLBACK 후 409 RETRY.
 */
const crypto = require('crypto');
const multer = require('multer');
const { parseListOptions, runList } = require('../list-query');
const idem = require('../idempotency');
const P = require('./doc-parse');
const engine = require('./engine');
const convert = require('./convert');
const { loadMappingContext } = require('../auction/normalizer');
const { MAX_BYTES, MAX_ROWS } = require('../excel-upload');

const PURCHASABLE = new Set(['supplier', 'wholesaler', 'market_wholesaler', 'same_market', 'producer']);
const idParam = (s) => (/^\d{1,15}$/.test(String(s || '')) && Number(s) > 0 ? Number(s) : null);
const NF = (res, what = '매입서') => res.status(404).json({ ok: false, code: 'NOT_FOUND', message: `${what}를 찾을 수 없습니다.` });
const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const YMD = /^\d{4}-\d{2}-\d{2}$/;

/** 이름·id 찾기(한 요청 안 캐시) */
function makeLookup(db, userId) {
  const pc = new Map();
  const prc = new Map();
  const corpC = new Map();
  let mapping = null;
  let links = null;
  const toPartner = (r) => (r ? { id: r.id, name: r.name, type: r.type, purchasable: PURCHASABLE.has(r.type) } : null);
  const lk = {
    today: kstToday(),
    async init() {
      mapping = await loadMappingContext(db, { target: 'DOC' });
      lk.mapping = mapping;
      links = await engine.resolveProductLinks(db, userId);
      return lk;
    },
    async partnerByName(name) {
      const k = `n:${name.trim().toLowerCase()}`;
      if (!pc.has(k)) {
        const r = await db.query(`SELECT id, name, type::text AS type FROM account WHERE user_id = $1 AND lower(btrim(name)) = lower(btrim($2)) ORDER BY id LIMIT 1`, [userId, name]);
        pc.set(k, toPartner(r.rows[0]));
      }
      return pc.get(k);
    },
    async partnerById(id) {
      const n = parseInt(id, 10);
      if (!Number.isFinite(n) || n <= 0) return null;
      const k = `i:${n}`;
      if (!pc.has(k)) {
        const r = await db.query(`SELECT id, name, type::text AS type FROM account WHERE user_id = $1 AND id = $2`, [userId, n]);
        pc.set(k, toPartner(r.rows[0]));
      }
      return pc.get(k);
    },
    async productByName(name) {
      const k = `n:${name.trim().toLowerCase()}`;
      if (!prc.has(k)) {
        const r = await db.query(
          `SELECT id, name, unit FROM product WHERE (owner_user_id IS NULL OR owner_user_id = $1) AND NOT is_system AND lower(btrim(name)) = lower(btrim($2))
            ORDER BY (owner_user_id IS NULL) DESC, id LIMIT 1`, [userId, name]);
        prc.set(k, r.rows[0] || null);
      }
      return prc.get(k);
    },
    async productById(id) {
      const n = parseInt(id, 10);
      if (!Number.isFinite(n) || n <= 0) return null;
      const r = await db.query(`SELECT id, name, unit FROM product WHERE id = $1 AND (owner_user_id IS NULL OR owner_user_id = $2) AND NOT is_system`, [n, userId]);
      return r.rows[0] || null;
    },
    productLink(itemKey, grade) { return links(itemKey, grade); },
    async corpOf(partnerId) {
      if (!corpC.has(partnerId)) {
        const r = await db.query(
          `SELECT corp_code FROM market_corp_link WHERE user_id = $1 AND partner_id = $2
           UNION ALL
           SELECT cm.code FROM code_master cm JOIN account a ON a.id = $2 AND a.user_id = $1 WHERE cm.code_type = 'corp' AND btrim(cm.name) = btrim(a.name)
           LIMIT 1`, [userId, partnerId]);
        corpC.set(partnerId, r.rows[0] ? r.rows[0].corp_code : null);
      }
      return corpC.get(partnerId);
    },
    async calcDiff(qty, price, amount) {
      const r = await db.query(`SELECT ($3::bigint - ROUND($1::numeric * $2::numeric))::text AS d`, [qty, price, amount]);
      return r.rows[0].d;
    },
  };
  return lk;
}

/** 줄들 검증 → { rows(미리보기 줄), groups(매입서 묶음), errors } */
async function validateRows(lk, rawRows, { headerDoc = null } = {}) {
  const rows = [];
  const groups = new Map();
  for (const r of rawRows) {
    const raw = headerDoc ? { ...r.vals, supplier_partner_id: headerDoc.supplier_partner_id, doc_no: headerDoc.doc_no } : r.vals;
    // eslint-disable-next-line no-await-in-loop
    const b = await P.buildLine(raw, lk);
    if (b.errors.length) { rows.push({ line: r.line, ok: false, errors: b.errors, warnings: b.warnings }); continue; }
    rows.push({ line: r.line, ok: true, normalized: { item_key: b.line.item_key, grade_norm: b.line.grade_norm, pkg_norm: b.line.pkg_norm, unit_qty_kg: b.line.unit_qty_kg,
      amount: b.line.amount != null ? Number(b.line.amount) : null, product_id: b.line.product_id }, warnings: b.warnings });
    const gk = headerDoc ? 'manual' : (b.doc.doc_no ? `no:${b.doc.supplier.id}:${b.doc.doc_no}` : `auto:${b.doc.supplier.id}:${b.line.trade_date}`);
    if (!groups.has(gk)) groups.set(gk, { doc_no: headerDoc ? headerDoc.doc_no : b.doc.doc_no, supplier: b.doc.supplier, corp_code: b.line.corp_code, memo: b.doc.memo, lines: [], doc_date: b.line.trade_date });
    const g = groups.get(gk);
    g.lines.push({ ...b.line, source_line_no: r.line });
    if (b.line.trade_date < g.doc_date) g.doc_date = b.line.trade_date;
    if (!g.memo && b.doc.memo) g.memo = b.doc.memo;
  }
  return { rows, groups: [...groups.values()] };
}

async function amountsOf(db, lines) {
  if (!lines.length) return [];
  const r = await db.query(`SELECT COALESCE(a, ROUND(q * p))::bigint::text AS amt FROM unnest($1::numeric[], $2::bigint[], $3::bigint[]) WITH ORDINALITY AS x(q, p, a, n) ORDER BY n`,
    [lines.map((l) => l.qty), lines.map((l) => l.unit_price), lines.map((l) => l.amount)]);
  return r.rows.map((x) => x.amt);
}

function registerPurchaseDocRoutes(app, deps) {
  const { pool, authorize, getUserIdAndAdmin, recordAudit } = deps;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });
  const receiveFile = (req, res, next) => {
    if (!/multipart\/form-data/i.test(req.headers['content-type'] || '')) return next();
    return upload.single('file')(req, res, (err) => {
      if (!err) return next();
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ ok: false, code: 'FILE_TOO_LARGE', message: '파일은 2MB까지 올릴 수 있습니다.' });
      return res.status(400).json({ ok: false, code: 'BAD_FILE', message: '파일을 받지 못했습니다. 엑셀·CSV 파일 하나를 골라 주세요.' });
    });
  };

  async function authOf(req, res) {
    const auth = await getUserIdAndAdmin(req);
    if (!auth) { res.status(401).json({ ok: false, message: '로그인이 필요합니다.' }); return null; }
    return auth;
  }
  const cxOf = (req, auth, extra = {}) => ({
    userId: auth.userId, staffId: auth.staffId || null, actorKind: auth.role === 'owner' ? 'OWNER' : 'STAFF', app, authorize, req, ...extra,
  });

  /** 트랜잭션 하나로 처리 — Idempotency-Key 가 있으면 기록·재생. fn → { status, body } */
  async function inTx(req, res, auth, { key = null, route, body }, fn) {
    let client;
    try { client = await pool.connect(); } catch (err) {
      return res.status(503).json({ ok: false, message: 'DB 연결이 잠시 원활하지 않습니다. 잠시 후 다시 시도해 주세요.' });
    }
    try {
      await client.query('BEGIN');
      if (key) {
        const b = await idem.begin(client, { userId: auth.userId, key, route, body });
        if (b.reused) { await client.query('ROLLBACK'); return res.status(422).json(idem.REUSED); }
        if (b.replay) { await client.query('ROLLBACK'); return idem.sendReplay(res, b.replay); }
        if (b.retry) { await client.query('ROLLBACK'); return res.status(409).json({ ok: false, code: 'RETRY', message: '다른 작업과 겹쳤습니다. 잠시 후 다시 시도하세요.' }); }
      }
      const out = await fn(client, cxOf(req, auth, { idemKey: key }));
      if (out.status >= 200 && out.status < 300) {
        if (key) await idem.complete(client, { userId: auth.userId, key, status: out.status, body: out.body });
        await client.query('COMMIT');
      } else await client.query('ROLLBACK');
      return res.status(out.status).json(out.body);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === '40P01' || err.code === '40001') return res.status(409).json({ ok: false, code: 'RETRY', message: '다른 작업과 겹쳤습니다. 잠시 후 다시 시도하세요.' });
      if (err.code === '23505' && /ux_purchase_doc_no/.test(err.constraint || '')) return res.status(409).json({ ok: false, code: 'DUPLICATE_DOC_NO', message: '같은 제공처의 매입서 번호가 이미 있습니다.' });
      if (err.code === '23505' && /excel_upload/.test(err.constraint || err.message)) return res.status(409).json({ ok: false, code: 'DUPLICATE_FILE', message: '이미 저장한 파일입니다.' });
      console.error(`[purchase-doc] ${route} error:`, err.message);
      return res.status(500).json({ ok: false, message: '매입서를 처리하지 못했습니다.' });
    } finally { client.release(); }
  }

  // ---- R-116 템플릿 ----
  app.get('/api/purchase-docs/template', async (req, res) => {
    if (!(await authOf(req, res))) return undefined;
    try {
      const buf = await P.templateBuffer();
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="template_purchase_doc.xlsx"; filename*=UTF-8''${encodeURIComponent('매입서_템플릿.xlsx')}`);
      return res.send(Buffer.from(buf));
    } catch (err) {
      console.error('[purchase-doc] template:', err.message);
      return res.status(500).json({ ok: false, message: '템플릿을 만들지 못했습니다.' });
    }
  });

  // ---- R-117 미리보기 ----
  app.post('/api/purchase-docs/preview', receiveFile, async (req, res) => {
    const auth = await authOf(req, res);
    if (!auth) return undefined;
    if (!req.file || !req.file.buffer || !req.file.buffer.length) return res.status(400).json({ ok: false, code: 'NO_FILE', message: '파일을 골라 주세요.' });
    const parsed = await P.parseFile(req.file);
    if (parsed.error) return res.status(400).json({ ok: false, code: parsed.code === 'TOO_MANY_ROWS' ? 'TOO_MANY_ROWS' : 'BAD_FILE', message: parsed.error });
    try {
      const lk = await makeLookup(pool, auth.userId).init();
      const v = await validateRows(lk, parsed.rows);
      const amts = [];
      for (const g of v.groups) amts.push(await amountsOf(pool, g.lines)); // eslint-disable-line no-await-in-loop
      const docs = v.groups.map((g, i) => ({ group_key: g.doc_no || `${g.supplier.name}·${g.doc_date}`, doc_no: g.doc_no, doc_date: g.doc_date, supplier: g.supplier.name,
        supplier_partner_id: g.supplier.id, corp_code: g.corp_code, lines: g.lines.length, amount_total: amts[i].reduce((t, x) => t + Number(x), 0) }));
      const errors = v.rows.filter((r) => !r.ok).length;
      return res.json({ ok: true, data: { docs, rows: v.rows, file_kind: parsed.kind,
        summary: { rows: v.rows.length, ok: v.rows.length - errors, errors, warnings: v.rows.filter((r) => r.warnings && r.warnings.length).length, amount_total: docs.reduce((t, d) => t + d.amount_total, 0) } } });
    } catch (err) {
      console.error('[purchase-doc] preview:', err.message);
      return res.status(500).json({ ok: false, message: '미리보기를 만들지 못했습니다.' });
    }
  });

  /** 매입서 묶음 저장 + 대조(+자동 전환) — 바깥 트랜잭션 안 */
  async function saveAndMatch(client, cx, { groups, inputKind, uploadId, autoConvert }) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`purchase-doc:${cx.userId}`]);
    await convert.lockConvert(client, cx.userId);
    // 매입서 번호 중복 — 하나라도 있으면 전부 저장 안 함
    for (const g of groups) {
      if (!g.doc_no) continue;
      // eslint-disable-next-line no-await-in-loop
      const d = await client.query(`SELECT id FROM purchase_doc WHERE user_id = $1 AND supplier_partner_id = $2 AND doc_no = $3 AND status <> 'CANCELLED'`, [cx.userId, g.supplier.id, g.doc_no]);
      if (d.rows[0]) return { status: 409, body: { ok: false, code: 'DUPLICATE_DOC_NO', message: `같은 제공처의 매입서 번호 ${g.doc_no} 가 이미 있습니다.`, detail: { doc_id: Number(d.rows[0].id) } } };
    }
    const lineIds = [];
    const docIds = [];
    for (const g of groups) {
      // eslint-disable-next-line no-await-in-loop
      const d = await client.query(
        `INSERT INTO purchase_doc (user_id, input_kind, upload_id, doc_no, doc_date, supplier_partner_id, corp_code, memo, created_by_staff_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [cx.userId, inputKind, uploadId, g.doc_no, g.doc_date, g.supplier.id, g.corp_code, g.memo ? String(g.memo).slice(0, 200) : null, cx.staffId]
      );
      const docId = Number(d.rows[0].id);
      docIds.push(docId);
      let no = 0;
      for (const l of g.lines) {
        no += 1;
        // eslint-disable-next-line no-await-in-loop
        const r = await client.query(
          `INSERT INTO purchase_doc_line (doc_id, user_id, line_no, source_line_no, trade_date, arrival_date, item_name_raw, item_key, grade_raw, grade_norm, pkg_raw, pkg_norm,
                                          unit_qty_kg, weight_source, qty, unit_price, amount, origin_name, shipper_name_masked, auction_ref, buyer_code, product_id, line_fingerprint)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::numeric,$14,$15::numeric,$16::bigint, COALESCE($17::bigint, ROUND($15::numeric * $16::bigint)::bigint), $18,$19,$20,$21,$22,$23)
           RETURNING id`,
          [docId, cx.userId, no, l.source_line_no || null, l.trade_date, l.arrival_date, l.item_name_raw, l.item_key, l.grade_raw, l.grade_norm, l.pkg_raw, l.pkg_norm,
            l.unit_qty_kg, l.weight_source, l.qty, l.unit_price, l.amount, l.origin_name, l.shipper_name_masked, l.auction_ref, l.buyer_code, l.product_id, l.line_fingerprint]
        );
        lineIds.push(Number(r.rows[0].id));
      }
      // eslint-disable-next-line no-await-in-loop
      await client.query(`SELECT purchase_doc_recalc($1)`, [docId]);
      // eslint-disable-next-line no-await-in-loop
      await client.query(
        `INSERT INTO purchase_match_event (user_id, doc_id, event_type, to_status, reason, detail, actor_kind, actor_staff_id, idempotency_key)
         VALUES ($1,$2,$3,'PENDING',$4,$5::jsonb,$6,$7,$8)`,
        [cx.userId, docId, inputKind === 'MANUAL' ? 'MANUAL_INPUT' : 'UPLOAD', `${g.lines.length}줄`, JSON.stringify({ input_kind: inputKind, upload_id: uploadId, lines: g.lines.length }),
          cx.actorKind, cx.actorKind === 'STAFF' ? cx.staffId : null, cx.idemKey || null]
      );
    }
    const m = await engine.matchLines(client, cx, { lineIds, trigger: 'UPLOAD', autoConvert, statuses: ['PENDING'] });
    const docs = [];
    for (const id of docIds) {
      // eslint-disable-next-line no-await-in-loop
      const h = await client.query(`SELECT status FROM purchase_doc WHERE id = $1`, [id]);
      docs.push({ id, status: h.rows[0].status, lines: m.lines.filter((x) => x.doc_id === id).map(lineResult) });
    }
    await recordAudit(client, { userId: cx.userId, entityType: 'purchase_doc', entityId: docIds[0], action: 'upload', before: null,
      after: { docs: docIds.length, lines: lineIds.length, input_kind: inputKind, auto_converted: m.summary.auto_converted }, note: `매입서 ${docIds.length}건 ${lineIds.length}줄 저장·대조`,
      actorStaffId: cx.staffId || undefined });
    return { status: 201, body: { ok: true, data: { docs, run_id: m.runIds[0] || null, run_ids: m.runIds, summary: m.summary } } };
  }

  // ---- R-118 저장 + 대조(+ 자동 전환) — 파일(multipart) 또는 화면 입력(JSON + Idempotency-Key) ----
  app.post('/api/purchase-docs', receiveFile, async (req, res) => {
    const auth = await authOf(req, res);
    if (!auth) return undefined;
    const isFile = /multipart\/form-data/i.test(req.headers['content-type'] || '');
    const autoConvert = !(String((req.body || {}).auto_convert) === 'false' || (req.body || {}).auto_convert === false);
    if (isFile) {
      if (!req.file || !req.file.buffer || !req.file.buffer.length) return res.status(400).json({ ok: false, code: 'NO_FILE', message: '파일을 골라 주세요.' });
      const parsed = await P.parseFile(req.file);
      if (parsed.error) return res.status(400).json({ ok: false, code: parsed.code === 'TOO_MANY_ROWS' ? 'TOO_MANY_ROWS' : 'BAD_FILE', message: parsed.error });
      const hash = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
      const key = idem.readKey(req).key || null; // 파일 저장은 file_hash 가 멱등 키(선택으로 Idempotency-Key 도 받음)
      return inTx(req, res, auth, { key, route: 'R-118-file', body: { hash, autoConvert } }, async (client, cx) => {
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`purchase-doc:${cx.userId}`]);
        const dup = await client.query(`SELECT id FROM excel_upload WHERE user_id = $1 AND file_hash = $2 LIMIT 1`, [cx.userId, hash]);
        if (dup.rows[0]) {
          const ds = await client.query(`SELECT id FROM purchase_doc WHERE upload_id = $1 ORDER BY id`, [dup.rows[0].id]);
          return { status: 409, body: { ok: false, code: 'DUPLICATE_FILE', message: '이미 저장한 파일입니다. 같은 내용을 다시 넣으려면 파일을 고쳐서 올리세요.', detail: { doc_ids: ds.rows.map((x) => Number(x.id)), upload_id: Number(dup.rows[0].id) } } };
        }
        const lk = await makeLookup(client, cx.userId).init();
        const v = await validateRows(lk, parsed.rows);
        const errCount = v.rows.filter((r) => !r.ok).length;
        if (errCount) return { status: 400, body: { ok: false, code: 'HAS_ERRORS', message: `오류가 ${errCount}줄 있어 아무것도 저장하지 않았습니다.`, rows: v.rows } };
        const amt = (await Promise.all(v.groups.map((g) => amountsOf(client, g.lines)))).flat().reduce((t, x) => t + BigInt(x), 0n);
        const fileName = (parsed.fileName || '').slice(0, 200) || null;
        const up = await client.query(
          `INSERT INTO excel_upload (user_id, kind, file_hash, file_name, row_count, amount_total, result, created_by_staff_id)
           VALUES ($1, 'purchase_doc', $2, $3, $4, $5, '[]'::jsonb, $6) RETURNING id`,
          [cx.userId, hash, fileName, v.rows.length, amt.toString(), cx.staffId]
        );
        return saveAndMatch(client, cx, { groups: v.groups, inputKind: parsed.kind, uploadId: Number(up.rows[0].id), autoConvert });
      });
    }
    const key = idem.requireKey(req, res);
    if (!key) return undefined;
    const b = req.body || {};
    if (!Array.isArray(b.lines) || !b.lines.length) return res.status(400).json({ ok: false, code: 'VALIDATION', field: 'lines', message: '줄을 하나 이상 입력하세요.' });
    if (b.lines.length > MAX_ROWS) return res.status(400).json({ ok: false, code: 'TOO_MANY_ROWS', message: `한 번에 ${MAX_ROWS.toLocaleString('ko-KR')}줄까지 입력할 수 있습니다.` });
    if (b.doc_date != null && !YMD.test(String(b.doc_date))) return res.status(400).json({ ok: false, code: 'VALIDATION', field: 'doc_date', message: '매입서 날짜는 YYYY-MM-DD 입니다.' });
    if (b.supplier_partner_id == null) return res.status(400).json({ ok: false, code: 'VALIDATION', field: 'supplier_partner_id', message: '제공처를 고르세요.' });
    return inTx(req, res, auth, { key, route: 'R-118', body: b }, async (client, cx) => {
      const lk = await makeLookup(client, cx.userId).init();
      const raw = b.lines.map((l, i) => ({ line: i + 1, vals: { ...l, item: l.item ?? l.item_name } }));
      const v = await validateRows(lk, raw, { headerDoc: { supplier_partner_id: b.supplier_partner_id, doc_no: b.doc_no ? String(b.doc_no).trim() || null : null } });
      const bad = v.rows.filter((r) => !r.ok);
      if (bad.length) {
        // field = lines.{배열 위치}.{칸} (화면이 그 줄 칸 옆에 붙임), column = 칸 이름, line = 1부터 줄 번호
        const errors = bad.flatMap((r) => r.errors.map((e) => ({ ...e, column: e.field, field: `lines.${r.line - 1}.${e.field}`, line: r.line })));
        return { status: 400, body: { ok: false, code: 'VALIDATION', message: `입력 오류 ${errors.length}건`, errors, rows: v.rows } };
      }
      const g = v.groups[0];
      if (b.doc_date) g.doc_date = String(b.doc_date);
      if (b.memo) g.memo = String(b.memo).slice(0, 200);
      return saveAndMatch(client, cx, { groups: [g], inputKind: 'MANUAL', uploadId: null, autoConvert: b.auto_convert !== false });
    });
  });

  // ---- R-121 검토 대기 (매입서 넘나들며) ----
  app.get('/api/purchase-docs/review', async (req, res) => {
    const auth = await authOf(req, res);
    if (!auth) return undefined;
    const q = req.query || {};
    const opts = parseListOptions({ limit: q.limit || 50, offset: q.offset });
    if (opts.error) return res.status(400).json(opts.error);
    const params = [auth.userId];
    const where = [`l.user_id = $1`, `d.status <> 'CANCELLED'`,
      `(l.status IN ('HOLD','CANCELLED') OR (l.status = 'PENDING' AND l.match_result IS NOT NULL) OR (l.status = 'CONVERTED' AND 'BASE_REVISED' = ANY(l.warning_flags)))`];
    if (q.reason) {
      const rs = String(q.reason).split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z_]{2,40}$/.test(s));
      if (!rs.length) return res.status(400).json({ ok: false, code: 'VALIDATION', field: 'reason', message: '사유 코드가 올바르지 않습니다.' });
      params.push(rs);
      where.push(`(l.reason_codes && $${params.length}::text[] OR l.warning_flags && $${params.length}::text[])`);
    }
    if (q.date_from) { if (!YMD.test(q.date_from)) return res.status(400).json({ ok: false, code: 'VALIDATION', field: 'date_from', message: '날짜 형식이 올바르지 않습니다.' }); params.push(q.date_from); where.push(`l.trade_date >= $${params.length}`); }
    if (q.date_to) { if (!YMD.test(q.date_to)) return res.status(400).json({ ok: false, code: 'VALIDATION', field: 'date_to', message: '날짜 형식이 올바르지 않습니다.' }); params.push(q.date_to); where.push(`l.trade_date <= $${params.length}`); }
    try {
      const base = `SELECT l.*, d.doc_no, d.doc_date, d.supplier_partner_id, a.name AS supplier_name, mi.family_name, mi.variety_name,
                           c.price_diff, c.price_diff_pct, c.qty_diff, c.amount_diff AS cand_amount_diff, c.score AS cand_score
                      FROM purchase_doc_line l
                      JOIN purchase_doc d ON d.id = l.doc_id AND d.user_id = l.user_id
                      JOIN account a ON a.id = d.supplier_partner_id
                      LEFT JOIN market_item mi ON mi.item_key = l.item_key
                      LEFT JOIN purchase_match_candidate c ON c.run_id = l.last_run_id AND c.line_id = l.id AND c.rank = 1
                     WHERE ${where.join(' AND ')}`;
      const out = await runList(pool, base, params, ' ORDER BY l.trade_date DESC, l.doc_id DESC, l.line_no', opts);
      out.data = out.data.map((r) => {
        const diff = r.price_diff == null ? null : { price: Number(r.price_diff), price_pct: r.price_diff_pct, qty: r.qty_diff, amount: r.cand_amount_diff != null ? Number(r.cand_amount_diff) : null };
        return { ...lineView(r), doc_no: r.doc_no, doc_date: r.doc_date, supplier_name: r.supplier_name, diff, top_diff: diff }; // top_diff = diff (B② 이름)
      });
      return res.json(out);
    } catch (err) {
      console.error('[purchase-doc] review:', err.message);
      return res.status(500).json({ ok: false, message: '검토 대기 목록을 불러오지 못했습니다.' });
    }
  });

  // ---- R-127 단건·일괄 전환 ----
  app.post('/api/purchase-docs/convert', async (req, res) => {
    const auth = await authOf(req, res);
    if (!auth) return undefined;
    const key = idem.requireKey(req, res);
    if (!key) return undefined;
    const b = req.body || {};
    if (!Array.isArray(b.lines) || !b.lines.length) return res.status(400).json({ ok: false, code: 'VALIDATION', field: 'lines', message: '전환할 줄을 고르세요.' });
    if (b.lines.length > convert.MAX_BATCH) return res.status(400).json({ ok: false, code: 'VALIDATION', field: 'lines', message: `한 번에 ${convert.MAX_BATCH}줄까지 전환할 수 있습니다.` });
    const ids = [];
    for (const x of b.lines) {
      const id = idParam(x && (x.line_id ?? x));
      if (!id) return res.status(400).json({ ok: false, code: 'VALIDATION', field: 'lines', message: '줄 번호가 올바르지 않습니다.' });
      if (!ids.includes(id)) ids.push(id);
    }
    return inTx(req, res, auth, { key, route: 'R-127', body: { lines: ids } }, async (client, cx) => ({ status: 200, body: { ok: true, data: await convert.convertBatch(client, cx, ids) } }));
  });

  // ---- R-119 목록 ----
  app.get('/api/purchase-docs', async (req, res) => {
    const auth = await authOf(req, res);
    if (!auth) return undefined;
    const q = req.query || {};
    const opts = parseListOptions({ q: q.q, limit: q.limit || 50, offset: q.offset });
    if (opts.error) return res.status(400).json(opts.error);
    const params = [auth.userId];
    const where = ['d.user_id = $1'];
    if (q.status) {
      const st = String(q.status).toUpperCase().split(',').filter(Boolean);
      if (st.some((s) => !['PENDING', 'HOLD', 'PARTIAL_CONVERTED', 'CONVERTED', 'REJECTED', 'CANCELLED'].includes(s))) return res.status(400).json({ ok: false, code: 'VALIDATION', field: 'status', message: '상태 값이 올바르지 않습니다.' });
      params.push(st); where.push(`d.status = ANY($${params.length}::text[])`);
    }
    if (q.date_from) { if (!YMD.test(q.date_from)) return res.status(400).json({ ok: false, code: 'VALIDATION', field: 'date_from', message: '날짜 형식이 올바르지 않습니다.' }); params.push(q.date_from); where.push(`d.doc_date >= $${params.length}`); }
    if (q.date_to) { if (!YMD.test(q.date_to)) return res.status(400).json({ ok: false, code: 'VALIDATION', field: 'date_to', message: '날짜 형식이 올바르지 않습니다.' }); params.push(q.date_to); where.push(`d.doc_date <= $${params.length}`); }
    if (q.supplier_partner_id) { const s = idParam(q.supplier_partner_id); if (!s) return res.status(400).json({ ok: false, code: 'VALIDATION', field: 'supplier_partner_id', message: '제공처 번호가 올바르지 않습니다.' }); params.push(s); where.push(`d.supplier_partner_id = $${params.length}`); }
    if (opts.like) { params.push(opts.like); where.push(`(d.doc_no ILIKE $${params.length} OR EXISTS (SELECT 1 FROM purchase_doc_line l WHERE l.doc_id = d.id AND l.item_name_raw ILIKE $${params.length}))`); }
    try {
      const base = `SELECT d.*, a.name AS supplier_name FROM purchase_doc d JOIN account a ON a.id = d.supplier_partner_id WHERE ${where.join(' AND ')}`;
      const out = await runList(pool, base, params, ' ORDER BY d.doc_date DESC, d.id DESC', opts);
      out.data = out.data.map(docView);
      return res.json(out);
    } catch (err) {
      console.error('[purchase-doc] list:', err.message);
      return res.status(500).json({ ok: false, message: '매입서 목록을 불러오지 못했습니다.' });
    }
  });

  // ---- R-120 상세 ----
  app.get('/api/purchase-docs/:id', async (req, res, next) => {
    const auth = await authOf(req, res);
    if (!auth) return undefined;
    const id = idParam(req.params.id);
    if (!id) return NF(res);
    try {
      const d = await pool.query(`SELECT d.*, a.name AS supplier_name FROM purchase_doc d JOIN account a ON a.id = d.supplier_partner_id WHERE d.id = $1 AND d.user_id = $2`, [id, auth.userId]);
      if (!d.rows[0]) return NF(res);
      const l = await pool.query(
        `SELECT l.*, mi.family_name, mi.variety_name, cv.id AS conversion_id, cv.purchase_id, cv.mode AS conversion_mode, cv.amount_diff AS conversion_amount_diff,
                p.name AS product_name, p.unit AS product_unit,
                EXISTS (SELECT 1 FROM trade_correction tc WHERE tc.user_id = l.user_id AND tc.target_type = 'purchase' AND tc.target_id = cv.purchase_id AND tc.action <> 'cancel') AS corrected_after_convert,
                t.trade_date AS best_trade_date, t.corp_name AS best_corp_name, t.unit_price AS best_unit_price, t.qty AS best_qty, t.unit_qty_kg AS best_unit_qty_kg,
                t.grade_norm AS best_grade_norm, t.source AS best_source, t.auction_at AS best_auction_at
           FROM purchase_doc_line l
           LEFT JOIN market_item mi ON mi.item_key = l.item_key
           LEFT JOIN purchase_doc_conversion cv ON cv.line_id = l.id AND cv.status = 'ACTIVE'
           LEFT JOIN product p ON p.id = l.product_id
           LEFT JOIN auction_trade t ON t.id = l.best_trade_id
          WHERE l.doc_id = $1 AND l.user_id = $2 ORDER BY l.line_no`, [id, auth.userId]);
      return res.json({ ok: true, data: { ...docView(d.rows[0]), lines: l.rows.map((r) => ({ ...lineView(r), purchase_id: r.purchase_id, conversion_id: r.conversion_id ? Number(r.conversion_id) : null,
        conversion_mode: r.conversion_mode, conversion_amount_diff: r.conversion_amount_diff, product_name: r.product_name, product_unit: r.product_unit,
        corrected_after_convert: !!r.corrected_after_convert,
        warning_flags: r.corrected_after_convert ? [...(r.warning_flags || []), 'CORRECTED_AFTER_CONVERT'] : (r.warning_flags || []), // 화면 경고 문구(B②)
        best: r.best_trade_id ? { trade_id: Number(r.best_trade_id), trade_date: r.best_trade_date, corp_name: r.best_corp_name, unit_price: r.best_unit_price != null ? Number(r.best_unit_price) : null,
          qty: r.best_qty, unit_qty_kg: r.best_unit_qty_kg, grade_norm: r.best_grade_norm, source: r.best_source } : null })) } });
    } catch (err) {
      console.error('[purchase-doc] detail:', err.message);
      return next(err);
    }
  });

  // ---- R-123 이력 ----
  app.get('/api/purchase-docs/:id/events', async (req, res) => {
    const auth = await authOf(req, res);
    if (!auth) return undefined;
    const id = idParam(req.params.id);
    if (!id) return NF(res);
    const opts = parseListOptions({ limit: req.query.limit || 50, offset: req.query.offset });
    if (opts.error) return res.status(400).json(opts.error);
    try {
      const d = await pool.query(`SELECT 1 FROM purchase_doc WHERE id = $1 AND user_id = $2`, [id, auth.userId]);
      if (!d.rows[0]) return NF(res);
      const out = await runList(pool,
        `SELECT e.*, l.line_no, CASE WHEN e.actor_kind = 'STAFF' THEN s.name WHEN e.actor_kind = 'OWNER' THEN '주인' ELSE '시스템' END AS actor_name
           FROM purchase_match_event e LEFT JOIN purchase_doc_line l ON l.id = e.line_id
           LEFT JOIN staff_account s ON s.id = e.actor_staff_id AND s.owner_user_id = e.user_id
          WHERE e.doc_id = $1 AND e.user_id = $2`, [id, auth.userId], ' ORDER BY e.created_at DESC, e.id DESC', opts);
      out.data = out.data.map((e) => ({ ...e, id: Number(e.id), doc_id: Number(e.doc_id), line_id: e.line_id ? Number(e.line_id) : null }));
      return res.json(out);
    } catch (err) {
      console.error('[purchase-doc] events:', err.message);
      return res.status(500).json({ ok: false, message: '이력을 불러오지 못했습니다.' });
    }
  });

  // ---- R-124 매입서 다시 대조 ----
  app.post('/api/purchase-docs/:id/match', async (req, res) => {
    const auth = await authOf(req, res);
    if (!auth) return undefined;
    const id = idParam(req.params.id);
    if (!id) return NF(res);
    const autoConvert = (req.body || {}).auto_convert === true;
    return inTx(req, res, auth, { route: 'R-124', body: {} }, async (client, cx) => {
      // 잠금 순서: 회원 advisory → 매입서 → 줄 (I 검토 D-02 — 자동 전환이 아니어도 항상 advisory 먼저)
      await convert.lockConvert(client, cx.userId);
      const d = await client.query(`SELECT status FROM purchase_doc WHERE id = $1 AND user_id = $2 FOR UPDATE`, [id, cx.userId]);
      if (!d.rows[0]) return { status: 404, body: { ok: false, code: 'NOT_FOUND', message: '매입서를 찾을 수 없습니다.' } };
      if (d.rows[0].status === 'CANCELLED') return { status: 409, body: { ok: false, code: 'DOC_CANCELLED', message: '취소된 매입서입니다.' } };
      const ls = await client.query(`SELECT id FROM purchase_doc_line WHERE doc_id = $1 ORDER BY id`, [id]);
      const m = await engine.matchLines(client, cx, { lineIds: ls.rows.map((x) => x.id), trigger: 'MANUAL', autoConvert });
      const h = await client.query(`SELECT status FROM purchase_doc WHERE id = $1`, [id]);
      return { status: 200, body: { ok: true, data: { docs: [{ id, status: h.rows[0].status, lines: m.lines.map(lineResult) }], skipped: m.skipped, run_id: m.runIds[0] || null, summary: m.summary } } };
    });
  });

  // ---- R-131 매입서 취소 ----
  app.post('/api/purchase-docs/:id/cancel', async (req, res) => {
    const auth = await authOf(req, res);
    if (!auth) return undefined;
    const id = idParam(req.params.id);
    if (!id) return NF(res);
    const key = idem.requireKey(req, res);
    if (!key) return undefined;
    const b = req.body || {};
    const reason = b.reason != null ? String(b.reason).trim() : '';
    if (reason.length < 2) return res.status(400).json({ ok: false, code: 'REASON_REQUIRED', field: 'reason', message: '취소 사유를 2자 이상 입력하세요.' });
    return inTx(req, res, auth, { key, route: 'R-131', body: { id, reason } }, async (client, cx) => {
      // 잠금 순서: 회원 advisory → 매입서 (I 검토 D-01 — 수동 확정·전환과 직렬화해 "취소된 매입서에 활성 매입"을 막음)
      await convert.lockConvert(client, cx.userId);
      const d = await client.query(`SELECT status FROM purchase_doc WHERE id = $1 AND user_id = $2 FOR UPDATE`, [id, cx.userId]);
      if (!d.rows[0]) return { status: 404, body: { ok: false, code: 'NOT_FOUND', message: '매입서를 찾을 수 없습니다.' } };
      if (d.rows[0].status === 'CANCELLED') return { status: 409, body: { ok: false, code: 'DOC_CANCELLED', message: '이미 취소된 매입서입니다.' } };
      const act = await client.query(`SELECT c.line_id, l.line_no, c.purchase_id FROM purchase_doc_conversion c JOIN purchase_doc_line l ON l.id = c.line_id WHERE c.doc_id = $1 AND c.status = 'ACTIVE' ORDER BY l.line_no`, [id]);
      if (act.rows.length) return { status: 409, body: { ok: false, code: 'DOC_HAS_CONVERSIONS', message: `매입 등록된 줄 ${act.rows.length}개를 먼저 전환 취소하세요.`, detail: { lines: act.rows.map((x) => ({ line_id: Number(x.line_id), line_no: x.line_no, purchase_id: x.purchase_id })) } } };
      await client.query(`UPDATE purchase_doc SET status = 'CANCELLED', cancelled_at = NOW(), cancel_reason = $2, updated_at = NOW() WHERE id = $1`, [id, reason.slice(0, 200)]);
      await client.query(`INSERT INTO purchase_match_event (user_id, doc_id, event_type, from_status, to_status, reason, actor_kind, actor_staff_id, idempotency_key) VALUES ($1,$2,'DOC_CANCEL',$3,'CANCELLED',$4,$5,$6,$7)`,
        [cx.userId, id, d.rows[0].status, reason.slice(0, 200), cx.actorKind, cx.actorKind === 'STAFF' ? cx.staffId : null, key]);
      await recordAudit(client, { userId: cx.userId, entityType: 'purchase_doc', entityId: id, action: 'cancel', before: { status: d.rows[0].status }, after: { status: 'CANCELLED' }, note: `매입서 #${id} 취소: ${reason}`.slice(0, 200) });
      return { status: 200, body: { ok: true, data: { id, status: 'CANCELLED' } } };
    });
  });

  // ---- R-122 후보 ----
  app.get('/api/purchase-docs/lines/:lineId/candidates', async (req, res) => {
    const auth = await authOf(req, res);
    if (!auth) return undefined;
    const lineId = idParam(req.params.lineId);
    if (!lineId) return NF(res, '줄');
    try {
      const l = await pool.query(`SELECT l.*, d.doc_no FROM purchase_doc_line l JOIN purchase_doc d ON d.id = l.doc_id WHERE l.id = $1 AND l.user_id = $2`, [lineId, auth.userId]);
      if (!l.rows[0]) return NF(res, '줄');
      let runId = l.rows[0].last_run_id;
      if (req.query.run_id) {
        const r = idParam(req.query.run_id);
        const own = r ? await pool.query(`SELECT 1 FROM purchase_match_run WHERE id = $1 AND user_id = $2`, [r, auth.userId]) : { rows: [] };
        if (!own.rows[0]) return NF(res, '대조 실행');
        runId = r;
      }
      const c = runId ? await pool.query(
        `SELECT c.*, t.source, t.trade_date, t.auction_at, t.corp_code, t.corp_name, t.item_key, t.item_name_raw, t.grade_norm, t.grade_name, t.pkg_name, t.unit_qty_kg,
                t.qty, t.unit_price, t.amount, t.price_per_kg, t.origin_name, t.shipper_name_masked, t.buyer_code, t.auction_seq, t.revision, t.withdrawn_at,
                EXISTS (SELECT 1 FROM purchase_doc_conversion x WHERE x.user_id = $3 AND x.trade_id = c.trade_id AND x.status = 'ACTIVE' AND x.line_id <> c.line_id) AS taken
           FROM purchase_match_candidate c JOIN auction_trade t ON t.id = c.trade_id
          WHERE c.run_id = $1 AND c.line_id = $2 AND c.user_id = $3 ORDER BY c.rank`, [runId, lineId, auth.userId]) : { rows: [] };
      return res.json({ ok: true, data: { line: lineView(l.rows[0]), run_id: runId ? Number(runId) : null, candidates: c.rows.map((x) => ({
        rank: x.rank, trade_id: Number(x.trade_id), score: x.score, strict_pass: x.strict_pass, strict: x.strict_pass, breakdown: x.breakdown, flags: x.flags, taken: x.taken,
        diff: { price: x.price_diff != null ? Number(x.price_diff) : null, price_pct: x.price_diff_pct, qty: x.qty_diff, amount: x.amount_diff != null ? Number(x.amount_diff) : null, date: x.date_diff, days: x.date_diff },
        trade: { source: x.source, trade_date: x.trade_date, auction_at: x.auction_at, corp_code: x.corp_code, corp_name: x.corp_name, item_key: x.item_key, item_name_raw: x.item_name_raw,
          grade_norm: x.grade_norm, grade_name: x.grade_name, pkg_name: x.pkg_name, unit_qty_kg: x.unit_qty_kg, qty: x.qty, unit_price: Number(x.unit_price), amount: Number(x.amount),
          price_per_kg: x.price_per_kg, origin_name: x.origin_name, shipper_name_masked: x.shipper_name_masked, buyer_code: x.buyer_code, auction_seq: x.auction_seq, revision: x.revision, withdrawn_at: x.withdrawn_at },
      })) } });
    } catch (err) {
      console.error('[purchase-doc] candidates:', err.message);
      return res.status(500).json({ ok: false, message: '후보를 불러오지 못했습니다.' });
    }
  });

  // ---- R-125 줄 다시 대조 ----
  app.post('/api/purchase-docs/lines/:lineId/rematch', async (req, res) => {
    const auth = await authOf(req, res);
    if (!auth) return undefined;
    const lineId = idParam(req.params.lineId);
    if (!lineId) return NF(res, '줄');
    return inTx(req, res, auth, { route: 'R-125', body: {} }, async (client, cx) => {
      const l = await client.query(`SELECT l.status, d.status AS doc_status FROM purchase_doc_line l JOIN purchase_doc d ON d.id = l.doc_id WHERE l.id = $1 AND l.user_id = $2`, [lineId, cx.userId]);
      if (!l.rows[0]) return { status: 404, body: { ok: false, code: 'NOT_FOUND', message: '줄을 찾을 수 없습니다.' } };
      if (l.rows[0].doc_status === 'CANCELLED') return { status: 409, body: { ok: false, code: 'DOC_CANCELLED', message: '취소된 매입서입니다.' } };
      if (l.rows[0].status === 'CONVERTED') return { status: 409, body: { ok: false, code: 'LINE_CONVERTED', message: '매입 등록된 줄입니다. 먼저 전환 취소하세요.' } };
      const m = await engine.matchLines(client, cx, { lineIds: [lineId], trigger: 'REMATCH_LINE', autoConvert: false });
      return { status: 200, body: { ok: true, data: m.lines[0] ? lineResult(m.lines[0]) : null } };
    });
  });

  // ---- R-126 줄 수정 + 재대조 ----
  app.patch('/api/purchase-docs/lines/:lineId', async (req, res) => {
    const auth = await authOf(req, res);
    if (!auth) return undefined;
    const lineId = idParam(req.params.lineId);
    if (!lineId) return NF(res, '줄');
    const b = req.body || {};
    if (b.version == null || !Number.isInteger(Number(b.version))) return res.status(400).json({ ok: false, code: 'VALIDATION', field: 'version', message: '줄 version 을 함께 보내세요.' });
    const EDITABLE = ['trade_date', 'arrival_date', 'item_name', 'item', 'grade', 'spec', 'qty', 'unit_price', 'amount', 'origin', 'auction_ref', 'buyer_code', 'product_id'];
    const bad = Object.keys(b).find((k) => k !== 'version' && !EDITABLE.includes(k));
    if (bad) return res.status(400).json({ ok: false, code: 'VALIDATION', field: bad, message: `바꿀 수 없는 칸입니다: ${bad}` });
    return inTx(req, res, auth, { route: 'R-126', body: b }, async (client, cx) => {
      const rows = await engine.lockLines(client, cx.userId, [lineId]);
      const l = rows[0];
      if (!l) return { status: 404, body: { ok: false, code: 'NOT_FOUND', message: '줄을 찾을 수 없습니다.' } };
      if (l.doc_status === 'CANCELLED') return { status: 409, body: { ok: false, code: 'DOC_CANCELLED', message: '취소된 매입서입니다.' } };
      if (l.status === 'CONVERTED') return { status: 409, body: { ok: false, code: 'LINE_CONVERTED', message: '매입 등록된 줄입니다. 먼저 전환 취소하세요.' } };
      if (Number(b.version) !== Number(l.version)) return { status: 409, body: { ok: false, code: 'VERSION_CONFLICT', message: '다른 사람이 이 줄을 먼저 바꿨습니다.', detail: { line: lineView(l) } } };
      const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
      const merged = {
        trade_date: has('trade_date') ? b.trade_date : l.trade_date, arrival_date: has('arrival_date') ? b.arrival_date : l.arrival_date,
        supplier_partner_id: l.supplier_partner_id, item: has('item_name') ? b.item_name : has('item') ? b.item : l.item_name_raw,
        grade: has('grade') ? b.grade : l.grade_raw, spec: has('spec') ? b.spec : l.pkg_raw, qty: has('qty') ? b.qty : l.qty,
        unit_price: has('unit_price') ? b.unit_price : String(l.unit_price), amount: has('amount') ? b.amount : (has('qty') || has('unit_price') ? null : String(l.amount)),
        origin: has('origin') ? b.origin : l.origin_name, auction_ref: has('auction_ref') ? b.auction_ref : l.auction_ref, buyer_code: has('buyer_code') ? b.buyer_code : l.buyer_code,
        product_id: has('product_id') ? b.product_id : l.product_id,
      };
      const lk = await makeLookup(client, cx.userId).init();
      const v = await P.buildLine(merged, lk);
      if (v.errors.length) return { status: 400, body: { ok: false, code: 'VALIDATION', field: v.errors[0].field, message: v.errors[0].message, errors: v.errors } };
      const n = v.line;
      await client.query(
        `UPDATE purchase_doc_line SET trade_date = $2, arrival_date = $3, item_name_raw = $4, item_key = $5, grade_raw = $6, grade_norm = $7, pkg_raw = $8, pkg_norm = $9,
                unit_qty_kg = $10::numeric, weight_source = $11, qty = $12::numeric, unit_price = $13::bigint, amount = COALESCE($14::bigint, ROUND($12::numeric * $13::bigint)::bigint),
                origin_name = $15, auction_ref = $16, buyer_code = $17, product_id = $18, line_fingerprint = $19,
                match_result = NULL, match_score = NULL, best_trade_id = NULL, candidate_count = NULL, reason_codes = '{}', warning_flags = '{}',
                status = CASE WHEN status = 'REJECTED' THEN 'PENDING' ELSE status END, rejected_at = NULL, version = version + 1, updated_at = NOW()
          WHERE id = $1`,
        [l.id, n.trade_date, n.arrival_date, n.item_name_raw, n.item_key, n.grade_raw, n.grade_norm, n.pkg_raw, n.pkg_norm, n.unit_qty_kg, n.weight_source, n.qty, n.unit_price, n.amount,
          n.origin_name, n.auction_ref, n.buyer_code, n.product_id, n.line_fingerprint]
      );
      await client.query(`INSERT INTO purchase_match_event (user_id, doc_id, line_id, event_type, from_status, to_status, detail, actor_kind, actor_staff_id) VALUES ($1,$2,$3,'LINE_EDIT',$4,$4,$5::jsonb,$6,$7)`,
        [cx.userId, l.doc_id, l.id, l.status, JSON.stringify({ changed: Object.keys(b).filter((k) => k !== 'version') }), cx.actorKind, cx.actorKind === 'STAFF' ? cx.staffId : null]);
      const m = await engine.matchLines(client, cx, { lineIds: [l.id], trigger: 'LINE_EDIT', autoConvert: false, eventType: 'REMATCH' });
      return { status: 200, body: { ok: true, data: m.lines[0] ? { ...lineResult(m.lines[0]), warnings: v.warnings } : null } };
    });
  });

  // ---- R-128 수동 확정 (주인) ----
  app.post('/api/purchase-docs/lines/:lineId/confirm', async (req, res) => {
    const auth = await authOf(req, res);
    if (!auth) return undefined;
    const lineId = idParam(req.params.lineId);
    if (!lineId) return NF(res, '줄');
    const key = idem.requireKey(req, res);
    if (!key) return undefined;
    const b = req.body || {};
    return inTx(req, res, auth, { key, route: 'R-128', body: { lineId, ...b } }, (client, cx) => convert.confirmLine(client, cx, lineId, b));
  });

  // ---- R-129 매입 아님 (주인) ----
  app.post('/api/purchase-docs/lines/:lineId/reject', async (req, res) => {
    const auth = await authOf(req, res);
    if (!auth) return undefined;
    const lineId = idParam(req.params.lineId);
    if (!lineId) return NF(res, '줄');
    const reason = (req.body || {}).reason != null ? String(req.body.reason).trim() : '';
    if (reason.length < 2) return res.status(400).json({ ok: false, code: 'REASON_REQUIRED', field: 'reason', message: '사유를 2자 이상 입력하세요.' });
    if (reason.length > 200) return res.status(400).json({ ok: false, code: 'VALIDATION', field: 'reason', message: '사유는 200자 이내로 입력하세요.' });
    return inTx(req, res, auth, { route: 'R-129', body: {} }, async (client, cx) => {
      const rows = await engine.lockLines(client, cx.userId, [lineId]);
      const l = rows[0];
      if (!l) return { status: 404, body: { ok: false, code: 'NOT_FOUND', message: '줄을 찾을 수 없습니다.' } };
      if (l.status === 'CONVERTED') return { status: 409, body: { ok: false, code: 'LINE_CONVERTED', message: '매입 등록된 줄입니다. 먼저 전환 취소하세요.' } };
      if (l.status === 'REJECTED') return { status: 409, body: { ok: false, code: 'ALREADY_REJECTED', message: '이미 매입 아님으로 정리된 줄입니다.' } };
      await client.query(`UPDATE purchase_doc_line SET status = 'REJECTED', rejected_at = NOW(), reject_reason = $2, version = version + 1, updated_at = NOW() WHERE id = $1`, [l.id, reason]);
      await client.query(`INSERT INTO purchase_match_event (user_id, doc_id, line_id, event_type, from_status, to_status, reason, actor_kind, actor_staff_id) VALUES ($1,$2,$3,'REJECT',$4,'REJECTED',$5,$6,$7)`,
        [cx.userId, l.doc_id, l.id, l.status, reason, cx.actorKind, cx.actorKind === 'STAFF' ? cx.staffId : null]);
      const h = await client.query(`SELECT purchase_doc_recalc($1) AS s`, [l.doc_id]);
      return { status: 200, body: { ok: true, data: { line_id: Number(l.id), status: 'REJECTED', doc_status: h.rows[0].s } } };
    });
  });

  // ---- R-130 전환 취소 (주인) ----
  app.post('/api/purchase-docs/lines/:lineId/cancel', async (req, res) => {
    const auth = await authOf(req, res);
    if (!auth) return undefined;
    const lineId = idParam(req.params.lineId);
    if (!lineId) return NF(res, '줄');
    const key = idem.requireKey(req, res);
    if (!key) return undefined;
    const b = req.body || {};
    return inTx(req, res, auth, { key, route: 'R-130', body: { lineId, reason: b.reason } }, (client, cx) => convert.cancelLine(client, cx, lineId, b));
  });
}

function docView(d) {
  return {
    id: Number(d.id), doc_no: d.doc_no, doc_date: d.doc_date, input_kind: d.input_kind, upload_id: d.upload_id ? Number(d.upload_id) : null,
    supplier_partner_id: d.supplier_partner_id, supplier_name: d.supplier_name, corp_code: d.corp_code, status: d.status,
    line_count: d.line_count, amount_total: Number(d.amount_total),
    counts: { converted: d.converted_count, pending: d.pending_count, hold: d.hold_count, rejected: d.rejected_count, cancelled: d.cancelled_count },
    memo: d.memo, created_by_staff_id: d.created_by_staff_id, cancelled_at: d.cancelled_at, cancel_reason: d.cancel_reason, created_at: d.created_at, updated_at: d.updated_at,
  };
}
function lineView(r) {
  return {
    id: Number(r.id), doc_id: Number(r.doc_id), line_no: r.line_no, source_line_no: r.source_line_no, status: r.status, version: r.version,
    trade_date: r.trade_date, arrival_date: r.arrival_date, item_name_raw: r.item_name_raw, item_key: r.item_key,
    item_label: r.family_name ? `${r.family_name} · ${r.variety_name}` : null, grade_raw: r.grade_raw, grade_norm: r.grade_norm,
    pkg_raw: r.pkg_raw, pkg_norm: r.pkg_norm, unit_qty_kg: r.unit_qty_kg, weight_source: r.weight_source,
    qty: r.qty, unit_price: Number(r.unit_price), amount: Number(r.amount), amount_calc_diff: Number(r.amount_calc_diff),
    origin_name: r.origin_name, shipper_name_masked: r.shipper_name_masked, auction_ref: r.auction_ref, buyer_code: r.buyer_code, product_id: r.product_id,
    match_result: r.match_result, match_score: r.match_score, best_trade_id: r.best_trade_id ? Number(r.best_trade_id) : null, candidate_count: r.candidate_count,
    reason_codes: r.reason_codes || [], warning_flags: r.warning_flags || [], last_run_id: r.last_run_id ? Number(r.last_run_id) : null, matched_at: r.matched_at,
    rejected_at: r.rejected_at, reject_reason: r.reject_reason,
    convertible: r.status === 'PENDING' && r.match_result === 'EXACT' && !(r.reason_codes || []).length,
  };
}
function lineResult(x) {
  return {
    id: x.id, line_no: x.line_no, status: x.status, match_result: x.match_result, score: x.score, reason_codes: x.reason_codes, warning_flags: x.warning_flags,
    candidate_count: x.candidate_count, best_trade_id: x.best_trade_id, convertible: !!x.convertible,
    ...(x.purchase_id ? { purchase_id: x.purchase_id, conversion_id: x.conversion_id } : {}), ...(x.convert_error ? { convert_error: x.convert_error } : {}),
  };
}

module.exports = { registerPurchaseDocRoutes, makeLookup, validateRows, lineView, docView };
