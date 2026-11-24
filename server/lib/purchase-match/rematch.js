'use strict';
/**
 * T-203 자동 재대조(REMATCH 작업) — 그 거래일 FINAL·COMPLETE 수집이 끝나면 워커가 부른다(설계 5장 #3, AC-20 ②)
 *  - 대상: 그 날짜 근처(거래일 −1 ~ +3)의 HOLD·PENDING 줄(전환·취소·매입 아님 줄은 건드리지 않음), 회원마다 한 트랜잭션
 *  - 행위자 SYSTEM. 완전일치 + 전환 가능 + 자동 켬이면 매입전환까지(매입 등록은 회원 주인 권한의 짧은 내부 토큰으로 기존 핸들러를 부른다)
 */
const engine = require('./engine');
const convert = require('./convert');

function createRematch({ app, authorize, pool, signOwnerToken }) {
  return async function rematchForDate({ tradeDate }) {
    const r = await pool.query(
      `SELECT l.user_id, array_agg(l.id ORDER BY l.id) AS ids
         FROM purchase_doc_line l JOIN purchase_doc d ON d.id = l.doc_id
        WHERE l.status IN ('HOLD','PENDING') AND d.status <> 'CANCELLED'
          AND l.trade_date BETWEEN $1::date - 1 AND $1::date + 3
        GROUP BY l.user_id`,
      [tradeDate]
    );
    const out = { users: 0, lines: 0, exact: 0, auto_converted: 0, errors: 0 };
    for (const row of r.rows) {
      // eslint-disable-next-line no-await-in-loop
      const u = await pool.query(`SELECT id, agent_no FROM "user" WHERE id = $1 AND status = 'active'`, [row.user_id]);
      if (!u.rows[0]) continue;
      // eslint-disable-next-line no-await-in-loop
      const client = await pool.connect();
      try {
        // eslint-disable-next-line no-await-in-loop
        await client.query('BEGIN');
        // eslint-disable-next-line no-await-in-loop
        await convert.lockConvert(client, row.user_id);
        const cx = { userId: row.user_id, staffId: null, actorKind: 'SYSTEM', app, authorize, req: { headers: {} },
          authorization: `Bearer ${signOwnerToken(u.rows[0])}` };
        // eslint-disable-next-line no-await-in-loop
        const m = await engine.matchLines(client, cx, { lineIds: row.ids.map(Number), trigger: 'AUTO_AFTER_SYNC', autoConvert: true, statuses: ['HOLD', 'PENDING'], eventType: 'REMATCH' });
        // eslint-disable-next-line no-await-in-loop
        await client.query('COMMIT');
        out.users += 1;
        out.lines += m.lines.length;
        out.exact += m.summary.exact;
        out.auto_converted += m.summary.auto_converted;
      } catch (err) {
        // eslint-disable-next-line no-await-in-loop
        await client.query('ROLLBACK').catch(() => {});
        console.error(`[rematch] user ${row.user_id} ${tradeDate}:`, err.message);
        out.errors += 1;
      } finally {
        client.release();
      }
    }
    return out;
  };
}

module.exports = { createRematch };
