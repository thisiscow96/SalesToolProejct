'use strict';
/**
 * T-203 경락 조회·수집 현황·수동 동기화·작업·원천 로그·달력·일정·내부 tick 라우트 (설계 4.1, R-92~R-102 · R-132~R-135)
 *  - 사용자 조회는 언제나 DB 만 읽는다(외부 호출은 큐 작업만). 응답 meta { as_of, snapshot_status, phase, stale, source_mode }.
 *  - 권한은 lib/access.js 표. 관리자 라우트는 표에서 OWNER, 여기서 auth.isAdmin 을 본다(직원은 주인이 관리자여도 false).
 *  - 키 값은 어디에도 내보내지 않는다(source_mode 만).
 */
const crypto = require('crypto');
const { parseListOptions, runList } = require('../list-query');
const queue = require('./queue');
const circuit = require('./circuit');
const scheduler = require('./scheduler');
const worker = require('./worker');
const { sourceMode } = require('./adapters');
const { maskName } = require('./mask');

const YMD = /^\d{4}-\d{2}-\d{2}$/;
function validYmd(s) {
  if (!YMD.test(String(s || ''))) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const vErr = (res, field, message, code = 'VALIDATION') => res.status(400).json({ ok: false, code, field, message });
const toInt = (v) => (v == null ? null : Number(v));
const idParam = (s) => (/^\d{1,15}$/.test(String(s || '')) && Number(s) > 0 ? Number(s) : null);
const SOURCES = ['AT_REALTIME', 'GARAK_PRICE'];
const GRADE_LABEL = { SPECIAL: '특', HIGH: '상', MID: '중', LOW: '하', OFF: '등외', NONE: '무등급' };
const STATUS_RANK = { FAILED: 7, PARTIAL: 6, RUNNING: 5, NOT_YET: 4, EMPTY: 3, HOLIDAY: 2, COMPLETE: 1 };

function iso(d) {
  if (!d) return null;
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? null : new Date(t.getTime() + 9 * 3600 * 1000).toISOString().replace(/\.\d{3}Z$/, '+09:00');
}

function tradeOut(r) {
  return {
    id: Number(r.id), source: r.source, trade_date: r.trade_date, auction_at: iso(r.auction_at),
    market_code: r.market_code, market_name: r.market_name, corp_code: r.corp_code, corp_name: r.corp_name,
    item_key: r.item_key, item_label: r.family_name ? `${r.family_name} · ${r.variety_name}` : null, item_name_raw: r.item_name_raw, map_status: r.map_status,
    grade_norm: r.grade_norm, grade_name: r.grade_name || (r.grade_norm ? GRADE_LABEL[r.grade_norm] : null),
    pkg_name: r.pkg_name, pkg_norm: r.pkg_norm, unit_qty_kg: r.unit_qty_kg, weight_source: r.weight_source,
    qty: r.qty, unit_price: toInt(r.unit_price), price_per_kg: r.price_per_kg, amount: toInt(r.amount),
    origin_name: r.origin_name, shipper_name_masked: r.shipper_name_masked, buyer_code: r.buyer_code, auction_seq: r.auction_seq,
    // T-203 030 실 API 칸(목업 행은 null)
    shipment_no: r.shipment_no || null, trade_type: r.trade_type || null, corp_item_name: r.corp_item_name || null, corp_variety_name: r.corp_variety_name || null,
    source_modified_at: iso(r.source_modified_at),
    revision: r.revision, withdrawn_at: iso(r.withdrawn_at),
  };
}

/** 날짜 범위의 날짜별 최신 스냅샷 + meta (D 4.5) */
async function rangeMeta(db, { from, to, source = 'AT_REALTIME', market }) {
  const r = await db.query(
    `SELECT DISTINCT ON (trade_date) trade_date, phase, status, fetched_count, total_count, unmapped, finished_at, started_at, is_latest_ok, verify_warning
       FROM collect_snapshot WHERE source = $1 AND market_code = $2 AND trade_date BETWEEN $3 AND $4
      ORDER BY trade_date, id DESC`,
    [source, market, from, to]
  );
  const ok = await db.query(
    `SELECT trade_date, phase, status, finished_at FROM collect_snapshot
      WHERE source = $1 AND market_code = $2 AND trade_date BETWEEN $3 AND $4 AND is_latest_ok ORDER BY trade_date`,
    [source, market, from, to]
  );
  const okBy = new Map(ok.rows.map((x) => [x.trade_date, x]));
  const cir = await db.query(`SELECT state, disabled_reason FROM ext_circuit_state WHERE source = $1`, [source]);
  const circuitBad = cir.rows[0] && (cir.rows[0].state !== 'CLOSED' || cir.rows[0].disabled_reason);
  let stale = !!circuitBad;
  let worst = null;
  let asOf = null;
  const days = r.rows.map((x) => {
    const good = okBy.get(x.trade_date);
    if (['FAILED', 'RUNNING', 'PARTIAL'].includes(x.status) && good) stale = true;
    const shown = good && ['FAILED', 'RUNNING', 'PARTIAL', 'NOT_YET'].includes(x.status) ? good : x;
    if (!worst || STATUS_RANK[x.status] > STATUS_RANK[worst]) worst = x.status;
    const fin = good ? good.finished_at : null;
    if (fin && (!asOf || new Date(fin) > new Date(asOf))) asOf = fin;
    return {
      trade_date: x.trade_date, source, phase: shown.phase, status: x.status, ok_status: good ? good.status : null, ok_phase: good ? good.phase : null,
      fetched_count: x.fetched_count, total_count: x.total_count, unmapped: x.unmapped, verify_warning: x.verify_warning, finished_at: iso(x.finished_at),
    };
  });
  const lastOk = ok.rows[ok.rows.length - 1];
  return {
    meta: { as_of: iso(asOf), snapshot_status: worst, phase: lastOk ? lastOk.phase : null, stale, source_mode: sourceMode(source) },
    days,
  };
}

function registerAuctionRoutes(app, deps) {
  const { pool, getUserId, getUserIdAndAdmin, recordAudit, hooks } = deps;
  const market = () => worker.marketCode();

  async function needUser(req, res) {
    const userId = await getUserId(req);
    if (!userId) { res.status(401).json({ ok: false, message: '로그인이 필요합니다.' }); return null; }
    return userId;
  }
  async function needAdmin(req, res) {
    const auth = await getUserIdAndAdmin(req);
    if (!auth) { res.status(401).json({ ok: false, message: '로그인이 필요합니다.' }); return null; }
    if (!auth.isAdmin) { res.status(403).json({ ok: false, code: 'ADMIN_ONLY', message: '관리자만 할 수 있습니다.' }); return null; }
    return auth;
  }
  const fail = (res, err, msg) => {
    console.error(`[auction] ${msg}:`, err.message);
    res.status(500).json({ ok: false, message: msg });
  };

  // ---- R-92 경락 목록 ----
  app.get('/api/auction/trades', async (req, res) => {
    if (!(await needUser(req, res))) return undefined;
    const q = req.query || {};
    const from = String(q.date_from || '').trim();
    const to = String(q.date_to || '').trim();
    if (!validYmd(from)) return vErr(res, 'date_from', '조회 시작일을 YYYY-MM-DD 로 지정하세요.');
    if (!validYmd(to)) return vErr(res, 'date_to', '조회 종료일을 YYYY-MM-DD 로 지정하세요.');
    if (from > to) return vErr(res, 'date_from', '시작일이 종료일보다 늦습니다.');
    if (daysBetween(from, to) > 30) return vErr(res, 'date_to', '조회 기간은 31일 이내로 지정하세요.');
    const opts = parseListOptions({ limit: q.limit || 50, offset: q.offset });
    if (opts.error) return res.status(400).json(opts.error);
    const params = [from, to];
    const where = ['t.trade_date BETWEEN $1 AND $2'];
    const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (q.family) {
      const f = String(q.family).toUpperCase();
      if (!/^[A-Z0-9]{1,20}$/.test(f)) return vErr(res, 'family', '품목군이 올바르지 않습니다.');
      add("split_part(t.item_key, '.', 1) = ?", f);
    }
    if (q.item_key) {
      const keys = String(q.item_key).split(',').map((s) => s.trim()).filter(Boolean);
      if (!keys.length || keys.length > 20 || keys.some((k) => !/^[A-Z0-9]+\.[A-Z0-9_]+$/.test(k))) return vErr(res, 'item_key', '품종 값이 올바르지 않습니다.');
      add('t.item_key = ANY(?::text[])', keys);
    }
    if (q.grade) {
      const g = String(q.grade).toUpperCase();
      if (!GRADE_LABEL[g]) return vErr(res, 'grade', '등급 값이 올바르지 않습니다.');
      add('t.grade_norm = ?', g);
    }
    if (q.pkg) add('t.pkg_norm = ?', String(q.pkg).toUpperCase().slice(0, 20));
    if (q.unit_kg) {
      if (!/^\d+(\.\d{1,3})?$/.test(String(q.unit_kg))) return vErr(res, 'unit_kg', '규격(kg)이 올바르지 않습니다.');
      add('t.unit_qty_kg = ?::numeric', String(q.unit_kg));
    }
    if (q.origin) add("t.origin_name ILIKE ?", `%${String(q.origin).slice(0, 50).replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    if (q.corp_code) add('t.corp_code = ?', String(q.corp_code).slice(0, 10));
    if (q.source) {
      const s = String(q.source).toUpperCase();
      if (!['AT_REALTIME', 'MOCK', 'AT_SETTLE', 'GARAK_PRICE'].includes(s)) return vErr(res, 'source', '소스 값이 올바르지 않습니다.');
      add('t.source = ?', s);
    }
    if (!(q.include_unmapped === 'true' || q.include_unmapped === '1')) where.push("t.map_status = 'MAPPED'");
    if (!(q.include_withdrawn === 'true' || q.include_withdrawn === '1')) where.push('t.withdrawn_at IS NULL');
    const sortMap = {
      trade_date: ' ORDER BY t.trade_date DESC, t.auction_at DESC NULLS LAST, t.id DESC',
      unit_price: ' ORDER BY t.unit_price DESC, t.id DESC',
      price_per_kg: ' ORDER BY t.price_per_kg DESC NULLS LAST, t.id DESC',
    };
    const order = sortMap[String(q.sort || 'trade_date')];
    if (!order) return vErr(res, 'sort', '정렬 값이 올바르지 않습니다.');
    try {
      const base = `SELECT t.*, mi.family_name, mi.variety_name FROM auction_trade t LEFT JOIN market_item mi ON mi.item_key = t.item_key WHERE ${where.join(' AND ')}`;
      const out = await runList(pool, base, params, order, opts);
      const m = await rangeMeta(pool, { from, to, market: market() });
      res.setHeader('Cache-Control', 'private, max-age=30');
      return res.json({ ok: true, meta: m.meta, data: out.data.map(tradeOut), total: out.total, limit: out.limit, offset: out.offset, days: m.days });
    } catch (err) { return fail(res, err, '경락 목록을 불러오지 못했습니다.'); }
  });

  // ---- R-93 경락 상세 ----
  app.get('/api/auction/trades/:id', async (req, res) => {
    if (!(await needUser(req, res))) return undefined;
    const id = idParam(req.params.id);
    if (!id) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: '경락 건을 찾을 수 없습니다.' });
    try {
      const r = await pool.query(`SELECT t.*, mi.family_name, mi.variety_name FROM auction_trade t LEFT JOIN market_item mi ON mi.item_key = t.item_key WHERE t.id = $1`, [id]);
      if (!r.rows[0]) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: '경락 건을 찾을 수 없습니다.' });
      const h = await pool.query(`SELECT revision, old_values, replaced_at FROM auction_trade_history WHERE trade_id = $1 ORDER BY revision`, [id]);
      const t = r.rows[0];
      return res.json({ ok: true, data: { ...tradeOut(t), first_seen_at: iso(t.first_seen_at), last_seen_at: iso(t.last_seen_at), snapshot_id: Number(t.snapshot_id),
        history: h.rows.map((x) => ({ revision: x.revision, replaced_at: iso(x.replaced_at),
          values: { unit_price: toInt(x.old_values.unit_price), qty: x.old_values.qty, grade_norm: x.old_values.grade_norm, unit_qty_kg: x.old_values.unit_qty_kg, amount: toInt(x.old_values.amount) } })) } });
    } catch (err) { return fail(res, err, '경락 상세를 불러오지 못했습니다.'); }
  });

  // ---- R-94 참고 시세 ----
  app.get('/api/auction/daily-prices', async (req, res) => {
    if (!(await needUser(req, res))) return undefined;
    const date = String((req.query || {}).date || '').trim();
    if (!validYmd(date)) return vErr(res, 'date', '날짜를 YYYY-MM-DD 로 지정하세요.');
    const params = [date];
    let extra = '';
    if (req.query.family) { params.push(String(req.query.family).toUpperCase()); extra += ` AND split_part(m.item_key, '.', 1) = $${params.length}`; }
    if (req.query.item_key) { params.push(String(req.query.item_key)); extra += ` AND m.item_key = $${params.length}`; }
    try {
      const r = await pool.query(
        `SELECT m.price_date, m.item_key, m.item_name_raw, m.grade_name, m.unit_name, m.avg_price, m.prev_price, m.source,
                (m.avg_price - m.prev_price) AS diff,
                CASE WHEN m.prev_price > 0 THEN ROUND((m.avg_price - m.prev_price)::numeric * 100 / m.prev_price, 2) END AS diff_pct
           FROM market_price_daily m WHERE m.price_date = $1 ${extra} ORDER BY m.item_name_raw, m.grade_name`,
        params
      );
      return res.json({ ok: true, data: r.rows.map((x) => ({ ...x, avg_price: toInt(x.avg_price), prev_price: toInt(x.prev_price), diff: toInt(x.diff), diff_pct: x.diff_pct })), source_mode: sourceMode('GARAK_PRICE') });
    } catch (err) { return fail(res, err, '참고 시세를 불러오지 못했습니다.'); }
  });

  // ---- R-95 내부 품목 ----
  app.get('/api/auction/items', async (req, res) => {
    if (!(await needUser(req, res))) return undefined;
    try {
      const r = await pool.query(`SELECT item_key, family, family_name, variety_name, default_product_name, active FROM market_item ORDER BY sort_order, item_key`);
      return res.json({ ok: true, data: r.rows });
    } catch (err) { return fail(res, err, '품목 목록을 불러오지 못했습니다.'); }
  });

  // ---- R-137 법인 목록 — 경락 조회 [법인] 선택지. 조회 결과(현재 페이지)가 아니라 이 시장의 전체 법인 ----
  //  수집된 경락의 DISTINCT corp_code(이름 = 가장 최근 경락의 법인명) + 표준코드(code_master corp, 이 시장 코드로 시작)
  app.get('/api/auction/corps', async (req, res) => {
    if (!(await needUser(req, res))) return undefined;
    try {
      const r = await pool.query(
        `WITH t AS (
           SELECT DISTINCT ON (corp_code) corp_code, corp_name FROM auction_trade
            WHERE market_code = $1 AND corp_code IS NOT NULL AND corp_code <> '' ORDER BY corp_code, id DESC
         ), c AS (
           SELECT code AS corp_code, name AS corp_name FROM code_master
            WHERE code_type = 'corp' AND (parent_code = $1 OR code LIKE $1 || '%')
         )
         SELECT COALESCE(t.corp_code, c.corp_code) AS corp_code,
                COALESCE(NULLIF(btrim(t.corp_name), ''), NULLIF(btrim(c.corp_name), ''), COALESCE(t.corp_code, c.corp_code)) AS corp_name,
                (t.corp_code IS NOT NULL) AS has_trades
           FROM t FULL OUTER JOIN c ON c.corp_code = t.corp_code
          ORDER BY 1`,
        [market()]
      );
      return res.json({ ok: true, data: r.rows });
    } catch (err) { return fail(res, err, '법인 목록을 불러오지 못했습니다.'); }
  });

  // ---- R-96 수집 현황 ----
  app.get('/api/auction/sync/status', async (req, res) => {
    if (!(await needUser(req, res))) return undefined;
    const today = worker.kstToday();
    const from = String(req.query.date_from || worker.addDays(today, -6));
    const to = String(req.query.date_to || today);
    if (!validYmd(from) || !validYmd(to) || from > to || daysBetween(from, to) > 30) return vErr(res, 'date_from', '기간은 31일 이내의 YYYY-MM-DD 로 지정하세요.');
    try {
      const c = await pool.query(`SELECT source, state, consecutive_failures, next_probe_at, disabled_reason, disabled_until, last_error_kind, last_success_at FROM ext_circuit_state ORDER BY source`);
      const d = await pool.query(
        `SELECT DISTINCT ON (trade_date, source, phase) trade_date, source, phase, status, total_count, fetched_count, unmapped, verify_warning, error_kind, finished_at, is_latest_ok
           FROM collect_snapshot WHERE market_code = $1 AND trade_date BETWEEN $2 AND $3 ORDER BY trade_date DESC, source, phase, id DESC`,
        [market(), from, to]
      );
      const qj = await pool.query(
        `SELECT id, job_type, source, trade_date, phase, attempts, max_attempts, status, run_after, last_error_kind, created_at
           FROM collect_job WHERE status IN ('QUEUED','RUNNING') OR (status IN ('FAILED','DEAD') AND created_at > NOW() - interval '7 days')
          ORDER BY CASE status WHEN 'RUNNING' THEN 0 WHEN 'QUEUED' THEN 1 ELSE 2 END, run_after, id DESC LIMIT 50`
      );
      return res.json({
        ok: true,
        circuits: c.rows.map((x) => ({ ...x, next_probe_at: iso(x.next_probe_at), disabled_until: iso(x.disabled_until), last_success_at: iso(x.last_success_at),
          source_mode: x.source === 'MOCK' ? 'MOCK' : sourceMode(x.source) })),
        days: d.rows.map((x) => ({ ...x, finished_at: iso(x.finished_at) })),
        queue: qj.rows.map((x) => ({ ...x, id: Number(x.id), run_after: iso(x.run_after), created_at: iso(x.created_at) })),
        source_mode: sourceMode('AT_REALTIME'),
      });
    } catch (err) { return fail(res, err, '수집 현황을 불러오지 못했습니다.'); }
  });

  // ---- R-136 DB 사용량·경락 보관 기간(관리자) — 운영 무료 DB 한도 관리(T-203 후속) ----
  //   한도: DB_STORAGE_LIMIT_MB(기본 1024 = Neon 무료 프로젝트당 1GB, 0 이면 한도 없음 — 로컬 영구 DB). 80% 넘으면 warning
  app.get('/api/auction/storage', async (req, res) => {
    if (!(await needAdmin(req, res))) return undefined;
    try {
      const keep = worker.tradeRetention();
      const limitMb = process.env.DB_STORAGE_LIMIT_MB == null || process.env.DB_STORAGE_LIMIT_MB === '' ? 1024 : Number(process.env.DB_STORAGE_LIMIT_MB);
      const limitBytes = Number.isFinite(limitMb) && limitMb > 0 ? Math.round(limitMb * 1024 * 1024) : null;
      const db = await pool.query(`SELECT pg_database_size(current_database())::bigint AS bytes`);
      const tr = await pool.query(`SELECT COUNT(*)::bigint AS n, MIN(trade_date)::text AS oldest, MAX(trade_date)::text AS newest FROM auction_trade`);
      const tb = await pool.query(
        `SELECT c.relname AS name, pg_total_relation_size(c.oid)::bigint AS bytes
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = current_schema() AND c.relkind = 'r'
            AND c.relname = ANY($1::text[]) ORDER BY 2 DESC`,
        [['auction_trade', 'auction_trade_history', 'ext_raw_response', 'collect_snapshot', 'collect_job', 'market_price_daily', 'purchase_match_candidate', 'purchase_match_event']]
      );
      const lp = await pool.query(
        `SELECT id, status, result, finished_at FROM collect_job WHERE job_type = 'PURGE_RAW' AND status IN ('DONE','FAILED','DEAD') ORDER BY finished_at DESC NULLS LAST, id DESC LIMIT 1`
      );
      const bytes = Number(db.rows[0].bytes);
      const ratio = limitBytes ? Math.round((bytes / limitBytes) * 1000) / 1000 : null;
      let warning = null;
      if (ratio != null && ratio >= 0.8) {
        warning = `DB 사용량이 한도(${limitMb} MB)의 ${Math.floor(ratio * 100)}%입니다. 보관 기간(AUCTION_TRADE_KEEP_DAYS)을 줄이거나 정리 작업이 끝까지 도는지 확인하세요.`;
      } else if (keep.invalid) {
        warning = `보관 기간 설정 값(${keep.configured})이 올바르지 않아 경락을 지우지 않습니다. 1 이상의 정수로 지정하세요.`;
      }
      const last = lp.rows[0];
      return res.json({
        ok: true,
        data: {
          db_bytes: bytes,
          limit_bytes: limitBytes,
          usage_ratio: ratio,
          warn_ratio: 0.8,
          warning,
          trade_count: Number(tr.rows[0].n),
          oldest_trade_date: tr.rows[0].oldest,
          newest_trade_date: tr.rows[0].newest,
          tables: tb.rows.map((x) => ({ name: x.name, bytes: Number(x.bytes) })),
          retention: { ...keep, cutoff: keep.days ? worker.addDays(worker.kstToday(), -keep.days) : null },
          last_purge: last ? { id: Number(last.id), status: last.status, finished_at: iso(last.finished_at), result: last.result } : null,
        },
      });
    } catch (err) { return fail(res, err, 'DB 사용량을 불러오지 못했습니다.'); }
  });

  // ---- R-97 작업 목록 ----
  app.get('/api/auction/jobs', async (req, res) => {
    if (!(await needUser(req, res))) return undefined;
    const q = req.query || {};
    const opts = parseListOptions({ limit: q.limit || 50, offset: q.offset });
    if (opts.error) return res.status(400).json(opts.error);
    const params = [];
    const where = ['true'];
    if (q.status) {
      const st = String(q.status).toUpperCase().split(',').filter(Boolean);
      if (st.some((s) => !['QUEUED', 'RUNNING', 'DONE', 'FAILED', 'DEAD', 'CANCELLED'].includes(s))) return vErr(res, 'status', '상태 값이 올바르지 않습니다.');
      params.push(st); where.push(`j.status = ANY($${params.length}::text[])`);
    }
    if (q.source) { params.push(String(q.source).toUpperCase()); where.push(`j.source = $${params.length}`); }
    if (q.date_from) { if (!validYmd(q.date_from)) return vErr(res, 'date_from', '날짜 형식이 올바르지 않습니다.'); params.push(q.date_from); where.push(`j.trade_date >= $${params.length}`); }
    if (q.date_to) { if (!validYmd(q.date_to)) return vErr(res, 'date_to', '날짜 형식이 올바르지 않습니다.'); params.push(q.date_to); where.push(`j.trade_date <= $${params.length}`); }
    try {
      const base = `SELECT j.id, j.job_type, j.source, j.market_code, j.trade_date, j.phase, j.status, j.attempts, j.max_attempts, j.run_after, j.result,
                           LEFT(j.last_error, 500) AS last_error, j.last_error_kind, j.requested_by, j.created_at, j.started_at, j.finished_at,
                           u.name AS requested_by_name
                      FROM collect_job j LEFT JOIN "user" u ON u.id = j.requested_by_user_id WHERE ${where.join(' AND ')}`;
      const out = await runList(pool, base, params, ' ORDER BY j.id DESC', opts);
      out.data = out.data.map((x) => ({ ...x, id: Number(x.id), run_after: iso(x.run_after), created_at: iso(x.created_at), started_at: iso(x.started_at), finished_at: iso(x.finished_at),
        requested_by_name: x.requested_by_name ? maskName(x.requested_by_name) : null, error_message: x.last_error }));
      return res.json(out);
    } catch (err) { return fail(res, err, '작업 목록을 불러오지 못했습니다.'); }
  });

  // ---- R-98 수동 동기화 (주인) ----
  app.post('/api/auction/sync', async (req, res) => {
    const auth = await getUserIdAndAdmin(req);
    if (!auth) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
    const b = req.body || {};
    const source = String(b.source || 'AT_REALTIME').toUpperCase();
    if (!SOURCES.includes(source)) return vErr(res, 'source', '소스 값이 올바르지 않습니다(AT_REALTIME·GARAK_PRICE).');
    const today = worker.kstToday();
    const from = String(b.date_from || b.date || today);
    const to = String(b.date_to || b.date || from);
    if (!validYmd(from)) return vErr(res, 'date_from', '최대 31일, 미래 날짜는 지정할 수 없습니다.');
    if (!validYmd(to) || from > to || to > today || daysBetween(from, to) > 30) return vErr(res, 'date_from', '최대 31일, 미래 날짜는 지정할 수 없습니다.');
    const phaseIn = b.phase ? String(b.phase).toUpperCase() : null;
    if (phaseIn && !['INTRADAY', 'FINAL'].includes(phaseIn)) return vErr(res, 'phase', '단계는 INTRADAY 또는 FINAL 입니다.');
    const force = b.force === true;
    const mockControl = process.env.NODE_ENV !== 'production' && String(process.env.AUCTION_MOCK_CONTROL || '').toLowerCase() === 'true';
    try {
      const cs = await pool.query(`SELECT state, next_probe_at, disabled_reason FROM ext_circuit_state WHERE source = $1`, [source]);
      const c = cs.rows[0];
      if (c && c.disabled_reason === 'AUTH_ERROR' && force && auth.isAdmin) await circuit.reset(pool, source); // 관리자가 키를 고친 뒤 다시 켬
      else if (c && (c.disabled_reason || (c.state === 'OPEN' && new Date(c.next_probe_at) > new Date()))) {
        const at = c.next_probe_at ? iso(c.next_probe_at) : null;
        const msg = c.disabled_reason === 'AUTH_ERROR' ? '외부 시세 API 인증 오류로 멈춤 상태입니다(API 키 확인 필요).'
          : c.disabled_reason === 'QUOTA' ? '오늘 외부 시세 API 호출 한도를 넘었습니다(내일 다시 시도).'
            : `외부 시세 API가 잠시 멈춤 상태입니다(${at ? at.slice(11, 16) : ''}에 다시 시도).`;
        return res.status(409).json({ ok: false, code: 'CIRCUIT_OPEN', message: msg, detail: { next_probe_at: at, disabled_reason: c.disabled_reason } });
      }
      const minute = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace(/[-T:]/g, '');
      const dates = [];
      for (let d = from; d <= to; d = worker.addDays(d, 1)) dates.push(d);
      const plan = dates.map((d) => {
        const phase = phaseIn || (d < today ? 'FINAL' : 'INTRADAY');
        return { d, phase, key: `COLLECT:${source}:${market()}:${d}:${phase}:MANUAL:${auth.userId}:${minute}` };
      });
      const dup = await pool.query(`SELECT dedupe_key FROM collect_job WHERE dedupe_key = ANY($1::text[])`, [plan.map((p) => p.key)]);
      const dupSet = new Set(dup.rows.map((r) => r.dedupe_key));
      if (dupSet.size === plan.length) {
        return res.status(202).json({ ok: true, data: { queued: [], skipped: plan.map((p) => ({ target_date: p.d, reason: 'ALREADY_QUEUED' })) } });
      }
      // 회원별 5분 1회(C D01): 최근 5분 안 수동 작업이 있고, 이번 요청에 그 작업들에 없는 키(새 날짜)가 하나라도 있으면 429.
      // 같은 분에 같은 범위를 다시 누른 경우(모든 키가 이미 있음)는 위에서 202 ALREADY_QUEUED, 동시에 들어온 같은 요청은 enqueue 의 dedupe 가 막는다.
      const recent = await pool.query(
        `SELECT dedupe_key, created_at FROM collect_job WHERE requested_by_user_id = $1 AND created_at > NOW() - interval '5 minutes' AND dedupe_key LIKE '%:MANUAL:%'
          ORDER BY created_at DESC LIMIT 200`,
        [auth.userId]
      );
      const recentKeys = new Set(recent.rows.map((r) => r.dedupe_key));
      if (recent.rows.length && plan.some((p) => !recentKeys.has(p.key))) {
        const wait = Math.max(1, 300 - Math.floor((Date.now() - new Date(recent.rows[0].created_at).getTime()) / 1000));
        return res.status(429).json({ ok: false, code: 'SYNC_RATE_LIMIT', message: '수동 동기화는 5분에 한 번만 할 수 있습니다.', detail: { retry_after_sec: wait } });
      }
      const queued = [];
      const skipped = [];
      for (const p of plan) {
        if (dupSet.has(p.key)) { skipped.push({ target_date: p.d, reason: 'ALREADY_QUEUED' }); continue; }
        // eslint-disable-next-line no-await-in-loop
        const hol = await pool.query(`SELECT 1 FROM market_calendar WHERE market_code = $1 AND cal_date = $2 AND kind = 'HOLIDAY'`, [market(), p.d]);
        if (hol.rows[0] && !force) { skipped.push({ target_date: p.d, reason: 'HOLIDAY' }); continue; }
        if (!force) {
          // eslint-disable-next-line no-await-in-loop
          const done = await pool.query(
            `SELECT 1 FROM collect_snapshot WHERE source = $1 AND market_code = $2 AND trade_date = $3 AND phase = $4 AND is_latest_ok AND status = 'COMPLETE'`,
            [source, market(), p.d, p.phase]
          );
          if (done.rows[0]) { skipped.push({ target_date: p.d, reason: 'ALREADY_COMPLETE' }); continue; }
        }
        const params = { reason: 'MANUAL' };
        if (mockControl && b.mock_scenario) params.mock_scenario = String(b.mock_scenario).slice(0, 200);
        // eslint-disable-next-line no-await-in-loop
        const r = await queue.enqueue(pool, { job_type: 'COLLECT', source, market_code: market(), trade_date: p.d, phase: p.phase, params, dedupe_key: p.key,
          requested_by_user_id: auth.userId, requested_by_staff_id: auth.staffId || null });
        if (r.created) queued.push({ id: r.id, target_date: p.d, phase: p.phase });
        else skipped.push({ target_date: p.d, reason: 'ALREADY_QUEUED' });
      }
      if (queued.length) {
        await recordAudit(pool, { userId: auth.userId, entityType: 'market_sync', entityId: queued[0].id, action: 'sync', before: null,
          after: { source, date_from: from, date_to: to, jobs: queued.length, force }, note: `수동 동기화 ${source} ${from}~${to} ${queued.length}건` });
      }
      return res.status(202).json({ ok: true, data: { queued, skipped } });
    } catch (err) { return fail(res, err, '수동 동기화를 넣지 못했습니다.'); }
  });

  // ---- R-99 대기 작업 취소 (관리자) ----
  app.post('/api/auction/jobs/:id/cancel', async (req, res) => {
    const auth = await needAdmin(req, res);
    if (!auth) return undefined;
    const id = idParam(req.params.id);
    if (!id) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: '작업을 찾을 수 없습니다.' });
    try {
      const r = await pool.query(`UPDATE collect_job SET status = 'CANCELLED', finished_at = NOW() WHERE id = $1 AND status = 'QUEUED' RETURNING id`, [id]);
      if (r.rows[0]) {
        await recordAudit(pool, { userId: auth.userId, entityType: 'market_sync', entityId: id, action: 'cancel', before: { status: 'QUEUED' }, after: { status: 'CANCELLED' }, note: `수집 작업 #${id} 취소` });
        return res.json({ ok: true, data: { id, status: 'CANCELLED' } });
      }
      const cur = await pool.query(`SELECT status FROM collect_job WHERE id = $1`, [id]);
      if (!cur.rows[0]) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: '작업을 찾을 수 없습니다.' });
      if (cur.rows[0].status === 'RUNNING') return res.status(409).json({ ok: false, code: 'JOB_RUNNING', message: '실행 중인 작업은 취소할 수 없습니다.' });
      return res.status(409).json({ ok: false, code: 'JOB_NOT_QUEUED', message: '대기 중인 작업만 취소할 수 있습니다.' });
    } catch (err) { return fail(res, err, '작업을 취소하지 못했습니다.'); }
  });

  // ---- R-132 실패 작업 다시 실행 (주인) ----
  app.post('/api/auction/jobs/:id/retry', async (req, res) => {
    const auth = await getUserIdAndAdmin(req);
    if (!auth) return res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
    const id = idParam(req.params.id);
    if (!id) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: '작업을 찾을 수 없습니다.' });
    try {
      const r = await pool.query(`SELECT * FROM collect_job WHERE id = $1`, [id]);
      const j = r.rows[0];
      if (!j) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: '작업을 찾을 수 없습니다.' });
      if (!['FAILED', 'DEAD'].includes(j.status)) return res.status(409).json({ ok: false, code: 'JOB_NOT_FAILED', message: '실패한 작업만 다시 실행할 수 있습니다.' });
      let runAfter = null;
      if (j.source) {
        const c = await pool.query(`SELECT state, next_probe_at FROM ext_circuit_state WHERE source = $1`, [j.source]);
        if (c.rows[0] && c.rows[0].state === 'OPEN' && new Date(c.rows[0].next_probe_at) > new Date()) runAfter = c.rows[0].next_probe_at;
      }
      const e = await queue.enqueue(pool, { job_type: j.job_type, source: j.source, market_code: j.market_code, trade_date: j.trade_date, phase: j.phase,
        params: { ...(j.params || {}), retry_of: Number(j.id) }, dedupe_key: `RETRY:${j.id}:${Date.now()}`, run_after: runAfter,
        requested_by_user_id: auth.userId, requested_by_staff_id: auth.staffId || null });
      await recordAudit(pool, { userId: auth.userId, entityType: 'market_sync', entityId: e.id, action: 'sync', before: null, after: { retry_of: Number(j.id) }, note: `수집 작업 #${j.id} 다시 실행` });
      return res.status(202).json({ ok: true, data: { id: e.id, run_after: iso(runAfter) } });
    } catch (err) { return fail(res, err, '작업을 다시 넣지 못했습니다.'); }
  });

  // ---- R-100 원천 응답 본문 (관리자, 조회 기록) ----
  app.get('/api/auction/raw/:id', async (req, res) => {
    const auth = await needAdmin(req, res);
    if (!auth) return undefined;
    const id = idParam(req.params.id);
    if (!id) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: '원천 기록을 찾을 수 없습니다.' });
    try {
      const r = await pool.query(`SELECT id, job_id, source, request_url_masked, request_params, page_no, http_status, kind, body, body_truncated, body_hash, row_count, duration_ms, fetched_at FROM ext_raw_response WHERE id = $1`, [id]);
      if (!r.rows[0]) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: '원천 기록을 찾을 수 없습니다.' });
      await recordAudit(pool, { userId: auth.userId, entityType: 'market_sync', entityId: id, action: 'update', before: null, after: { raw_id: id }, note: 'raw 조회' });
      return res.json({ ok: true, data: { ...r.rows[0], id: Number(r.rows[0].id), fetched_at: iso(r.rows[0].fetched_at) } });
    } catch (err) { return fail(res, err, '원천 기록을 불러오지 못했습니다.'); }
  });

  // ---- R-101 시장 달력 ----
  app.get('/api/auction/calendar', async (req, res) => {
    if (!(await needUser(req, res))) return undefined;
    const mk = String(req.query.market_code || market()).slice(0, 10);
    const from = req.query.date_from && validYmd(req.query.date_from) ? req.query.date_from : worker.addDays(worker.kstToday(), -60);
    const to = req.query.date_to && validYmd(req.query.date_to) ? req.query.date_to : worker.addDays(worker.kstToday(), 365);
    try {
      const r = await pool.query(`SELECT market_code, cal_date, kind, note, updated_at FROM market_calendar WHERE market_code = $1 AND cal_date BETWEEN $2 AND $3 ORDER BY cal_date`, [mk, from, to]);
      return res.json({ ok: true, data: r.rows.map((x) => ({ ...x, updated_at: iso(x.updated_at) })) });
    } catch (err) { return fail(res, err, '시장 달력을 불러오지 못했습니다.'); }
  });

  // ---- R-102 시장 달력 저장 (관리자) ----
  app.put('/api/auction/calendar', async (req, res) => {
    const auth = await needAdmin(req, res);
    if (!auth) return undefined;
    const b = req.body || {};
    const mk = String(b.market_code || market()).slice(0, 10);
    const add = Array.isArray(b.add) ? b.add : [];
    const remove = Array.isArray(b.remove) ? b.remove : [];
    if (add.length + remove.length === 0) return vErr(res, 'add', '추가하거나 지울 날짜를 넣으세요.');
    if (add.length + remove.length > 400) return vErr(res, 'add', '한 번에 400일까지 바꿀 수 있습니다.');
    for (const a of add) {
      if (!a || !validYmd(a.cal_date)) return vErr(res, 'add', '날짜는 YYYY-MM-DD 로 넣으세요.');
      if (a.kind && !['HOLIDAY', 'SPECIAL'].includes(a.kind)) return vErr(res, 'add', '종류는 HOLIDAY 또는 SPECIAL 입니다.');
    }
    for (const d of remove) if (!validYmd(d)) return vErr(res, 'remove', '날짜는 YYYY-MM-DD 로 넣으세요.');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const a of add) {
        // eslint-disable-next-line no-await-in-loop
        await client.query(
          `INSERT INTO market_calendar (market_code, cal_date, kind, note, updated_by_user_id) VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (market_code, cal_date) DO UPDATE SET kind = EXCLUDED.kind, note = EXCLUDED.note, updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = NOW()`,
          [mk, a.cal_date, a.kind || 'HOLIDAY', a.note ? String(a.note).slice(0, 100) : null, auth.userId]
        );
      }
      if (remove.length) await client.query(`DELETE FROM market_calendar WHERE market_code = $1 AND cal_date = ANY($2::date[])`, [mk, remove]);
      // 지난 날짜를 휴장으로 바꾸면 그 날 스냅샷 재판정
      const today = worker.kstToday();
      const stamp = Date.now();
      const requeued = [];
      for (const a of add) {
        if ((a.kind || 'HOLIDAY') === 'HOLIDAY' && a.cal_date < today) {
          // eslint-disable-next-line no-await-in-loop
          const e = await queue.enqueue(client, { job_type: 'COLLECT', source: 'AT_REALTIME', market_code: mk, trade_date: a.cal_date, phase: 'FINAL',
            params: { reason: 'CALENDAR' }, dedupe_key: `COLLECT:AT_REALTIME:${mk}:${a.cal_date}:FINAL:CAL:${stamp}` });
          requeued.push(e.id);
        }
      }
      await recordAudit(client, { userId: auth.userId, entityType: 'market_sync', entityId: null, action: 'update', before: null,
        after: { calendar_add: add.map((a) => a.cal_date), calendar_remove: remove }, note: `시장 달력 ${add.length}일 추가·${remove.length}일 삭제` });
      await client.query('COMMIT');
      return res.json({ ok: true, data: { added: add.length, removed: remove.length, requeued } });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      return fail(res, err, '시장 달력을 저장하지 못했습니다.');
    } finally { client.release(); }
  });

  // ---- R-134 / R-135 수집 일정 ----
  app.get('/api/auction/schedules', async (req, res) => {
    if (!(await needUser(req, res))) return undefined;
    try {
      const r = await pool.query(`SELECT job_type, source, cron_text, active, note, updated_at FROM collect_schedule ORDER BY job_type, source`);
      return res.json({ ok: true, data: r.rows.map((x) => ({ ...x, updated_at: iso(x.updated_at) })), timer_enabled: String(process.env.COLLECT_TIMER_ENABLED || '').toLowerCase() === 'true' });
    } catch (err) { return fail(res, err, '수집 일정을 불러오지 못했습니다.'); }
  });
  app.put('/api/auction/schedules', async (req, res) => {
    const auth = await needAdmin(req, res);
    if (!auth) return undefined;
    const b = req.body || {};
    const jt = String(b.job_type || '');
    const src = String(b.source || '');
    if (!['COLLECT_INTRADAY', 'COLLECT_FINAL', 'SETTLE_VERIFY', 'CODE_SYNC', 'PURGE_RAW'].includes(jt)) return vErr(res, 'job_type', '작업 종류가 올바르지 않습니다.');
    if (b.cron_text != null && !scheduler.parseCron(b.cron_text)) return vErr(res, 'cron_text', 'cron 형식(분 시 일 월 요일 5칸)이 올바르지 않습니다.', 'BAD_CRON');
    if (b.active != null && typeof b.active !== 'boolean') return vErr(res, 'active', 'active 는 true/false 입니다.');
    try {
      const before = await pool.query(`SELECT cron_text, active FROM collect_schedule WHERE job_type = $1 AND source = $2`, [jt, src]);
      if (!before.rows[0]) return res.status(404).json({ ok: false, code: 'NOT_FOUND', message: '수집 일정을 찾을 수 없습니다.' });
      const r = await pool.query(
        `UPDATE collect_schedule SET cron_text = COALESCE($3, cron_text), active = COALESCE($4, active), updated_by_user_id = $5, updated_at = NOW()
          WHERE job_type = $1 AND source = $2 RETURNING job_type, source, cron_text, active, note, updated_at`,
        [jt, src, b.cron_text != null ? String(b.cron_text).trim().replace(/\s+/g, ' ') : null, b.active == null ? null : b.active, auth.userId]
      );
      await recordAudit(pool, { userId: auth.userId, entityType: 'market_sync', entityId: null, action: 'update', before: before.rows[0],
        after: { cron_text: r.rows[0].cron_text, active: r.rows[0].active }, note: `수집 일정 ${jt}/${src}` });
      return res.json({ ok: true, data: { ...r.rows[0], updated_at: iso(r.rows[0].updated_at) } });
    } catch (err) { return fail(res, err, '수집 일정을 저장하지 못했습니다.'); }
  });

  // ---- R-133 내부 tick (외부 cron) — 토큰 미설정·불일치면 라우트가 없는 것처럼 404 ----
  app.post('/api/internal/collect/tick', async (req, res, next) => {
    const expected = process.env.COLLECT_TRIGGER_TOKEN || '';
    const got = String(req.headers['x-collect-token'] || '');
    const a = Buffer.from(crypto.createHash('sha256').update(got).digest('hex'));
    const bb = Buffer.from(crypto.createHash('sha256').update(expected).digest('hex'));
    if (!expected || expected.length < 16 || !crypto.timingSafeEqual(a, bb)) return next();
    try {
      const out = await scheduler.tick(pool, { hooks });
      return res.json({ ok: true, ...out });
    } catch (err) { return fail(res, err, '수집 tick 을 처리하지 못했습니다.'); }
  });

  return { rangeMeta };
}

module.exports = { registerAuctionRoutes, rangeMeta, tradeOut, validYmd, iso };
