'use strict';
/**
 * T-214 미수 입금 안내 메일 (기능 제안 P19) — 거래처 원장 화면의 "입금 안내 보내기"
 *
 *  GET  /api/partners/:id/reminder        미리보기: 미수 합계·연령, 받는 주소, 기본 문구(제목·본문), 메일 준비 여부, 오늘 보냈는지, 최근 이력
 *  POST /api/partners/:id/reminder        메일 발송 { to_email, subject, body, bank_text?, save_email? }
 *  POST /api/partners/:id/reminder/copy   문구만 복사했다고 기록 { subject, body, bank_text? } — 메일 설정이 없을 때 카톡·문자로 붙여 넣는 경로
 *
 * 규칙
 *  R1. 로그인 필수, 본인 거래처만(남의 거래처는 404). 받을 돈 장부가 있는 유형만(매입처는 400).
 *  R2. 미수(원장·연령과 같은 정의 RECEIVABLE_DUE_CTE)가 0 이면 보낼 것이 없다 — 400 NO_RECEIVABLE.
 *  R3. 메일 설정이 없으면 503 이 아니라 409 MAIL_NOT_CONFIGURED + "메일 설정이 아직 없습니다" + 보낼 문구(data)를 돌려준다.
 *      화면은 미리보기의 mail_ready=false 로 처음부터 복사 경로를 보여 준다.
 *  R4. 같은 거래처는 한국 날짜 하루 1회(메일 성공·보내는 중). 실패·복사는 세지 않는다. 동시 요청은 잠금 + 부분 유일 인덱스(022).
 *  R5. 발송 이력(payment_reminder): 누가·언제·누구에게·금액·결과. 먼저 'sending' 으로 넣고 커밋한 뒤 보내고 결과로 고친다.
 *      서버가 보내는 도중 죽어 'sending' 으로 남은 행은 10분이 지나면 failed 로 바꿔 그날 다시 보낼 수 있게 한다.
 *  R6. 실제 메일은 lib/mailer.js(resend → brevo → smtp). 테스트는 MAIL_DRY_RUN=1(가짜 성공)·fail(가짜 실패).
 *  R7. 금액은 DB NUMERIC 으로 계산하고 응답 직전에만 Number 로 바꾼다. 문구의 금액은 서버가 만든 값.
 */
const { RECEIVABLE_DUE_CTE, RECEIVABLE_PARTNER_TYPES, money } = require('./ledger-routes');
const { recordAudit } = require('./audit-log');

const SUBJECT_MAX = 200;
const BODY_MAX = 5000;
const BANK_MAX = 300;
const EMAIL_MAX = 255;
const STALE_SENDING_MINUTES = 10;
const HISTORY_LIMIT = 10;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAIL_NOT_CONFIGURED_MSG = '메일 설정이 아직 없습니다. 아래 문구를 복사해 카카오톡·문자로 보내 주세요.';

function parseId(raw) {
  const s = String(raw ?? '').trim();
  if (!/^\d{1,10}$/.test(s)) return null;
  const n = Number.parseInt(s, 10);
  return n > 0 && n <= 2147483647 ? n : null;
}

const fmtWon = (n) => `${Number(n).toLocaleString('ko-KR', { maximumFractionDigits: 2 })}원`;
const bad = (res, field, message, code = 'VALIDATION') => res.status(400).json({ ok: false, code, field, message });

/** 이메일 주소 검사 — 빈 값은 '' */
function readEmail(raw) {
  const s = raw == null ? '' : String(raw).trim();
  if (s === '') return { value: '' };
  if (s.length > EMAIL_MAX || !EMAIL_RE.test(s)) return { error: '이메일 형식이 올바르지 않습니다.' };
  return { value: s };
}

/** 제목·본문·계좌 문구 검사 */
function readText(body) {
  const b = body && typeof body === 'object' ? body : {};
  const subject = b.subject == null ? '' : String(b.subject).trim();
  const text = b.body == null ? '' : String(b.body).replace(/\r\n/g, '\n').trim();
  const bank = b.bank_text == null ? '' : String(b.bank_text).trim();
  if (!subject) return { error: ['subject', '제목을 입력하세요.'] };
  if (subject.length > SUBJECT_MAX) return { error: ['subject', `제목은 ${SUBJECT_MAX}자 이하로 입력하세요.`] };
  if (/[\r\n]/.test(subject)) return { error: ['subject', '제목에는 줄바꿈을 넣을 수 없습니다.'] };
  if (!text) return { error: ['body', '안내 문구를 입력하세요.'] };
  if (text.length > BODY_MAX) return { error: ['body', `안내 문구는 ${BODY_MAX.toLocaleString('ko-KR')}자 이하로 입력하세요.`] };
  if (bank.length > BANK_MAX) return { error: ['bank_text', `입금 계좌 안내는 ${BANK_MAX}자 이하로 입력하세요.`] };
  return { subject, text, bank: bank || null };
}

/**
 * 기본 안내 문구. 금액·연령은 서버 값. bank 가 비면 계좌 줄을 "[입금 계좌를 적어 주세요]"로 둔다.
 */
function buildMessage({ partnerName, sender, asOf, due, bank }) {
  const subject = `[입금 안내] ${partnerName} 미결제 금액 ${fmtWon(due.total_due)}`;
  const lines = [
    `${partnerName} 담당자님, 안녕하세요.`,
    `${sender.name || '저희'}입니다. ${asOf} 기준 미결제 금액을 안내드립니다.`,
    '',
    `■ 미결제 합계: ${fmtWon(due.total_due)} (${due.sale_count}건)`,
  ];
  const buckets = [
    ['30일 이내', due.d0_30],
    ['31–60일', due.d31_60],
    ['61–90일', due.d61_90],
    ['90일 초과', due.d91p],
  ].filter(([, v]) => v > 0);
  if (buckets.length) lines.push(`■ 경과별: ${buckets.map(([k, v]) => `${k} ${fmtWon(v)}`).join(' · ')}`);
  if (due.oldest_sale_date) lines.push(`■ 가장 오래된 미결제: ${due.oldest_sale_date} 거래 (${due.oldest_days}일 경과)`);
  lines.push(`■ 입금 계좌: ${bank || '[입금 계좌를 적어 주세요]'}`);
  lines.push('');
  lines.push('확인하시고 입금 부탁드립니다. 이미 입금하셨다면 이 안내는 넘겨 주세요.');
  const contact = [sender.name, sender.phone].filter(Boolean).join(' ');
  if (contact) lines.push(`문의: ${contact}`);
  return { subject, body: lines.join('\n') };
}

function registerPaymentReminderRoutes(app, { pool, getUserId, kstToday, connectOr503, mailer }) {
  const { sendMail, configuredProviders } = mailer;
  const mailReady = () => configuredProviders().length > 0;

  /** 공통: 로그인·거래처 확인. 실패하면 응답을 보내고 null */
  async function loadPartner(req, res) {
    const userId = await getUserId(req);
    if (!userId) {
      res.status(401).json({ ok: false, message: '로그인이 필요합니다.' });
      return null;
    }
    const partnerId = parseId(req.params.id);
    if (!partnerId) {
      bad(res, 'id', '거래처 번호가 올바르지 않습니다.');
      return null;
    }
    const r = await pool.query('SELECT id, name, type, email FROM account WHERE id = $1 AND user_id = $2', [partnerId, userId]);
    const partner = r.rows[0];
    if (!partner) {
      res.status(404).json({ ok: false, code: 'NOT_FOUND', message: '거래처를 찾을 수 없습니다.' });
      return null;
    }
    if (!RECEIVABLE_PARTNER_TYPES.has(partner.type)) {
      bad(res, 'id', '매입처에는 입금 안내를 보내지 않습니다(받을 돈이 없는 거래처).', 'NOT_RECEIVABLE_PARTNER');
      return null;
    }
    return { userId, partner };
  }

  /** 미수 합계·연령(원장·미수 연령과 같은 정의) */
  async function loadDue(db, userId, partnerId, asOf) {
    const r = await db.query(
      `${RECEIVABLE_DUE_CTE}
       SELECT COALESCE(SUM(due), 0)                                        AS total_due,
              COALESCE(SUM(due) FILTER (WHERE days <= 30), 0)              AS d0_30,
              COALESCE(SUM(due) FILTER (WHERE days BETWEEN 31 AND 60), 0)  AS d31_60,
              COALESCE(SUM(due) FILTER (WHERE days BETWEEN 61 AND 90), 0)  AS d61_90,
              COALESCE(SUM(due) FILTER (WHERE days >= 91), 0)              AS d91p,
              COUNT(*)::int                                                AS sale_count,
              to_char(MIN(sale_date), 'YYYY-MM-DD')                        AS oldest_sale_date,
              MAX(days)::int                                               AS oldest_days
       FROM due`,
      [userId, asOf, partnerId]
    );
    const x = r.rows[0];
    return {
      total_due: money(x.total_due),
      d0_30: money(x.d0_30),
      d31_60: money(x.d31_60),
      d61_90: money(x.d61_90),
      d91p: money(x.d91p),
      sale_count: x.sale_count,
      oldest_sale_date: x.oldest_sale_date,
      oldest_days: x.oldest_days,
      _raw_total: x.total_due, // NUMERIC 문자열 그대로 이력에 넣는다
    };
  }

  async function loadSender(userId) {
    const r = await pool.query('SELECT name, phone FROM "user" WHERE id = $1', [userId]);
    return r.rows[0] || {};
  }

  /** 직전에 쓴 입금 계좌 문구(다음 안내의 기본값) */
  async function lastBank(userId) {
    const r = await pool.query(
      `SELECT bank_text FROM payment_reminder WHERE user_id = $1 AND bank_text IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1`,
      [userId]
    );
    return r.rows[0]?.bank_text || '';
  }

  const historyRow = (h) => ({
    id: Number(h.id),
    created_at: h.created_at,
    sent_on: h.sent_on,
    channel: h.channel,
    to_email: h.to_email,
    amount_due: money(h.amount_due),
    result: h.result,
    provider: h.provider,
    error: h.error,
  });

  /** 오래 'sending' 으로 남은 행 정리(R5) */
  async function clearStaleSending(db, userId, partnerId) {
    await db.query(
      `UPDATE payment_reminder SET result = 'failed', error = '발송 결과를 받지 못함(시간 초과)', updated_at = NOW()
        WHERE user_id = $1 AND partner_id = $2 AND result = 'sending'
          AND created_at < NOW() - make_interval(mins => $3)`,
      [userId, partnerId, STALE_SENDING_MINUTES]
    );
  }

  // ---------------- 미리보기 ----------------
  app.get('/api/partners/:id/reminder', async (req, res) => {
    try {
      const ctx = await loadPartner(req, res);
      if (!ctx) return;
      const { userId, partner } = ctx;
      const asOf = kstToday();
      await clearStaleSending(pool, userId, partner.id);
      const [due, sender, bank, hist] = await Promise.all([
        loadDue(pool, userId, partner.id, asOf),
        loadSender(userId),
        lastBank(userId),
        pool.query(
          `SELECT id, created_at, to_char(sent_on, 'YYYY-MM-DD') AS sent_on, channel, to_email, amount_due, result, provider, error
             FROM payment_reminder WHERE user_id = $1 AND partner_id = $2
            ORDER BY created_at DESC, id DESC LIMIT ${HISTORY_LIMIT}`,
          [userId, partner.id]
        ),
      ]);
      const history = hist.rows.map(historyRow);
      const sentToday =
        history.find((h) => h.sent_on === asOf && h.channel === 'email' && ['sending', 'sent', 'dry_run'].includes(h.result)) || null;
      const msg = buildMessage({ partnerName: partner.name, sender, asOf, due, bank });
      delete due._raw_total;
      res.json({
        ok: true,
        data: {
          partner: { id: partner.id, name: partner.name, email: partner.email },
          as_of: asOf,
          receivable: due,
          mail_ready: mailReady(),
          mail_message: mailReady() ? null : MAIL_NOT_CONFIGURED_MSG,
          bank_text: bank,
          subject: msg.subject,
          body: msg.body,
          sent_today: sentToday,
          can_send: !sentToday && due.total_due > 0,
          history,
        },
      });
    } catch (err) {
      console.error('Reminder preview error:', err);
      res.status(500).json({ ok: false, message: '입금 안내 문구를 만들지 못했습니다.' });
    }
  });

  // ---------------- 메일 발송 ----------------
  app.post('/api/partners/:id/reminder', async (req, res) => {
    let ctx;
    try {
      ctx = await loadPartner(req, res);
    } catch (err) {
      console.error('Reminder send error:', err);
      return res.status(500).json({ ok: false, message: '입금 안내를 보내지 못했습니다.' });
    }
    if (!ctx) return;
    const { userId, partner } = ctx;
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const t = readText(b);
    if (t.error) return bad(res, t.error[0], t.error[1]);
    const em = readEmail(b.to_email != null ? b.to_email : partner.email);
    if (em.error) return bad(res, 'to_email', em.error);
    if (!em.value) return bad(res, 'to_email', '받는 이메일을 입력하세요. 거래처 정보에 이메일이 없습니다.');
    const saveEmail = b.save_email === true && em.value !== (partner.email || '');

    // R3 — 메일 설정 없음: 503 대신 안내 + 문구
    if (!mailReady()) {
      return res.status(409).json({
        ok: false,
        code: 'MAIL_NOT_CONFIGURED',
        message: MAIL_NOT_CONFIGURED_MSG,
        data: { subject: t.subject, body: t.text },
      });
    }

    const asOf = kstToday();
    const client = await connectOr503(res);
    if (!client) return;
    let reminderId;
    let due;
    try {
      await client.query('BEGIN');
      // 같은 거래처 동시 발송을 줄 세운다(R4)
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`payment-reminder:${userId}:${partner.id}`]);
      due = await loadDue(client, userId, partner.id, asOf);
      if (!(due.total_due > 0)) {
        await client.query('ROLLBACK');
        return bad(res, 'id', '이 거래처는 지금 미수가 없어 보낼 안내가 없습니다.', 'NO_RECEIVABLE');
      }
      await clearStaleSending(client, userId, partner.id);
      const dup = await client.query(
        `SELECT id, created_at, to_email FROM payment_reminder
          WHERE user_id = $1 AND partner_id = $2 AND sent_on = $3::date
            AND channel = 'email' AND result IN ('sending', 'sent', 'dry_run')
          LIMIT 1`,
        [userId, partner.id, asOf]
      );
      if (dup.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(409).json({
          ok: false,
          code: 'DAILY_LIMIT',
          message: '이 거래처에는 오늘 이미 입금 안내를 보냈습니다. 내일 다시 보낼 수 있습니다(문구 복사는 됩니다).',
          data: { sent_at: dup.rows[0].created_at, to_email: dup.rows[0].to_email },
        });
      }
      const ins = await client.query(
        `INSERT INTO payment_reminder (user_id, partner_id, sent_on, channel, to_email, amount_due, oldest_days, subject, body, bank_text, result)
         VALUES ($1, $2, $3::date, 'email', $4, $5::numeric, $6, $7, $8, $9, 'sending')
         RETURNING id`,
        [userId, partner.id, asOf, em.value, due._raw_total, due.oldest_days, t.subject, t.text, t.bank]
      );
      reminderId = ins.rows[0].id;
      if (saveEmail) {
        const before = { email: partner.email };
        await client.query('UPDATE account SET email = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2', [partner.id, userId, em.value]);
        await recordAudit(client, { userId, entityType: 'account', entityId: partner.id, partnerId: partner.id, action: 'update', before, after: { email: em.value } });
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err.code === '23505') {
        return res.status(409).json({ ok: false, code: 'DAILY_LIMIT', message: '이 거래처에는 오늘 이미 입금 안내를 보냈습니다.' });
      }
      console.error('Reminder send error:', err);
      return res.status(500).json({ ok: false, message: '입금 안내를 보내지 못했습니다.' });
    } finally {
      client.release();
    }

    // 커밋 뒤 실제 발송(잠금을 쥔 채로 외부 API 를 기다리지 않는다)
    let result;
    try {
      result = await sendMail({ to: em.value, subject: t.subject, text: t.text });
    } catch (err) {
      result = { sent: false, errors: [err.message || String(err)] };
    }
    const status = result.sent ? (result.provider === 'dry_run' ? 'dry_run' : 'sent') : 'failed';
    const error = result.sent ? null : (result.errors || []).join(' / ').slice(0, 500) || '발송 실패';
    try {
      await pool.query(
        `UPDATE payment_reminder SET result = $2, provider = $3, error = $4, updated_at = NOW() WHERE id = $1`,
        [reminderId, status, result.provider || null, error]
      );
    } catch (err) {
      console.error('Reminder result update error:', err);
    }
    const data = {
      id: Number(reminderId),
      result: status,
      provider: result.provider || null,
      to_email: em.value,
      amount_due: due.total_due,
      sent_on: asOf,
      email_saved: saveEmail,
    };
    if (!result.sent) {
      // 실패는 하루 1회에 세지 않는다 — 다시 보내거나 문구를 복사할 수 있다
      return res.status(502).json({
        ok: false,
        code: 'MAIL_FAILED',
        message: '메일을 보내지 못했습니다. 잠시 후 다시 보내거나 문구를 복사해 카카오톡·문자로 보내 주세요.',
        data: { ...data, subject: t.subject, body: t.text },
      });
    }
    res.status(201).json({ ok: true, data });
  });

  // ---------------- 문구 복사 기록 ----------------
  app.post('/api/partners/:id/reminder/copy', async (req, res) => {
    try {
      const ctx = await loadPartner(req, res);
      if (!ctx) return;
      const { userId, partner } = ctx;
      const t = readText(req.body);
      if (t.error) return bad(res, t.error[0], t.error[1]);
      const asOf = kstToday();
      const due = await loadDue(pool, userId, partner.id, asOf);
      const r = await pool.query(
        `INSERT INTO payment_reminder (user_id, partner_id, sent_on, channel, to_email, amount_due, oldest_days, subject, body, bank_text, result)
         VALUES ($1, $2, $3::date, 'copy', NULL, $4::numeric, $5, $6, $7, $8, 'copied')
         RETURNING id, created_at`,
        [userId, partner.id, asOf, due._raw_total, due.oldest_days, t.subject, t.text, t.bank]
      );
      res.status(201).json({ ok: true, data: { id: Number(r.rows[0].id), result: 'copied', amount_due: due.total_due, sent_on: asOf } });
    } catch (err) {
      console.error('Reminder copy error:', err);
      res.status(500).json({ ok: false, message: '복사 기록을 남기지 못했습니다.' });
    }
  });
}

module.exports = { registerPaymentReminderRoutes, buildMessage, MAIL_NOT_CONFIGURED_MSG };
