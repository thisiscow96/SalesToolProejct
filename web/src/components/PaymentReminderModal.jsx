// 미수 입금 안내 보내기 (T-214) — 거래처 원장 모달 위에 겹쳐 뜬다
// - 서버가 만든 기본 문구(미수 합계·경과별·가장 오래된 미결제·입금 계좌)를 미리 보여 주고, 제목·본문을 고쳐서 보낸다
// - 메일 설정이 없으면(mail_ready=false) 보내기 대신 "문구 복사" — 카카오톡·문자에 붙여 넣는다
// - 같은 거래처는 하루 1번만 메일로 보낼 수 있다(복사는 언제든)
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { fetchReminderPreview, recordReminderCopy, sendReminder } from '../lib/reminderApi';
import './PaymentReminderModal.css';

const won = (n) => (n == null ? '-' : Number(n).toLocaleString('ko-KR', { maximumFractionDigits: 2 }));
const RESULT_LABEL = { sent: '보냄', dry_run: '보냄(테스트)', sending: '보내는 중', failed: '실패', copied: '문구 복사' };
const RESULT_CLASS = { sent: 'ok', dry_run: 'ok', sending: 'wait', failed: 'fail', copied: 'copy' };
const BANK_LINE_RE = /^■ 입금 계좌: .*$/m;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function timeText(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 오늘 보낸 시각(HH:MM, 한국 시간) */
function hhmm(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false });
}

/** 클립보드 복사 — https·localhost 가 아니면 navigator.clipboard 가 없을 수 있어 textarea 선택 복사로 대신한다 */
async function copyText(text, fallbackEl) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 아래 방법으로 */
  }
  if (!fallbackEl) return false;
  const prev = fallbackEl.value;
  fallbackEl.value = text;
  fallbackEl.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  fallbackEl.value = prev;
  return ok;
}

export default function PaymentReminderModal({ partner, onClose, onPartnerEmailSaved }) {
  const titleId = useId();
  const uid = titleId.replace(/:/g, '');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState('');
  const [toEmail, setToEmail] = useState('');
  const [saveEmail, setSaveEmail] = useState(true);
  const [bank, setBank] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null); // { kind: 'ok'|'err'|'info', text }
  const [mailReady, setMailReady] = useState(true);
  const copyRef = useRef(null);

  const load = useCallback(() => {
    setLoading(true);
    setLoadErr('');
    fetchReminderPreview(partner.id)
      .then((d) => {
        setData(d);
        setMailReady(d.mail_ready);
        setToEmail(d.partner.email || '');
        setBank(d.bank_text || '');
        setSubject(d.subject);
        setBody(d.body);
      })
      .catch((e) => setLoadErr(e.message))
      .finally(() => setLoading(false));
  }, [partner.id]);

  useEffect(() => {
    load();
  }, [load]);

  // Esc 는 이 창만 닫는다(아래 원장 모달까지 닫히지 않게 캡처 단계에서 멈춤)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const onBank = (e) => {
    const v = e.target.value;
    setBank(v);
    // 본문의 계좌 줄도 같이 바꾼다(사용자가 그 줄을 지웠으면 건드리지 않음)
    setBody((b) => (BANK_LINE_RE.test(b) ? b.replace(BANK_LINE_RE, `■ 입금 계좌: ${v.trim() || '[입금 계좌를 적어 주세요]'}`) : b));
  };

  const resetText = () => {
    if (!data) return;
    setSubject(data.subject);
    setBody(BANK_LINE_RE.test(data.body) ? data.body.replace(BANK_LINE_RE, `■ 입금 계좌: ${bank.trim() || '[입금 계좌를 적어 주세요]'}`) : data.body);
    setMsg(null);
  };

  const fullText = () => `${subject.trim()}\n\n${body.trim()}`;
  const bankMissing = body.includes('[입금 계좌를 적어 주세요]');

  const doCopy = async () => {
    setMsg(null);
    if (!subject.trim() || !body.trim()) {
      setMsg({ kind: 'err', text: '제목과 안내 문구를 입력하세요.' });
      return;
    }
    const ok = await copyText(fullText(), copyRef.current);
    if (!ok) {
      setMsg({ kind: 'err', text: '복사하지 못했습니다. 문구 칸을 길게 눌러 직접 복사해 주세요.' });
      return;
    }
    setMsg({ kind: 'ok', text: '문구를 복사했습니다. 카카오톡·문자 창에 붙여 넣어 보내세요.' });
    recordReminderCopy(partner.id, { subject, body, bank_text: bank })
      .then(() => load())
      .catch(() => {
        /* 기록 실패는 복사에 영향 없음 */
      });
  };

  const doSend = async () => {
    setMsg(null);
    const to = toEmail.trim();
    if (!to) {
      setMsg({ kind: 'err', text: '받는 이메일을 입력하세요.' });
      return;
    }
    if (!EMAIL_RE.test(to)) {
      setMsg({ kind: 'err', text: '이메일 형식이 올바르지 않습니다.' });
      return;
    }
    if (!subject.trim() || !body.trim()) {
      setMsg({ kind: 'err', text: '제목과 안내 문구를 입력하세요.' });
      return;
    }
    const emailChanged = to !== (data.partner.email || '');
    setBusy(true);
    try {
      const r = await sendReminder(partner.id, { to_email: to, subject, body, bank_text: bank, save_email: emailChanged && saveEmail });
      setMsg({ kind: 'ok', text: `${r.to_email} 로 입금 안내를 보냈습니다${r.result === 'dry_run' ? ' (테스트 발송)' : ''}.` });
      if (r.email_saved && onPartnerEmailSaved) onPartnerEmailSaved(r.to_email);
      load();
    } catch (e) {
      if (e.code === 'MAIL_NOT_CONFIGURED') {
        setMailReady(false);
        setMsg({ kind: 'info', text: e.message });
      } else if (e.code === 'DAILY_LIMIT') {
        setMsg({ kind: 'info', text: e.message });
        load();
      } else if (e.code === 'MAIL_FAILED') {
        setMsg({ kind: 'err', text: e.message });
        load();
      } else {
        setMsg({ kind: 'err', text: e.message });
      }
    } finally {
      setBusy(false);
    }
  };

  const rc = data?.receivable;
  const noDue = rc && !(rc.total_due > 0);
  const sentToday = data?.sent_today;
  const emailChanged = data && toEmail.trim() !== (data.partner.email || '') && toEmail.trim() !== '';

  return (
    <div className="main-modal-backdrop reminder-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="main-modal reminder-modal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="main-modal-header">
          <h2 id={titleId}>{partner.name} 입금 안내</h2>
          <p className="reminder-sub">미수 금액·경과·입금 계좌를 메일로 보내거나, 문구를 복사해 카카오톡·문자로 보냅니다.</p>
        </div>
        <div className="main-modal-body">
          {loading && !data ? (
            <p className="main-loading">불러오는 중…</p>
          ) : loadErr ? (
            <div className="main-alert-banner" role="alert">
              {loadErr}
            </div>
          ) : data ? (
            <>
              <dl className="reminder-due" aria-label={`${data.as_of} 기준 미수`}>
                <div className="reminder-due-total">
                  <dt>미수 합계 ({data.as_of} 기준)</dt>
                  <dd>{won(rc.total_due)}원</dd>
                </div>
                <div>
                  <dt>30일 이내</dt>
                  <dd>{won(rc.d0_30)}</dd>
                </div>
                <div>
                  <dt>31–60일</dt>
                  <dd>{won(rc.d31_60)}</dd>
                </div>
                <div>
                  <dt>61–90일</dt>
                  <dd>{won(rc.d61_90)}</dd>
                </div>
                <div className={rc.d91p > 0 ? 'is-old' : ''}>
                  <dt>90일 초과</dt>
                  <dd>{won(rc.d91p)}</dd>
                </div>
              </dl>

              {!mailReady && (
                <div className="reminder-note reminder-note--info" role="status">
                  <strong>메일 설정이 아직 없습니다.</strong> 아래 문구를 <b>복사</b>해 카카오톡·문자로 보내 주세요. (관리자가 메일 발송을 설정하면 여기서 바로 보낼 수 있습니다)
                </div>
              )}
              {noDue && (
                <div className="reminder-note reminder-note--info" role="status">
                  지금 이 거래처의 미수가 없습니다. 보낼 안내가 없습니다.
                </div>
              )}
              {sentToday && (
                <div className="reminder-note reminder-note--done" role="status">
                  오늘 {hhmm(sentToday.created_at)}에 <b>{sentToday.to_email}</b> 로 보냈습니다. 같은 거래처는 하루 1번만 메일로 보낼 수 있습니다(문구 복사는 됩니다).
                </div>
              )}
              {msg && (
                <div className={`reminder-note reminder-note--${msg.kind}`} role={msg.kind === 'err' ? 'alert' : 'status'}>
                  {msg.text}
                </div>
              )}

              <div className="reminder-fields">
                {mailReady && (
                  <label className="reminder-field">
                    <span className="reminder-label">받는 이메일</span>
                    <input
                      type="email"
                      inputMode="email"
                      autoComplete="off"
                      maxLength={255}
                      placeholder={data.partner.email ? '' : '거래처 정보에 이메일이 없습니다 — 여기 입력'}
                      value={toEmail}
                      onChange={(e) => setToEmail(e.target.value)}
                    />
                    {emailChanged && (
                      <span className="reminder-check">
                        <input id={`${uid}-save`} type="checkbox" checked={saveEmail} onChange={(e) => setSaveEmail(e.target.checked)} />
                        <label htmlFor={`${uid}-save`}>이 주소를 거래처 정보에 저장</label>
                      </span>
                    )}
                  </label>
                )}
                <label className="reminder-field">
                  <span className="reminder-label">입금 계좌</span>
                  <input
                    type="text"
                    autoComplete="off"
                    maxLength={300}
                    placeholder="예: ○○은행 123-456-789012 (예금주 홍길동)"
                    aria-describedby={`${uid}-bank-hint`}
                    value={bank}
                    onChange={onBank}
                  />
                  <span id={`${uid}-bank-hint`} className="reminder-hint">
                    한 번 적으면 다음 안내 때 그대로 채워집니다.
                  </span>
                </label>
                <label className="reminder-field">
                  <span className="reminder-label">제목</span>
                  <input type="text" maxLength={200} value={subject} onChange={(e) => setSubject(e.target.value)} />
                </label>
                <label className="reminder-field">
                  <span className="reminder-label reminder-label-row">
                    안내 문구 (미리보기 · 고칠 수 있음)
                    <button type="button" className="reminder-link" onClick={resetText}>
                      기본 문구로
                    </button>
                  </span>
                  <textarea className="reminder-body" rows={11} maxLength={5000} value={body} onChange={(e) => setBody(e.target.value)} />
                </label>
                {bankMissing && <p className="reminder-hint reminder-hint--warn">입금 계좌가 비어 있습니다. 위 칸에 적으면 문구에 들어갑니다.</p>}
              </div>
              <textarea ref={copyRef} className="reminder-copy-buffer" aria-hidden="true" tabIndex={-1} readOnly />

              {data.history.length > 0 && (
                <section className="reminder-history" aria-label="최근 안내 이력">
                  <h3>최근 안내</h3>
                  <ul>
                    {data.history.map((h) => (
                      <li key={h.id}>
                        <span className="reminder-history-time">{timeText(h.created_at)}</span>
                        <span className={`reminder-badge reminder-badge--${RESULT_CLASS[h.result] || 'copy'}`}>{RESULT_LABEL[h.result] || h.result}</span>
                        <span className="reminder-history-to">{h.channel === 'email' ? h.to_email : '카톡·문자용'}</span>
                        <span className="reminder-history-amt">{won(h.amount_due)}원</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </>
          ) : null}
        </div>
        <div className="main-modal-footer reminder-footer">
          <button type="button" className="main-modal-btn secondary" onClick={onClose}>
            닫기
          </button>
          <button type="button" className={`main-modal-btn ${mailReady ? 'secondary' : 'primary'}`} onClick={doCopy} disabled={!data || busy}>
            문구 복사
          </button>
          {mailReady && (
            <button
              type="button"
              className="main-modal-btn primary"
              onClick={doSend}
              disabled={!data || busy || !!sentToday || noDue}
              title={sentToday ? '오늘 이미 보냈습니다' : noDue ? '미수가 없습니다' : undefined}
            >
              {busy ? '보내는 중…' : '메일 보내기'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
