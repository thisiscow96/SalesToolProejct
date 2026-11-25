// D01 (중·server) 수동 동기화 5분 1회 제한이, 같은 분에 만든 작업 키가 하나라도 겹치면 통째로 건너뛰어짐 → 기간을 넓혀 다시 누르면 새 작업이 더 생김
// 기대: 5분 안 두 번째 요청은 새 작업 0건(429 또는 겹친 날만 ALREADY_QUEUED). 실제: 겹치지 않은 날짜 작업이 새로 생김
// 원인 추정: server/lib/auction/routes.js R-98 — `if (recent.rows[0].t && !dupSet.size)` 조건이 dupSet 이 비어 있을 때만 429
const L = require('../lib.cjs');
(async () => {
  const f = L.fixture(); const pool = L.db(); const q = async (s, p) => (await pool.query(s, p)).rows;
  await q(`UPDATE ext_circuit_state SET state='CLOSED', consecutive_failures=0, next_probe_at=NULL, disabled_reason=NULL`);
  await q(`UPDATE collect_job SET created_at = created_at - interval '1 hour', dedupe_key = LEFT(dedupe_key, 100) || ':old' || id WHERE requested_by_user_id=$1 AND dedupe_key NOT LIKE '%:old%'`, [f.accounts.owner.id]);
  // 분이 바뀌기 직전이면 다음 분까지 기다림(두 요청을 같은 분에)
  while (new Date().getSeconds() > 50) await L.sleep(1000);
  const u = await L.login('owner');
  const add = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
  const r1 = await L.call(u, 'POST', '/auction/sync', { source: 'AT_REALTIME', date_from: add(f.today, -3), date_to: add(f.today, -2), phase: 'FINAL' });
  const r2 = await L.call(u, 'POST', '/auction/sync', { source: 'AT_REALTIME', date_from: add(f.today, -5), date_to: add(f.today, -2), phase: 'FINAL' });
  const r3 = await L.call(u, 'POST', '/auction/sync', { source: 'AT_REALTIME', date_from: add(f.today, -9), date_to: add(f.today, -9), phase: 'FINAL' });
  await q(`UPDATE collect_job SET status='CANCELLED', finished_at=NOW() WHERE status='QUEUED'`);
  await pool.end();
  const q1 = r1.json?.data?.queued?.length || 0, q2 = r2.json?.data?.queued?.length || 0;
  const bug = r2.status !== 429 && q2 > 0;
  process.exit(L.finish('D01', '수동 동기화 5분 1회 제한 — 같은 분 키 겹치면 우회', bug, {
    first: { status: r1.status, queued: q1 }, second_wider_same_minute: { status: r2.status, queued: q2, skipped: r2.json?.data?.skipped }, third_other_date: { status: r3.status, code: r3.json?.code },
    expected: '두 번째 요청 새 작업 0건(429)', actual: bug ? `두 번째 요청이 ${q2}건 새로 넣음` : '기대대로',
  }));
})().catch((e) => { console.error(e); process.exit(2); });
