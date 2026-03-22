/**
 * docs/테스트시나리오/API-통합-시나리오.md — S-001 ~ S-021 자동 점검
 * 전제: npm run seed-admin, DB 마이그레이션, 서버 기동(기본 3000)
 * 실행: cd server → npm run scenario
 *
 * 실행 이력: docs/테스트시나리오/시나리오-실행이력/ (또는 SCENARIO_HISTORY_DIR)
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = require('pg');

const AGENT = 'admin001';
const BASE = process.env.SMOKE_API_BASE || 'http://127.0.0.1:3000';
const PORT = new URL(BASE).port || 3000;
const HOST = new URL(BASE).hostname;

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const DEFAULT_HISTORY_ROOT = path.join(
  PROJECT_ROOT,
  'docs',
  '테스트시나리오',
  '시나리오-실행이력'
);
const HISTORY_ROOT = process.env.SCENARIO_HISTORY_DIR
  ? path.resolve(process.cwd(), process.env.SCENARIO_HISTORY_DIR)
  : DEFAULT_HISTORY_ROOT;
const RUNS_DIR = path.join(HISTORY_ROOT, 'runs');
const HISTORY_JSONL = path.join(HISTORY_ROOT, 'history.jsonl');
const LATEST_MD = path.join(HISTORY_ROOT, '최근실행.md');
const LEDGER_MANUAL_JSON = path.join(HISTORY_ROOT, '통합대장-수동필드.json');
const DOCS_SCENARIO_DIR = path.join(PROJECT_ROOT, 'docs', '테스트시나리오');
const LEDGER_MD = path.join(DOCS_SCENARIO_DIR, 'API-통합-시나리오-실행-통합대장.md');

const SCENARIO_META = require('./scenario-meta.json');
const EXPECTED_SCENARIO_COUNT = SCENARIO_META.length;

const rows = [];
let runId = '';
let runStartedAt = '';
let dataTag = '';
let fatalError = null;

function formatRunId(d) {
  return 'run-' + d.toISOString().replace(/:/g, '-').replace(/\./g, '-');
}

function initRunHistory(tag) {
  const d = new Date();
  runId = formatRunId(d);
  runStartedAt = d.toISOString();
  dataTag = tag;
  fatalError = null;
  fs.mkdirSync(RUNS_DIR, { recursive: true });
}

function buildProgressPayload(overrides = {}) {
  const firstFail = rows.find((r) => !r.ok);
  const steps = rows.map((r) => ({ ...r, mark: r.ok ? '○' : '×' }));
  return {
    runId,
    startedAt: runStartedAt,
    updatedAt: new Date().toISOString(),
    base: BASE,
    agent: AGENT,
    tag: dataTag,
    productKey: dataTag ? `SCENARIO-${dataTag}` : null,
    steps,
    lastCompletedStep: steps.length ? steps[steps.length - 1].id : null,
    passedSoFar: rows.filter((x) => x.ok).length,
    failedSoFar: rows.filter((x) => !x.ok).length,
    firstFailedScenario: firstFail ? firstFail.id : null,
    fatalError,
    ...overrides,
  };
}

function renderRunMarkdown(p) {
  const lines = [
    '# 시나리오 실행 이력',
    '',
    `- **실행 ID:** \`${p.runId}\``,
    `- **시작:** ${p.startedAt}`,
    `- **갱신:** ${p.updatedAt}`,

    `- **API 베이스:** ${p.base}`,
    `- **에이전트:** ${p.agent}`,
    `- **데이터 태그 / product_key:** ${p.productKey || '—'}`,
    '',
    '## 단계별 결과 (실행 순서)',
    '',
    '| 순서 | ID | 결과 | 비고 |',
    '|------|-----|------|------|',
  ];
  p.steps.forEach((s, i) => {
    const note = String(s.detail || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
    lines.push(`| ${i + 1} | ${s.id} | ${s.mark} | ${note} |`);
  });
  lines.push('');
  if (p.fatalError) {
    lines.push('## 치명 오류 / 중단', '', '```', String(p.fatalError), '```', '');
  }
  lines.push('## 요약', '');
  lines.push(`- 기록된 단계 수: ${p.steps.length}`);
  lines.push(`- 검증 성공: ${p.passedSoFar}, 검증 실패(×): ${p.failedSoFar}`);
  if (p.firstFailedScenario) {
    lines.push(`- **첫 검증 실패(×) ID:** ${p.firstFailedScenario}`);
    if (p.status === 'aborted') {
      lines.push(`- **중단(aborted):** 치명 오류로 스크립트가 멈춤 → 표의 마지막 행까지가 실행된 범위`);
    } else if (p.status === 'failed') {
      lines.push(`- **검증 실패(failed):** 모든 단계는 실행됐으나 일부 시나리오 기대와 불일치`);
    }
  }
  if (p.exitCode != null) lines.push(`- **프로세스 종료 코드:** ${p.exitCode}`);
  if (p.status) lines.push(`- **상태:** ${p.status}`);
  return lines.join('\n');
}

function persistProgress(overrides = {}) {
  if (!runId) return;
  const p = buildProgressPayload(overrides);
  const jsonPath = path.join(RUNS_DIR, `${runId}.progress.json`);
  const mdPath = path.join(RUNS_DIR, `${runId}.md`);
  try {
    fs.writeFileSync(jsonPath, JSON.stringify(p, null, 2), 'utf8');
    fs.writeFileSync(mdPath, renderRunMarkdown(p), 'utf8');
    fs.writeFileSync(LATEST_MD, renderRunMarkdown(p), 'utf8');
  } catch (e) {
    console.error('[scenario] 이력 파일 쓰기 실패:', e.message);
  }
}

function escapeMdCell(s) {
  return String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

/** API 통합 시나리오 §1 표 구조 — 이번 실행 결과로 채운 복제본 */
function writeApiScenarioResultMd() {
  if (!runId) return;
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  const ymd = runStartedAt.slice(0, 10);
  const lines = [
    '# API 통합 시나리오 — 실행 결과 (자동 생성)',
    '',
    `- **실행 ID:** \`${runId}\``,
    `- **실행일:** ${ymd} (시작 ${runStartedAt})`,
    `- **원본:** [API-통합-시나리오.md](../../API-통합-시나리오.md) §1 요약 표와 같은 열 구조`,
    '',
    '> `npm run scenario` 1회 실행 기준. 중간 중단 시 미실행 ID는 아래와 같이 표시됩니다.',
    '',
    '| ID | 구분 | 한 줄 설명 | 기대 결과 | 성공 여부 | 에러 사유 | 시행일자 |',
    '|------|------|------------|-----------|-----------|-----------|----------|',
  ];
  for (const m of SCENARIO_META) {
    const step = byId[m.id];
    let mark = '—';
    let err = '—';
    let dateCol = '—';
    if (step) {
      mark = step.ok ? '○' : '×';
      err = step.ok ? '—' : escapeMdCell(step.detail);
      dateCol = ymd;
    } else {
      err = '*(미실행)*';
    }
    lines.push(
      `| ${m.id} | ${escapeMdCell(m.구분)} | ${escapeMdCell(m.한줄설명)} | ${escapeMdCell(m.기대결과)} | ${mark} | ${err} | ${dateCol} |`
    );
  }
  lines.push('');
  lines.push('- [실행 통합 대장](../../API-통합-시나리오-실행-통합대장.md)');
  lines.push('- [단계별 로그](./' + runId + '.md)');
  const out = path.join(RUNS_DIR, `${runId}-API통합시나리오-실행결과.md`);
  fs.writeFileSync(out, lines.join('\n'), 'utf8');
}

function readHistoryJsonl() {
  if (!fs.existsSync(HISTORY_JSONL)) return [];
  const text = fs.readFileSync(HISTORY_JSONL, 'utf8');
  const out = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch (_) {
      /* skip bad line */
    }
  }
  return out;
}

function loadLedgerManual() {
  try {
    if (fs.existsSync(LEDGER_MANUAL_JSON)) {
      return JSON.parse(fs.readFileSync(LEDGER_MANUAL_JSON, 'utf8'));
    }
  } catch (_) {
    /* ignore */
  }
  return {};
}

/** history.jsonl 전체를 읽어 통합 대장 표 갱신 */
function rebuildIntegrationLedger() {
  const runs = readHistoryJsonl().sort((a, b) => String(b.endedAt || '').localeCompare(String(a.endedAt || '')));
  const manual = loadLedgerManual();
  const tableRows = runs.map((h) => {
    const prog = EXPECTED_SCENARIO_COUNT
      ? Math.min(100, Math.round((100 * (h.totalSteps || 0)) / EXPECTED_SCENARIO_COUNT))
      : 0;
    const passPct = EXPECTED_SCENARIO_COUNT
      ? Math.min(100, Math.round((100 * (h.passedSteps || 0)) / EXPECTED_SCENARIO_COUNT))
      : 0;
    const fatalShort = h.fatalError ? escapeMdCell(String(h.fatalError).slice(0, 160)) : '—';
    const m = manual[h.runId] || {};
    const errSummary = escapeMdCell(m.에러요약 || m.errorSummary || '—');
    const actions = escapeMdCell(m.조치사항 || m.actions || '—');
    const cause = escapeMdCell(m.원인 || m.rootCause || '—');
    const logLink = `[상세](./시나리오-실행이력/runs/${h.runId}.md)`;
    const resLink = `[결과](./시나리오-실행이력/runs/${h.runId}-API통합시나리오-실행결과.md)`;
    return [
      escapeMdCell(h.endedAt || '—'),
      '`' + String(h.runId).replace(/`/g, '') + '`',
      `${h.totalSteps ?? 0}/${EXPECTED_SCENARIO_COUNT} (${prog}%)`,
      `${h.passedSteps ?? 0}/${EXPECTED_SCENARIO_COUNT} (${passPct}%)`,
      escapeMdCell(h.status || '—'),
      escapeMdCell(h.lastCompletedStep || '—'),
      escapeMdCell(h.firstFailedScenario || '—'),
      fatalShort,
      logLink,
      resLink,
      errSummary,
      actions,
      cause,
    ].join(' | ');
  });
  const header =
    '| 실행 종료 (UTC) | 실행 ID | 실행 진행 (단계/전체) | 검증 통과 (○수/전체) | 상태 | 마지막 단계 | 첫 실패 ID | 치명 오류(요약) | 상세 로그 | 시나리오 결과표 | 에러요약(수동) | 조치사항(수동) | 원인(수동) |';
  const sep =
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |';
  const body = tableRows.length
    ? tableRows.map((r) => '| ' + r + ' |').join('\n')
    : '| *(아직 history.jsonl에 기록 없음 — `npm run scenario` 실행)* | | | | | | | | | | | | |';
  const autoBlock = [header, sep, body].join('\n');

  const startTag = '<!-- SCENARIO_LEDGER_AUTO_START -->';
  const endTag = '<!-- SCENARIO_LEDGER_AUTO_END -->';
  const fullDoc = [
    '# API 통합 시나리오 — 실행 통합 대장',
    '',
    '> **Git 배포가 있어야만 보이는 것은 아닙니다.** `npm run scenario`를 돌린 **그 PC**의 프로젝트 폴더에 로그·이 파일이 쌓입니다.',
    '> **매 실행마다** `history.jsonl`에 한 줄 추가 → 아래 표는 **전체 이력**을 최신순으로 다시 그립니다.',
    '',
    '- 시나리오 정의: [API-통합-시나리오.md](./API-통합-시나리오.md)',
    '- 로그 폴더: [시나리오-실행이력/README.md](./시나리오-실행이력/README.md)',
    '',
    '## 실행 이력 목록 (최신이 위)',
    '',
    startTag,
    autoBlock,
    endTag,
    '',
    '### 수동 컬럼 (에러요약·조치·원인)',
    '',
    '`시나리오-실행이력/통합대장-수동필드.json` 에 `runId` 키로 적으면, 다음 `npm run scenario` 때 표에 반영됩니다.',
    '',
    '```json',
    '{',
    '  "run-2026-03-22T08-04-59-203Z": {',
    '    "에러요약": "한 줄 요약",',
    '    "조치사항": "",',
    '    "원인": ""',
    '  }',
    '}',
    '```',
    '',
  ].join('\n');

  fs.mkdirSync(DOCS_SCENARIO_DIR, { recursive: true });
  let existing = '';
  if (fs.existsSync(LEDGER_MD)) {
    existing = fs.readFileSync(LEDGER_MD, 'utf8');
  }
  if (existing.includes(startTag) && existing.includes(endTag)) {
    const re = new RegExp(
      startTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        '[\\s\\S]*?' +
        endTag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
      'm'
    );
    existing = existing.replace(re, `${startTag}\n${autoBlock}\n${endTag}`);
    fs.writeFileSync(LEDGER_MD, existing, 'utf8');
  } else {
    fs.writeFileSync(LEDGER_MD, fullDoc, 'utf8');
  }
}

function appendHistoryJsonl(exitCode, status) {
  if (!runId) return;
  const firstFail = rows.find((r) => !r.ok);
  const line = JSON.stringify({
    runId,
    startedAt: runStartedAt,
    endedAt: new Date().toISOString(),
    exitCode,
    base: BASE,
    agent: AGENT,
    tag: dataTag,
    productKey: dataTag ? `SCENARIO-${dataTag}` : null,
    totalSteps: rows.length,
    passedSteps: rows.filter((x) => x.ok).length,
    failedSteps: rows.filter((x) => !x.ok).length,
    firstFailedScenario: firstFail ? firstFail.id : null,
    lastCompletedStep: rows.length ? rows[rows.length - 1].id : null,
    fatalError,
    status,
  });
  try {
    fs.appendFileSync(HISTORY_JSONL, line + '\n', 'utf8');
  } catch (e) {
    console.error('[scenario] history.jsonl append 실패:', e.message);
  }
}

function finalizeRun(exitCode, status) {
  const st =
    status ||
    (exitCode === 0 ? 'success' : fatalError ? 'aborted' : 'failed');
  persistProgress({ exitCode, status: st });
  appendHistoryJsonl(exitCode, st);
  try {
    writeApiScenarioResultMd();
    rebuildIntegrationLedger();
  } catch (e) {
    console.error('[scenario] 결과표/통합대장 갱신 실패:', e.message);
  }
  console.log('');
  console.log('──────── 실행 이력 ────────');
  console.log(`  ${LATEST_MD}`);
  console.log(`  ${path.join(RUNS_DIR, runId + '.md')}`);
  console.log(`  ${path.join(RUNS_DIR, runId + '-API통합시나리오-실행결과.md')}`);
  console.log(`  ${LEDGER_MD}`);
  console.log(`  ${HISTORY_JSONL} (한 줄 추가됨)`);
  console.log('  (원격 반영: 같은 폴더에서 npm run scenario:git)');
}

function record(id, ok, detail) {
  rows.push({ id, ok, detail });
  const mark = ok ? '○' : '×';
  console.log(`[${id}] ${mark} ${detail || ''}`);
  persistProgress();
}

function getPoolConfig() {
  const raw = process.env.DATABASE_URL && process.env.DATABASE_URL.trim();
  if (raw && (raw.startsWith('postgres://') || raw.startsWith('postgresql://'))) {
    const u = new URL(raw);
    return {
      host: u.hostname,
      port: u.port ? Number(u.port) : 5432,
      user: u.username || undefined,
      password: u.password ? decodeURIComponent(u.password) : undefined,
      database: u.pathname ? u.pathname.slice(1).replace(/\?.*$/, '') : undefined,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
    };
  }
  return {
    host: process.env.PG_HOST || 'localhost',
    port: Number(process.env.PG_PORT) || 5432,
    user: process.env.PG_USER || 'postgres',
    password: process.env.PG_PASSWORD != null ? String(process.env.PG_PASSWORD) : undefined,
    database: process.env.PG_DATABASE || 'sales_tool',
  };
}

function request(method, pathname, body, opts = {}) {
  const { skipAgent = false, agentNo = AGENT, extraHeaders = {} } = opts;
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json', ...extraHeaders };
    if (!skipAgent) headers['X-Agent-No'] = agentNo;
    const httpOpts = { hostname: HOST, port: PORT, path: pathname, method, headers };
    const req = http.request(httpOpts, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json = null;
        try {
          json = data ? JSON.parse(data) : null;
        } catch {
          json = { _raw: data };
        }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function requestNoAuth(method, pathname) {
  return request(method, pathname, null, { skipAgent: true });
}

async function ensureAccountsAndProduct(pool, userId, tag) {
  const sup = await pool.query(
    `SELECT id FROM account WHERE user_id = $1 AND type = 'supplier' LIMIT 1`,
    [userId]
  );
  let supplierId = sup.rows[0]?.id;
  if (!supplierId) {
    const r = await pool.query(
      `INSERT INTO account (user_id, name, type) VALUES ($1, $2, 'supplier') RETURNING id`,
      [userId, `시나리오-공급-${tag}`]
    );
    supplierId = r.rows[0].id;
  }
  const cust = await pool.query(
    `SELECT id FROM account WHERE user_id = $1 AND type = 'customer' LIMIT 1`,
    [userId]
  );
  let customerId = cust.rows[0]?.id;
  if (!customerId) {
    const r = await pool.query(
      `INSERT INTO account (user_id, name, type) VALUES ($1, $2, 'customer') RETURNING id`,
      [userId, `시나리오-판매-${tag}`]
    );
    customerId = r.rows[0].id;
  }
  const key = `SCENARIO-${tag}`;
  let prod = await pool.query(`SELECT id FROM product WHERE product_key = $1 LIMIT 1`, [key]);
  let productId = prod.rows[0]?.id;
  if (!productId) {
    const r = await pool.query(
      `INSERT INTO product (name, unit, product_key, memo) VALUES ($1, 'kg', $2, $3) RETURNING id`,
      [`시나리오상품-${tag}`, key, `scenario-integration-test ${tag}`]
    );
    productId = r.rows[0].id;
  }
  return { supplierId, customerId, productId };
}

async function main() {
  const tag = String(Date.now());
  const today = new Date().toISOString().slice(0, 10);
  initRunHistory(tag);

  let pool = null;
  let exitCode = 0;
  let runStatus = 'success';

  try {
    pool = new Pool(getPoolConfig());
    const u = await pool.query(`SELECT id FROM "user" WHERE agent_no = $1 AND status = 'active'`, [AGENT]);
    if (!u.rows[0]) {
      fatalError = 'agent_no admin001 사용자 없음 → npm run seed-admin 실행 후 재시도.';
      console.error('[scenario]', fatalError);
      exitCode = 1;
      runStatus = 'aborted';
      return;
    }
    const userId = u.rows[0].id;
    const { supplierId, customerId, productId } = await ensureAccountsAndProduct(pool, userId, tag);

  // ----- S-001
  let r = await requestNoAuth('GET', '/health');
  record(
    'S-001',
    r.status === 200 && r.json?.ok === true && r.json?.db === 'connected',
    `status=${r.status} db=${r.json?.db}`
  );

  // ----- S-002
  r = await requestNoAuth('GET', '/api/partners');
  record('S-002', r.status === 401, `status=${r.status} msg=${r.json?.message}`);

  // ----- S-003
  r = await request('GET', '/api/partners', null, { agentNo: 'NO_SUCH_AGENT_99999' });
  record('S-003', r.status === 401, `status=${r.status}`);

  // ----- S-004
  r = await request('GET', '/api/partners');
  record(
    'S-004',
    r.status === 200 && Array.isArray(r.json?.data),
    `status=${r.status} n=${r.json?.data?.length}`
  );

  // ----- S-005
  r = await requestNoAuth('GET', '/api/products');
  record('S-005', r.status === 200 && Array.isArray(r.json?.data), `status=${r.status}`);

  // ----- S-006
  r = await request('GET', '/api/inventory');
  record('S-006', r.status === 200 && Array.isArray(r.json?.data), `status=${r.status}`);

  // ----- S-008 (매입 불가 거래처)
  r = await request('POST', '/api/purchases', {
    partner_id: customerId,
    product_id: productId,
    quantity: 1,
    unit_price: 1,
    purchase_date: today,
    memo: 'S-008',
  });
  record(
    'S-008',
    r.status === 400 && String(r.json?.message || '').includes('매입'),
    `status=${r.status} ${r.json?.message}`
  );

  // ----- S-009
  r = await request('POST', '/api/purchases', {
    partner_id: supplierId,
    product_id: productId,
    unit_price: 1,
    purchase_date: today,
  });
  record('S-009', r.status === 400, `status=${r.status} ${r.json?.message}`);

  // ----- S-007
  r = await request('POST', '/api/purchases', {
    partner_id: supplierId,
    product_id: productId,
    quantity: 100,
    unit_price: 100,
    purchase_date: today,
    memo: `S-007-${tag}`,
  });
  record('S-007', r.status === 201 && r.json?.data?.id, `status=${r.status} purchase_id=${r.json?.data?.id}`);
  const purchaseId = r.json?.data?.id;
  if (!purchaseId) {
    fatalError = 'S-007 매입 등록 실패(응답에 purchase id 없음) — 이후 시나리오 미실행.';
    console.error('[scenario] S-007 실패로 중단');
    exitCode = 1;
    runStatus = 'aborted';
    return;
  }

  // ----- S-012 (잔여 초과) — 성공 전환 전에 검사
  r = await request('POST', '/api/purchases/convert-to-sales', {
    items: [
      {
        purchase_id: purchaseId,
        partner_id: customerId,
        quantity: 9999,
        unit_price: 200,
        sale_date: today,
        memo: 'S-012',
      },
    ],
  });
  record(
    'S-012',
    r.status >= 400,
    `status=${r.status} (기대: 4xx/5xx) ${r.json?.message}`
  );

  // ----- S-011
  r = await request('POST', '/api/purchases/convert-to-sales', {
    items: [
      {
        purchase_id: purchaseId,
        partner_id: customerId,
        quantity: 40,
        unit_price: 200,
        sale_date: today,
        memo: `S-011-${tag}`,
      },
    ],
  });
  record('S-011', r.status === 201 && r.json?.data?.[0]?.sale_id, `status=${r.status}`);
  const saleId = r.json?.data?.[0]?.sale_id;
  if (!saleId) {
    fatalError = 'S-011 매출 전환 실패(sale_id 없음) — 이후 시나리오 미실행.';
    console.error('[scenario] S-011 실패로 중단');
    exitCode = 1;
    runStatus = 'aborted';
    return;
  }

  // ----- S-010
  r = await request('GET', `/api/purchases?from_date=${today}&to_date=${today}`);
  const puRow = r.json?.data?.find((x) => x.id === purchaseId);
  record(
    'S-010',
    r.status === 200 &&
      puRow &&
      puRow.allocated_qty != null &&
      puRow.remaining_qty != null &&
      Number(puRow.remaining_qty) === 60,
    `allocated=${puRow?.allocated_qty} remaining=${puRow?.remaining_qty}`
  );

  // ----- S-013 재고 부족 (DB에서 재고만 낮춤)
  await pool.query(
    `UPDATE inventory SET quantity = 2, updated_at = NOW() WHERE user_id = $1 AND product_id = $2`,
    [userId, productId]
  );
  r = await request('POST', '/api/purchases/convert-to-sales', {
    items: [
      {
        purchase_id: purchaseId,
        partner_id: customerId,
        quantity: 10,
        unit_price: 150,
        sale_date: today,
        memo: 'S-013',
      },
    ],
  });
  await pool.query(
    `UPDATE inventory SET quantity = 60, updated_at = NOW() WHERE user_id = $1 AND product_id = $2`,
    [userId, productId]
  );
  record(
    'S-013',
    r.status === 400 && String(r.json?.message || '').length > 0,
    `status=${r.status} ${r.json?.message}`
  );

  // ----- S-014
  r = await request('GET', `/api/sales?from_date=${today}&to_date=${today}`);
  const saleRow = r.json?.data?.find((s) => s.id === saleId);
  record(
    'S-014',
    r.status === 200 &&
      saleRow &&
      saleRow.status != null &&
      saleRow.refunded_qty != null,
    `status=${saleRow?.status} refunded_qty=${saleRow?.refunded_qty}`
  );

  // ----- S-015
  const payAmount = Number(saleRow.total_amount);
  r = await request('POST', '/api/payments', {
    partner_id: customerId,
    amount: payAmount,
    paid_at: today,
    entry_kind: 'receive',
    allocations: [{ sale_id: saleId, amount: payAmount }],
  });
  record('S-015', r.status === 201, `status=${r.status}`);

  // ----- S-016
  r = await request('POST', '/api/payments', {
    partner_id: customerId,
    amount: 10000,
    paid_at: today,
    entry_kind: 'receive',
    allocations: [{ sale_id: saleId, amount: 5000 }],
  });
  record(
    'S-016',
    r.status === 400 && String(r.json?.message || '').includes('합계'),
    `status=${r.status}`
  );

  // ----- S-017 (미수 매출 하나 더 만든 뒤, 수금 거래처 불일치)
  r = await request('POST', '/api/purchases/convert-to-sales', {
    items: [
      {
        purchase_id: purchaseId,
        partner_id: customerId,
        quantity: 5,
        unit_price: 300,
        sale_date: today,
        memo: `S-017-${tag}`,
      },
    ],
  });
  const sale2Id = r.json?.data?.[0]?.sale_id;
  r = await request('POST', '/api/payments', {
    partner_id: supplierId,
    amount: 1500,
    paid_at: today,
    entry_kind: 'receive',
    allocations: [{ sale_id: sale2Id, amount: 1500 }],
  });
  record(
    'S-017',
    r.status === 500 && String(r.json?.message || '').includes('거래처'),
    `status=${r.status} ${r.json?.message}`
  );

  // ----- S-018
  r = await request('POST', `/api/sales/${saleId}/refund`, {
    quantity: 3,
    refunded_at: today,
    reason: 'S-018',
    refund_amount: 0,
  });
  record('S-018', r.status === 201, `status=${r.status}`);

  // ----- S-019
  r = await request('POST', `/api/sales/${saleId}/refund`, {
    quantity: 99999,
    refunded_at: today,
    reason: 'S-019',
    refund_amount: 0,
  });
  record(
    'S-019',
    r.status === 400 && String(r.json?.message || '').includes('환불'),
    `status=${r.status} ${r.json?.message}`
  );

  // ----- S-020
  r = await request('POST', '/api/disposals', {
    product_id: productId,
    quantity: 1,
    disposal_date: today,
    reason: 'S-020',
  });
  record('S-020', r.status === 201, `status=${r.status}`);

  // ----- S-021
  r = await request('POST', '/api/disposals', {
    product_id: productId,
    quantity: 999999999,
    disposal_date: today,
    reason: 'S-021',
  });
  record(
    'S-021',
    r.status === 400,
    `status=${r.status} ${r.json?.message}`
  );

    const failed = rows.filter((x) => !x.ok);
    console.log('\n──────── 요약 ────────');
    console.log(`통과 ${rows.length - failed.length} / ${rows.length}`);
    if (failed.length) {
      console.log('실패:', failed.map((f) => f.id).join(', '));
      exitCode = 1;
      runStatus = 'failed';
    } else {
      console.log('전부 ○ (시나리오 ID 기준)');
      console.log(`테스트 데이터: product_key=SCENARIO-${tag}, memo에 ${tag} 포함`);
    }
  } catch (e) {
    console.error('[scenario] 오류:', e);
    fatalError = e.stack || e.message;
    exitCode = 1;
    runStatus = 'aborted';
  } finally {
    if (pool) await pool.end().catch(() => {});
    finalizeRun(exitCode, runStatus);
    process.exit(exitCode);
  }
}

main().catch((e) => {
  console.error('[scenario] 처리되지 않은 오류:', e);
  if (!runId) initRunHistory(String(Date.now()));
  fatalError = e.stack || e.message;
  try {
    finalizeRun(1, 'aborted');
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
