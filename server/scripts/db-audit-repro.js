/**
 * DB 점검 재현 스크립트 (2026-11-20, AI 팀 I) — 테스트 DB 전용. 운영 DB에 실행하지 않는다.
 * - 전제: 마이그레이션 · seed-admin · 서버 기동 (SMOKE_API_BASE, 기본 http://127.0.0.1:3000)
 * - 실행: node scripts/db-audit-repro.js
 * - 각 항목은 "문제 재현됨(VULN)" 또는 "막힘(FIXED)"으로 출력한다. 수정 전·후 결과를 비교하는 용도.
 * - 만드는 데이터는 product_key / memo 에 AUDIT-<태그> 를 붙인다.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');
const { getPgConfig } = require('../lib/db-config');

const AGENT = 'admin001';
const BASE = process.env.SMOKE_API_BASE || 'http://127.0.0.1:3000';
const TAG = `AUDIT-${Date.now()}`;
const today = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
const results = [];

async function api(method, p, body, agent = AGENT, timeoutMs = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(BASE + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(agent ? { 'X-Agent-No': agent } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const json = await r.json().catch(() => ({}));
    return { status: r.status, json };
  } catch (e) {
    return { status: 0, json: { message: e.name === 'AbortError' ? `timeout ${timeoutMs}ms` : e.message } };
  } finally {
    clearTimeout(t);
  }
}

function rec(id, vulnerable, detail) {
  results.push({ id, result: vulnerable ? 'VULN' : 'FIXED', detail });
  console.log(`${vulnerable ? '✗ VULN ' : '○ FIXED'} ${id} — ${detail}`);
}

async function sqlRejects(pool, sql, params) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(sql, params);
    return { rejected: false };
  } catch (e) {
    return { rejected: true, msg: `${e.code} ${e.message}` };
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

async function main() {
  const pool = new Pool(getPgConfig({ pool: true }));
  const u = await pool.query(`SELECT id FROM "user" WHERE agent_no = $1`, [AGENT]);
  const userId = u.rows[0].id;
  const mk = async (type, name) =>
    (await pool.query(`INSERT INTO account (user_id, name, type) VALUES ($1,$2,$3) RETURNING id`, [userId, `${name}-${TAG}`, type])).rows[0].id;
  const supplier = await mk('supplier', '공급');
  const customer = await mk('customer', '판매');
  const newProduct = async (n) =>
    (await pool.query(`INSERT INTO product (name, unit, product_key) VALUES ($1,'kg',$2) RETURNING id`, [`감사상품${n}-${TAG}`, `${TAG}-${n}`])).rows[0].id;

  // D-01 재고 행이 없는 상품에 동시 매입 → 첫 INSERT 경쟁으로 일부 요청 500 (중복 키)
  {
    const pid = await newProduct('race');
    const reqs = Array.from({ length: 8 }, (_, i) =>
      api('POST', '/api/purchases', { partner_id: supplier, product_id: pid, quantity: 1, unit_price: 100, purchase_date: today, memo: `${TAG} D-01 ${i}` })
    );
    const rs = await Promise.all(reqs);
    const fails = rs.filter((r) => r.status !== 201);
    const inv = await pool.query(`SELECT quantity FROM inventory WHERE user_id=$1 AND product_id=$2`, [userId, pid]);
    const pur = await pool.query(`SELECT COALESCE(SUM(quantity),0) s FROM purchase WHERE user_id=$1 AND product_id=$2`, [userId, pid]);
    rec('D-01 동시 매입 첫 재고행 경쟁', fails.length > 0 || Number(inv.rows[0]?.quantity) !== Number(pur.rows[0].s),
      `8건 중 실패 ${fails.length}건 (${fails.map((f) => f.status).join(',') || '-'}) · 매입합 ${pur.rows[0].s} · 재고 ${inv.rows[0]?.quantity}`);
  }

  // D-02 같은 매출에 수금을 두 번(합계 > 매출액) → paid_amount > total_amount, 미수 음수
  {
    const pid = await newProduct('pay');
    const p = await api('POST', '/api/purchases', { partner_id: supplier, product_id: pid, quantity: 10, unit_price: 100, purchase_date: today, memo: `${TAG} D-02` });
    const s = await api('POST', '/api/purchases/convert-to-sales', { items: [{ purchase_id: p.json.data.id, partner_id: customer, quantity: 10, unit_price: 100, sale_date: today, memo: `${TAG} D-02` }] });
    const saleId = s.json.data[0].sale_id;
    await api('POST', '/api/payments', { partner_id: customer, amount: 1000, paid_at: today, entry_kind: 'receive', allocations: [{ sale_id: saleId, amount: 1000 }] });
    const second = await api('POST', '/api/payments', { partner_id: customer, amount: 1000, paid_at: today, entry_kind: 'receive', allocations: [{ sale_id: saleId, amount: 1000 }] });
    const row = (await pool.query(`SELECT total_amount, paid_amount FROM sale WHERE id=$1`, [saleId])).rows[0];
    rec('D-02 과수금(매출액 초과 배분)', Number(row.paid_amount) > Number(row.total_amount),
      `2번째 수금 status=${second.status} · 매출 ${row.total_amount} / 수금 ${row.paid_amount}`);
  }

  // D-03 수량 소수 4자리 이상 → 저장 수량(3자리 반올림)과 금액(원래 수량으로 계산)이 어긋남
  {
    const pid = await newProduct('round');
    const p = await api('POST', '/api/purchases', { partner_id: supplier, product_id: pid, quantity: 1.2345, unit_price: 1000, purchase_date: today, memo: `${TAG} D-03` });
    const row = (await pool.query(`SELECT quantity, unit_price, total_amount, ROUND(quantity*unit_price,2) AS recomputed FROM purchase WHERE id=$1`, [p.json.data.id])).rows[0];
    rec('D-03 금액 = 수량×단가 불일치', Number(row.total_amount) !== Number(row.recomputed),
      `수량 ${row.quantity} × 단가 ${row.unit_price} = ${row.recomputed}, 저장 금액 ${row.total_amount} (응답 ${p.json.data.total_amount})`);
  }

  // D-05 DB 세션 시간대가 UTC(Neon 기본)일 때 수금일 날짜 필터가 하루 밀림
  // (이 항목은 테스트 DB 기본 시간대를 UTC로 둔 상태에서 실행: ALTER DATABASE sales_tool SET timezone='UTC')
  {
    const tz = (await pool.query(`SHOW TimeZone`)).rows[0].TimeZone;
    const pr = await api('POST', '/api/payments', { partner_id: customer, amount: 777, paid_at: '2026-11-20T08:00', entry_kind: 'refund', memo: `${TAG} D-05` });
    const day = await api('GET', `/api/payments?from_date=2026-11-20&to_date=2026-11-20&partner_id=${customer}`);
    const prev = await api('GET', `/api/payments?from_date=2026-11-19&to_date=2026-11-19&partner_id=${customer}`);
    const onDay = (day.json.data || []).some((x) => x.id === pr.json?.data?.id);
    const onPrev = (prev.json.data || []).some((x) => x.id === pr.json?.data?.id);
    rec('D-05 수금일 필터가 DB 시간대에 따라 하루 밀림', !onDay || onPrev,
      `DB TimeZone=${tz} · 2026-11-20 08:00(KST) 수금 → 11-20 조회에 ${onDay ? '보임' : '안 보임'}, 11-19 조회에 ${onPrev ? '보임' : '안 보임'}`);
    const src = require('fs').readFileSync(process.env.REPRO_SOURCE || path.join(__dirname, '..', 'index.js'), 'utf8');
    const m = src.match(/app\.get\('\/api\/purchases'[\s\S]*?const today = ([^;]+);/);
    const utcStyle = m && /toISOString\(\)\.slice\(0, 10\)/.test(m[1]) && !/9 \* 3600/.test(m[1]);
    rec('D-06 매입 조회 기본일이 UTC 날짜(KST 00~09시엔 어제)', !!utcStyle,
      `GET /api/purchases 기본일 = ${m ? m[1].trim() : '?'} (KST 2026-11-20 08:00 에 new Date().toISOString().slice(0,10) = ${new Date('2026-11-20T08:00:00+09:00').toISOString().slice(0, 10)})`);
  }

  // D-07 다른 회원 거래처를 내 매출에 연결하는 행을 DB가 막지 못함 (코드 검사에만 의존)
  {
    const other = await pool.query(
      `INSERT INTO "user" (name, email, agent_no, password_hash, terms_agreed_at) VALUES ($1,$2,$3,'x',NOW()) RETURNING id`,
      [`타회원-${TAG}`, `${TAG.toLowerCase()}@other.local`, `${TAG}-o`]
    );
    const otherAcc = (await pool.query(`INSERT INTO account (user_id, name, type) VALUES ($1,'타회원거래처','customer') RETURNING id`, [other.rows[0].id])).rows[0].id;
    const pid = await newProduct('tenant');
    const r = await sqlRejects(pool,
      `INSERT INTO sale (user_id, partner_id, product_id, quantity, unit_price, total_amount, sale_date) VALUES ($1,$2,$3,1,1,1,CURRENT_DATE)`,
      [userId, otherAcc, pid]);
    rec('D-07 회원 간 거래처 교차 참조', !r.rejected, r.rejected ? r.msg : 'INSERT 성공 (막히지 않음)');
  }

  // D-08 상태·구분 값, 단가·금액 음수를 DB가 막지 못함
  {
    const pid = await newProduct('check');
    const checks = [
      ['sale.status', `INSERT INTO sale (user_id, partner_id, product_id, quantity, unit_price, total_amount, sale_date, status) VALUES ($1,$2,$3,1,1,1,CURRENT_DATE,'아무값')`, [userId, customer, pid]],
      ['sale.unit_price<0', `INSERT INTO sale (user_id, partner_id, product_id, quantity, unit_price, total_amount, sale_date) VALUES ($1,$2,$3,1,-5,5,CURRENT_DATE)`, [userId, customer, pid]],
      ['purchase.total<0', `INSERT INTO purchase (user_id, partner_id, product_id, quantity, unit_price, total_amount, purchase_date) VALUES ($1,$2,$3,1,1,-1,CURRENT_DATE)`, [userId, supplier, pid]],
      ['payment.entry_kind', `INSERT INTO payment (user_id, partner_id, amount, paid_at, entry_kind) VALUES ($1,$2,1,NOW(),'xx')`, [userId, customer]],
      ['sale.paid>total', `INSERT INTO sale (user_id, partner_id, product_id, quantity, unit_price, total_amount, sale_date, paid_amount) VALUES ($1,$2,$3,1,1,1,CURRENT_DATE,5)`, [userId, customer, pid]],
    ];
    for (const [name, sql, params] of checks) {
      const r = await sqlRejects(pool, sql, params);
      rec(`D-08 CHECK ${name}`, !r.rejected, r.rejected ? r.msg : 'INSERT 성공 (막히지 않음)');
    }
  }

  // D-09 이메일 대소문자만 다른 중복 회원을 DB가 막지 못함
  {
    const e = `${TAG.toLowerCase()}@case.local`;
    const c = await pool.connect();
    let ok = false; let msg = '';
    try {
      await c.query('BEGIN');
      await c.query(`INSERT INTO "user" (name, email, agent_no, password_hash, terms_agreed_at) VALUES ('a',$1,$2,'x',NOW())`, [e, `${TAG}-c1`]);
      await c.query(`INSERT INTO "user" (name, email, agent_no, password_hash, terms_agreed_at) VALUES ('b',$1,$2,'x',NOW())`, [e.toUpperCase(), `${TAG}-c2`]);
      ok = true;
    } catch (err) { msg = `${err.code} ${err.message}`; } finally { await c.query('ROLLBACK'); c.release(); }
    rec('D-09 이메일 대소문자 중복', ok, ok ? '대소문자만 다른 이메일 2명 가입됨' : msg);
  }

  // D-10 만료된 이메일 인증번호가 지워지지 않고 쌓임
  {
    await pool.query(`INSERT INTO email_verification (email, code, expires_at, created_at) VALUES ($1,'000000', NOW() - INTERVAL '3 days', NOW() - INTERVAL '3 days')`, [`old-${TAG.toLowerCase()}@x.local`]);
    await api('POST', '/api/auth/send-email-verification', { email: `new-${TAG.toLowerCase()}@x.local` }, null);
    const left = await pool.query(`SELECT COUNT(*)::int n FROM email_verification WHERE expires_at < NOW() - INTERVAL '1 day'`);
    rec('D-10 만료 인증번호 누적', left.rows[0].n > 0, `인증번호 발송 후에도 1일 넘게 만료된 행 ${left.rows[0].n}건 남음`);
  }

  // D-11 매출 전환 2건을 반대 순서로 동시에 → 교착(deadlock) 500
  {
    const pa = await newProduct('dlA');
    const pb = await newProduct('dlB');
    const a = await api('POST', '/api/purchases', { partner_id: supplier, product_id: pa, quantity: 1000, unit_price: 1, purchase_date: today, memo: `${TAG} D-11` });
    const b = await api('POST', '/api/purchases', { partner_id: supplier, product_id: pb, quantity: 1000, unit_price: 1, purchase_date: today, memo: `${TAG} D-11` });
    const item = (id) => ({ purchase_id: id, partner_id: customer, quantity: 1, unit_price: 2, sale_date: today, memo: `${TAG} D-11` });
    let deadlocks = 0; let other = 0;
    for (let round = 0; round < 15; round++) {
      const rs = await Promise.all([
        api('POST', '/api/purchases/convert-to-sales', { items: [item(a.json.data.id), item(b.json.data.id)] }),
        api('POST', '/api/purchases/convert-to-sales', { items: [item(b.json.data.id), item(a.json.data.id)] }),
      ]);
      for (const r of rs) {
        if (r.status !== 201) (/deadlock|교착/i.test(r.json?.message || '') ? deadlocks++ : other++);
      }
    }
    rec('D-11 전환 교착', deadlocks + other > 0, `30건 중 deadlock ${deadlocks}건 · 기타 실패 ${other}건`);
  }

  // D-12 원장 대조: 재고 = 매입 - 매출 + 환불 - 폐기 (이 회원 전체, 시나리오 S-013 처럼 재고를 직접 고친 상품은 제외)
  {
    const r = await pool.query(
      `WITH m AS (
         SELECT product_id, SUM(CASE WHEN action_type IN ('purchase','refund') THEN quantity ELSE -quantity END) AS ledger
         FROM product_transfer WHERE user_id = $1 GROUP BY product_id)
       SELECT COUNT(*) FILTER (WHERE COALESCE(i.quantity,0) <> m.ledger)::int AS mismatch, COUNT(*)::int AS products
       FROM m LEFT JOIN inventory i ON i.user_id = $1 AND i.product_id = m.product_id
       JOIN product p ON p.id = m.product_id WHERE p.product_key LIKE $2`,
      [userId, `${TAG}%`]
    );
    rec('D-12 재고 원장 대조(이번 실행분)', r.rows[0].mismatch > 0, `상품 ${r.rows[0].products}개 중 불일치 ${r.rows[0].mismatch}개`);
  }

  // D-04 (풀을 고갈시키므로 마지막에 실행) 로그인 중 DB 오류(NUL 문자) → 연결 반납 안 함 → 5회 후 풀 고갈, 이후 모든 API 대기
  {
    const before = Date.now();
    for (let i = 0; i < 6; i++) await api('POST', '/api/auth/login', { agent_no: `x\u0000${i}`, password: 'x' }, null, 5000);
    const h = await api('GET', '/health', null, null, 20000);
    rec('D-04 로그인 오류 시 연결 누수(풀 고갈)', h.status !== 200,
      `NUL 로그인 6회 후 /health status=${h.status} (${Date.now() - before}ms) ${h.json?.error || h.json?.message || ''}`);
  }

  // S-01 로그인 요청 본문(비밀번호)이 서버 로그에 남는지 — REPRO_SERVER_LOG 에 서버 출력 파일 경로를 주면 검사
  if (process.env.REPRO_SERVER_LOG) {
    const log = require('fs').readFileSync(process.env.REPRO_SERVER_LOG, 'utf8');
    const hits = (log.match(/password/gi) || []).length;
    rec('S-01 비밀번호 로그 출력', hits > 0, `서버 로그에서 "password" ${hits}회 발견`);
  }

  await pool.end();
  const v = results.filter((x) => x.result === 'VULN').length;
  console.log(`\n요약: VULN ${v} / ${results.length} (태그 ${TAG})`);
  if (process.env.REPRO_JSON) require('fs').writeFileSync(process.env.REPRO_JSON, JSON.stringify({ tag: TAG, results }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
